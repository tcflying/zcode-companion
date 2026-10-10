/**
 * API01 chat 映射、驱动器与 SSE 流。
 *
 * 四条硬事实：
 *  1. **没有上游就如实报错，绝不编造。** `createUnavailableDriver()` 是当前唯一
 *     的生产驱动器：`status` 如实是 `not_attached` 或 `no_quota`，`models` 是空数组，
 *     `complete()` 直接抛 `upstream_unavailable`。它**不返回**任何占位模型、
 *     假内容、假 token 或假 usage。真实上游在 I16 换驱动器即可，接口契约不动。
 *  2. **fixture 驱动器是显式标注的假。** 仅测试配置可用，产出的每一段内容都带
 *     `[FIXTURE ...]` 标记，响应头 `x-zcc-fixture: true`、响应体 `zcc.fixture: true`
 *     双重标注，模型 `owned_by` 含 `fixture`。usage 是对**实际产出**按披露方法
 *     （`fixture_whitespace_token_count`）做的真实计数，不是编造的 token 数。
 *  3. **参数不静默丢弃。** 四分法：被本端点**实现**的字段（`model` / `messages` /
 *     `stream` / `max_tokens` + `max_completion_tokens` / `stream_options.include_usage` /
 *     `reasoning_effort`）放行并**真的生效**；OpenAI 定义、但官方协议面**没有对应槽位**
 *     的字段（{@link NOT_FORWARDED_SPECS} 全表）**接受 + 逐类型校验 + 在响应
 *     `zcc.parameters_not_forwarded` 里逐名明示未转发**；OpenAI 定义、本端点
 *     **做不到**且**会改变产出语义**的字段（`stop` / `logprobs` / `response_format` /
 *     `tool_choice:"required"`…）一律 422 并指名；其余未知字段 400。
 *     "接受但明示未生效"优于"硬拒打断真实客户端"——mcode 之类的客户端**默认**就发
 *     `temperature` / `store` / `stream_options` / `max_completion_tokens` /
 *     `reasoning_effort`，硬拒等于让它们全线不可用（工单 COMPAT1/C2、C3）。
 *     **COMPAT2 把它一次做全**：真实客户端字段集从已安装源码挖全（见本文件
 *     {@link NOT_FORWARDED_SPECS} 与 {@link TOP_LEVEL_REJECTED} 的逐条出处注释），
 *     不再"撞一个补一个"。分界线是**如实披露能力**，不是字段新老：
 *     - 能被 `zcc.parameters_not_forwarded` 完整披露的 → A 类（接受）；
 *     - 披露了也等于骗用户的（截断、多候选、结构化输出、logprobs…）→ C 类（拒）。
 *  3a. **工具声明被接受，但被明说没转发**（COMPAT4 裁定）。这是四分法之外唯一
 *     需要单独说清的一类：`tools` **非空**也接受（逐项**浅校验**），
 *     `tool_choice` 的 `none` / `auto` 也接受——它们要的都不是"必须调工具"，
 *     而本端点**永不发** `tool_calls`，那两条路线实际落到的下界就是"不调用"。
 *     代价是必须把这件事变成**可机读事实**而不是一句文档说明，所以响应恒定披露
 *     三个键：`zcc.tools_received`（收到几条）、`zcc.tools_forwarded`（**恒为 0**）、
 *     `zcc.tool_choice_received`（客户端实际发的那个值）。
 *     "接受的是声明、不是能力"由**结构**保证：驱动器契约 {@link DriverRequest} 上
 *     **根本没有**工具槽位（契约测试用静态钉证明），所以"转发"无处发生。
 *     仍然拒的只有**要求必须调工具**的那一类（`required` / 旧名 `any` / 具名指定
 *     形式，见 {@link REQUIRED_TOOL_CHOICES}）：那要让客户端等一个**永远不会来的**
 *     `tool_calls`，比直接拒更糟。逐条规则见 {@link parseToolDeclarations}。
 *  3b. **`metadata` / `user` 早就在被静默丢弃**（COMPAT2 补上披露）：它们
 *     {@link TOP_LEVEL_ACCEPTED} 里、也解析了，但驱动器侧**从来没有对应槽位**，
 *     而此前 `zcc.parameters_not_forwarded` 只列了 `temperature` / `top_p`。
 *     披露表推广成通用机制后，这两个键**恒在场**被披露。
 *  4. **role 有四条互不越界的处置（COMPAT3 建立、COMPAT5 再收敛一条）。**
 *     - `user` / `assistant` = 对话轮，原样透传给驱动器；
 *     - `system` / `developer` = 客户端的**指令载体**，被 {@link foldMessagesToPrompt}
 *       **折叠**进 prompt 上下文（与既有多轮折叠**同一条机制**、**同一种行格式**），
 *       并在响应 `zcc.roles_folded` 里**逐名披露**折叠了哪些角色——"接受 + 折叠 +
 *       如实披露"而不是"拒掉真客户端"或"压成 user 却不吭声"；
 *     - `tool`（**COMPAT5 起**）= 历史里的**工具结果轮**，被**接受并转写**成
 *       `user` + {@link TOOL_RESULT_CONTENT_PREFIX} 前缀；同轮的
 *       {@link MESSAGE_TOOL_TRACE_FIELDS} 一并**剥离**。改写**在文本里可见**，
 *       消息**不删**、条数与顺序不变（见 {@link parseMessage}）；
 *     - `function` / 其它一切仍 422 `unsupported_role` 并指名 `messages[i].role`：
 *       旧式 `functions` / `function_call` 与 {@link TOP_LEVEL_REJECTED} 里那批
 *       同族键是**同一套参数面**，消息侧放行就与逐条钉死的顶层 422 自相矛盾。
 *     折叠**保持原始顺序**（不把末尾的 system 轮偷偷提到前面）：顺序即语义，提序也是一种
 *     静默改写。客户端按 OpenAI 惯例把指令轮放在开头，折叠后它自然就是 prompt 前缀上下文。
 *  5. **"是不是真实模型"由驱动器能力推导，不硬编码。** `deriveModelIsReal()` 是
 *     唯一口径：fixture → false、无驱动器 → false（且不列任何模型）、真实驱动器
 *     （`ready` + 非 fixture + 确实列出了模型）→ true。目录同理：无上游是
 *     `{revision:'none', models:[]}`，绝不列占位条目。
 */
import { ApiError } from './errors.js';
import { METADATA_MAX_BYTES, canonicalRequestHash } from './auth.js';

/** SSE 单帧上限 2 MiB / 单次流累计上限 4 MiB（NDJSON 口径沿用到 SSE 传输）。 */
export const SSE_FRAME_MAX_BYTES = 2 * 1024 * 1024;
export const STREAM_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

export const FIXTURE_MODEL_ID = 'zcc-fixture-1';
export const FIXTURE_DRIVER_NAME = 'fixture';

/**
 * 本端点**接受**的 role。
 *
 * **COMPAT3 更正**：此前只有 `user | assistant`，`system` / `developer` 一律 422。
 * 那不是"分类没做完"，而是**撞上了真客户端**：mcode 的请求体组装
 * （`chunk-HVP63X6W.js` 的 `ke()`，见 {@link MCODE_FIELD_SOURCES}）逐字是
 * `e.reasoning && t.supportsDeveloperRole ? "developer" : "system"`——**只要客户端
 * 配了系统提示词就必然命中**（本机 `reasoning:true` + 缺省 `supportsDeveloperRole:true`
 * ⇒ 恒发 `developer`）。同理 mcode 的 reasoning 配置把 `developer` 当**系统提示载体**用，
 * 拒它 = 端到端最后一堵墙。
 *
 * 协调者 2026-10-02 裁定：接受并**折叠**（见 {@link FOLDED_PROMPT_ROLES} 与
 * {@link foldMessagesToPrompt}），同时**如实披露**（响应 `zcc.roles_folded`）。
 */
export const SUPPORTED_ROLES = ['system', 'developer', 'user', 'assistant'] as const;
export type SupportedRole = (typeof SUPPORTED_ROLES)[number];

/**
 * 这两个 role **不是对话轮**，而是客户端的**指令载体**（系统提示词 / 开发者指令）。
 *
 * 它们被 {@link foldMessagesToPrompt} 折叠进 prompt 上下文，响应 `zcc.roles_folded`
 * 按**首次出现序、去重**逐名披露。没有工具轮、没有具名消息，所以除了"折叠成带 role 标签
 * 的 prompt 行"之外没有别的通道可走——**这条折叠本身就是披露出来的**，不是静默降级。
 *
 * **披露的边界（别把它读大了）**：`roles_folded` 只说"**折叠了哪些 role**"。
 * 它**不**宣称折叠后的内容与官方 agent **自己**的系统提示同优先级——官方 app-server
 * 另有一套自己的系统提示，我们的 system/developer 行是**用户轮文本里的指令**，
 * 真实指令优先级由官方 agent 决定。想把这件事说得更准，需要官方协议面**真的有**那个槽位
 * （已核实 `session/create` 的 `nGt` 是 `.strict()` 且逐字没有，见
 * {@link ChatDriver.enforcesMaxTokens} 的出处注释）。
 */
export const FOLDED_PROMPT_ROLES = ['system', 'developer'] as const;
export type FoldedPromptRole = (typeof FOLDED_PROMPT_ROLES)[number];

/**
 * 整段对话 → **一条** prompt 的**唯一**折叠实现（COMPAT3）。
 *
 * 与多轮折叠**逐字同一条机制、同一行格式**：`${role}: ${content}`，换行连接。
 * `system` / `developer` 走的是**同一个函数**，不另开一条"系统通道"（官方协议面
 * `session/create` 逐字没有那个槽位，见 {@link ChatDriver.enforcesMaxTokens} 的出处注释），
 * 因此"指令轮"与"对话轮"在 prompt 里**可区分**（行首 role 标签不同），而顺序**原样保留**。
 *
 * 两个驱动器（fixture 与 official-host）都调用这一个函数：折叠格式因此是**唯一**的，
 * 契约测试可以直接对它做逐字断言，而不是"各自实现一遍、祈祷它们一致"。
 *
 * @param messages 已规范化的消息（role 必在 {@link SUPPORTED_ROLES} 内）
 * @returns 折叠后的 prompt（空数组 → 空串）
 */
export function foldMessagesToPrompt(messages: readonly ParsedMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/**
 * 这次请求里**被折叠**的指令 role（COMPAT3），按首次出现序去重。
 *
 * 披露的**唯一**目的：让客户端知道"你的系统提示词被并进了 prompt 上下文"，
 * 而不是靠猜 `role` 标签为什么出现在产出里。恒在场（可能是空数组），
 * 口径与 `zcc.parameters_not_forwarded` 一致。
 *
 * @param messages 已规范化的消息
 * @returns 折叠过的 role 名，**无重复**、按首次出现排序
 */
export function collectFoldedPromptRoles(messages: readonly ParsedMessage[]): readonly FoldedPromptRole[] {
  const out: FoldedPromptRole[] = [];
  for (const message of messages) {
    const role = message.role;
    if ((FOLDED_PROMPT_ROLES as readonly string[]).includes(role) && !out.includes(role as FoldedPromptRole)) {
      out.push(role as FoldedPromptRole);
    }
  }
  return out;
}

const MAX_MODEL_ID_CHARS = 200;
const MAX_MESSAGES = 256;
const MAX_CONTENT_CHARS = 100_000;
const MAX_METADATA_KEYS = 16;
const MAX_USER_CHARS = 128;
const MAX_MAX_TOKENS = 32_768;

export interface ParsedMessage {
  readonly role: SupportedRole;
  readonly content: string;
}

/** 客户端发上限时用的**键名**。两个键是同一件事的两个名字，见 {@link parseMaxTokens}。 */
export type MaxTokensSource = 'max_tokens' | 'max_completion_tokens';

export interface ParsedChatRequest {
  readonly model: string;
  readonly messages: readonly ParsedMessage[];
  readonly stream: boolean;
  readonly includeUsage: boolean;
  readonly maxTokens: number | null;
  /**
   * 客户端**用哪个键**发的上限（COMPAT2）。`null` = 两个键都没发。
   *
   * 之所以要记住**键名**而不只是数值：上限能不能生效是**驱动器能力**决定的
   * （见 {@link ChatDriver.enforcesMaxTokens}），生效不了时必须按客户端**实际发来的那个
   * 键名**披露——客户端发 `max_completion_tokens` 就得在
   * `zcc.parameters_not_forwarded` 里看到 `max_completion_tokens`，看到 `max_tokens`
   * 等于告诉它一件与它无关的事。
   */
  readonly maxTokensSource: MaxTokensSource | null;
  /**
   * 上限超额被**钳到** {@link MAX_MAX_TOKENS} 时，客户端原本发的值；未钳制为 `null`。
   * 披露经 `zcc.max_tokens_clamped_from` / `zcc.max_tokens_clamped_to`（见
   * {@link maxTokensClampDisclosure}）：钳制是"替客户端缩小预算"的动作，
   * 不披露就是静默改参。
   */
  readonly maxTokensClampedFrom: number | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>> | null;
  readonly user: string | null;
  /**
   * `reasoning_effort` 的解析结果。`null` = 客户端没发 → 驱动器用自己的缺省档位
   * （official-host 的 `CreateOfficialHostDriverOptions.reasoning`）。
   * 非 `null` 时**一定**是 {@link REASONING_EFFORT_LEVELS} 闭集里的一个。
   */
  readonly reasoning: string | null;
  /**
   * 客户端发了、我们**校验通过但没有转发**的参数名（工单 COMPAT1/C3 建立，
   * COMPAT2 推广成通用机制）。
   *
   * 原样进响应 `zcc.parameters_not_forwarded`，让"接受但未生效"成为一条
   * **可观测事实**而不是一次静默丢弃。**恒在场**（可能是 `[]`），
   * 所以客户端不读文档也知道去哪儿看。
   *
   * 覆盖三条来源，输出序固定（先 {@link NOT_FORWARDED_SPECS} 键序，
   * 再 {@link ACCEPTED_NOT_FORWARDED_BUILTINS} 键序，最后
   * `stream_options.include_obfuscation`）：
   *  1. {@link NOT_FORWARDED_SPECS} 全表；
   *  2. `metadata` / `user`（接受、解析，但驱动器侧没有槽位）；
   *  3. `stream_options.include_obfuscation`（我们从不做响应混淆）。
   */
  readonly parametersNotForwarded: readonly string[];
  /**
   * 本次请求里**被折叠**进 prompt 上下文的指令 role（COMPAT3）。
   *
   * 原样进响应 `zcc.roles_folded`，**恒在场**（无折叠时是 `[]`）——口径与
   * {@link parametersNotForwarded} 一致：让"你的系统提示词被并进了 prompt 上下文"
   * 成为一条可观测事实，而不是客户端对着产出里的 `developer:` 标签去猜。
   * 顺序 = 首次出现序、去重（见 {@link collectFoldedPromptRoles}）。
   */
  readonly rolesFolded: readonly FoldedPromptRole[];
  /**
   * 客户端这次发来的**工具声明条数**（COMPAT4）。
   *
   * 缺席 / `null` / `[]` 都是 `0`。原样进响应 `zcc.tools_received`，
   * 与恒为 {@link TOOLS_FORWARDED_NONE} 的 `zcc.tools_forwarded` 配对，
   * 合成一句完整的话："你声明了 N 个工具，**一个都没有转发**，本端点是纯对话形态"。
   *
   * 这两个键**恒在场**（`tools_received` 可能就是 `0`），口径与
   * {@link parametersNotForwarded} / {@link rolesFolded} 一致。
   */
  readonly toolsReceived: number;
  /**
   * 客户端实际发的 `tool_choice`（COMPAT4）。`null` = 没发 / 发了 `null`。
   *
   * 原样进响应 `zcc.tool_choice_received`：**披露的是客户端发了什么**，
   * 不是我们替它挑的一档（`reasoning_effort_applied` 那个键报的是"实际采用的档位"，
   * 两者口径不同、不可混用：这里永远没有"采用"这个动作发生）。
   * 非 `null` 时一定是 {@link ACCEPTED_TOOL_CHOICES} 闭集里的一个。
   */
  readonly toolChoiceReceived: AcceptedToolChoice | null;
}

export const TOP_LEVEL_ACCEPTED = [
  'model',
  'messages',
  'stream',
  'max_tokens',
  'max_completion_tokens',
  'stream_options',
  'reasoning_effort',
  'temperature',
  'top_p',
  'store',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'service_tier',
  'verbosity',
  'prompt_cache_key',
  'prompt_cache_retention',
  'safety_identifier',
  'n',
  'metadata',
  'user',
  // **COMPAT3**：`tools` / `tool_choice` 进接受表。**COMPAT4** 放宽到"非空合法形状"：
  // 工具**声明**被接受（浅校验）后**明示未转发**（`zcc.tools_received` /
  // `zcc.tools_forwarded` / `zcc.tool_choice_received`），而"**要求必须调工具**"
  // 仍然 422。逐条规则见 {@link parseToolDeclarations}。
  'tools',
  'tool_choice'
] as const;

/**
 * 工单 COMPAT1/C2：`reasoning_effort` 的**闭集**合法值。
 *
 * 取值逐字等于官方 GLM-5.3 系列的 `config.optionSpecs.reasoningLevel.values`
 * （官方 builtin config 里那条 `modelMatch: ".*glm-5\.3(?:-flash)?(?:[.\-:/\[].*)?"`
 * 的 `values` 恰是 `["low","high","max"]`），也就是本仓
 * `packages/official-host/src/host-driver.ts` 的 `REASONING_TO_THOUGHT_LEVEL` 的键集合。
 *
 * **OpenAI 的 `medium` / `minimal` 不在其中**，那是**官方会拒**的值
 * （官方 `bpe` 逐字 `o.values.includes(n) ? {ok:!0} : {ok:!1, code:"reasoning-level-not-supported"}`）。
 * 我们提前在 API 层 422 并列出合法值，好过让请求一路走到官方再失败。
 *
 * 契约测试逐条断言"本闭集与 `KNOWN_REASONING_LEVELS` **逐字相等**"，所以两处
 * 漂移会立刻变红。
 */
export const REASONING_EFFORT_LEVELS = ['low', 'high', 'max'] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

/**
 * 工单 COMPAT2：A 类参数**逐条**的合法值域。
 *
 * A 类 = **接受 + 逐类型校验 + 在 `zcc.parameters_not_forwarded` 里逐名披露"未转发"**。
 * 收录标准只有一条：**披露得完整**。收下、校验、并如实说出来的东西，不会让用户误以为
 * 参数生效了；披露不了的东西（C 类）才必须硬拒。
 *
 * ## 每个键为什么在这张表里（出处逐条可查）
 *
 * `mcode@0.5.6`（本机全局 npm 安装）的 BYOK `openai-completions` 通道，请求体由
 * **`chunks/chunk-HVP63X6W.js` 的 `ce()`** 组装（证据见 {@link MCODE_FIELD_SOURCES}）。
 * 那一段里逐字出现的赋值就是本表的来源；本机 mcode 配置
 * （`~/.minimax/config.yaml` 的 `custom_provider.zcc-companion`，`api: openai-completions`）
 * **没有** `compat` 覆写，所以走 `ce()` 所在 chunk 的 `_e()` 缺省能力表。
 *
 * - `temperature`（`ce()` off 7054）/ `top_p`（**不**由 `ce()` 发出，OpenAI 官方字段）
 *   —— COMPAT1/C3 已收，值域逐字取 OpenAI 官方文档。
 * - `store`（`ce()` off 6889：`s.supportsStore&&(o.store=!1)`）——**真客户端必发**。
 *   协调者 2026-10-02 实弹 `mcode exec` 撞的就是它（`422 字段 store 本端点不实现`）。
 *   `_e()` 的缺省 `supportsStore:!T`（off 15418）对自定义 baseURL 恒为 `true`，
 *   所以**每一个** BYOK 自定义 provider 请求都带 `store:false`。
 *   我们**从不持久化**对话 → `store:false` 与我们的实际行为**逐字相符**（不是妥协）。
 * - `seed` / `presence_penalty` / `frequency_penalty` —— 采样旋钮，官方协议面无槽位。
 *   值域取 OpenAI 官方文档：两个惩罚系数 `[-2.0, 2.0]`；`seed` 官方只写 `number`、
 *   没给区间，本表取**整数** `[0, 2^31-1]` 并把这个自定边界写进错误消息。
 * - `service_tier` —— 闭集逐字取 OpenAI 官方：`auto` / `default` / `flex` / `scale` /
 *   `priority` / `fast`。我们只有一档、不分流，所以**任何**取值都只能"收到但没生效"；
 *   闭集外仍 422。
 * - `verbosity` —— 闭集逐字取 OpenAI 官方：`low` / `medium` / `high`（缺省 `medium`）。
 * - `prompt_cache_key` —— OpenAI 官方提示缓存作用域键（≤64 字符）。
 *   mcode 也会发（`ce()` off 6606），但只对 `api.openai.com` 或
 *   `PI_CACHE_RETENTION=long` 才发，所以对本机 8790 **默认不发**。
 *   我们没有任何提示缓存可键 → 披露。
 * - `prompt_cache_retention` —— 闭集逐字取 OpenAI 官方（已标 deprecated）：
 *   `in_memory` / `24h`。mcode 在 `PI_CACHE_RETENTION=long` 时逐字发 `"24h"`
 *   （`ce()` off 6737）。
 * - `safety_identifier` —— OpenAI 官方，文档逐字说它**取代** `user`。≤64 字符。
 *
 * ## 为什么 `prompt_cache_options` **不**在这张表里
 * 它的官方内层形状是 `{mode: implicit|explicit, ttl: "30m"}`（已核实），但 OpenAI
 * 自己还在长（`ttl` 迟早不止一个取值）。收下它就得**猜**一个会漂移的闭集，而
 * "本端点根本没有提示缓存可配置"这件事用 422 说清楚更诚实 → 进 {@link TOP_LEVEL_REJECTED}。
 */
export type NotForwardedSpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'string'; readonly maxChars: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

/**
 * A 类全表。**键序即 `zcc.parameters_not_forwarded` 的输出序**（稳定），
 * 所以 `temperature` 排在 `top_p` 之前这条（COMPAT1/C3 钉死的）保持不变。
 */
export const NOT_FORWARDED_SPECS: Readonly<Record<string, NotForwardedSpec>> = Object.freeze({
  temperature: Object.freeze({ kind: 'number', min: 0, max: 2 }),
  top_p: Object.freeze({ kind: 'number', min: 0, max: 1 }),
  store: Object.freeze({ kind: 'boolean' }),
  seed: Object.freeze({ kind: 'integer', min: 0, max: 2_147_483_647 }),
  presence_penalty: Object.freeze({ kind: 'number', min: -2, max: 2 }),
  frequency_penalty: Object.freeze({ kind: 'number', min: -2, max: 2 }),
  service_tier: Object.freeze({ kind: 'enum', values: Object.freeze(['auto', 'default', 'flex', 'scale', 'priority', 'fast']) }),
  verbosity: Object.freeze({ kind: 'enum', values: Object.freeze(['low', 'medium', 'high']) }),
  prompt_cache_key: Object.freeze({ kind: 'string', maxChars: 64 }),
  prompt_cache_retention: Object.freeze({ kind: 'enum', values: Object.freeze(['in_memory', '24h']) }),
  safety_identifier: Object.freeze({ kind: 'string', maxChars: 64 })
} as const);

/**
 * 同样"接受但未转发"、但**不走 {@link NOT_FORWARDED_SPECS}** 的两个内置键。
 *
 * `metadata` 与 `user` 早就在 {@link TOP_LEVEL_ACCEPTED} 里、也早就在解析，
 * 但驱动器侧**从来没有**对应槽位（`DriverRequest` 上没有这两个字段），
 * 而 COMPAT1/C3 的披露表只列了 `temperature` / `top_p` —— 于是它们**一直在被静默丢弃**。
 * COMPAT2 把披露推广成通用机制，这两个键**恒在场**被披露。
 *
 * 判定与 A 类表一致：**键存在且不是 `null`** 就算"客户端发了"。`null` 在 OpenAI 形状里
 * 就是"没这个偏好"，披露它反而是噪声。
 */
export const ACCEPTED_NOT_FORWARDED_BUILTINS = ['metadata', 'user'] as const;

/**
 * `tool_choice` 在"**我们不会调用工具**"这件事上**可接受**的闭集（COMPAT4）。
 *
 * 裁定依据（协调者 2026-10-02）：这两个取值要的都不是"必须调工具"，
 * 而是"模型自己决定调不调" / "别调工具"。本端点**永不发** `tool_calls`
 * （驱动器契约上根本没有工具槽位，见 {@link DriverRequest}），所以这两条
 * 路线**实际落到的下界就是"不调用"**——接受它们是如实的 no-op，不是妥协。
 * 收下它们的同时必须**明示未生效**：响应 `zcc.tool_choice_received` 逐名披露
 * 客户端实际发的那个值。
 *
 * 闭集**逐字**等于 OpenAI 官方的 `none | auto` 两项（`required` 与具名对象形式
 * 归 {@link REQUIRED_TOOL_CHOICES}，仍然拒）。
 */
export const ACCEPTED_TOOL_CHOICES = ['none', 'auto'] as const;
export type AcceptedToolChoice = (typeof ACCEPTED_TOOL_CHOICES)[number];

/**
 * `tool_choice` **仍然拒**的形状：**要求必须调用工具**（`required` 及其旧名 `any`）
 * 与**具名指定**形式（`{ type: 'function', function: { name: … } }`）。
 *
 * 为什么它们不在 {@link ACCEPTED_TOOL_CHOICES} 里：这两类要的是
 * "**这一轮一定产生一个工具调用**"。本端点做不到——驱动器契约上**没有**工具槽位
 * （{@link DriverRequest}），官方 `session/send` 也只收一条 `content` 文本。
 * 收下再忽略会让客户端等一个**永远不会来的** `tool_calls`，比直接拒更糟，
 * 所以**如实 422**。披露救不回来：披露只会让用户知道"它没生效"，
 * 而它要的是"它生效"。
 */
export const REQUIRED_TOOL_CHOICES = ['required', 'any'] as const;
export type RequiredToolChoice = (typeof REQUIRED_TOOL_CHOICES)[number];

/**
 * 本端点**转发**的工具声明条数，**恒为 0**（COMPAT4）。
 *
 * 这不是"当前策略是 0"这种可调值，而是**结构事实**：驱动器请求里没有工具槽位
 * （{@link DriverRequest}），官方协议面也没有对应字段，所以"转发"无处发生。
 * 暴露成常量是为了让契约测试能**逐字**钉住它——日后有人要改成"按需转发"，
 * 一定先撞红，而不是悄悄把披露值改成 1 而实际并没有转发。
 */
export const TOOLS_FORWARDED_NONE = 0;

/**
 * 一条工具声明的**浅校验**深度（COMPAT4 裁定）："是对象，且**自有** `function`
 * 或 `type` 字段"——就这一层，**不深验**。
 *
 * 明确**不**查的东西（深验 = 我们替客户端实现工具协议 = 我们在撒谎）：
 * `type` 的取值是不是 `function`、`function` 是不是对象、`function.name` 在不在、
 * `parameters` 是不是合法 JSON Schema。浅校验的职责只有一条：
 * **挡住"这根本不是一个 OpenAI 工具声明"的畸形输入**（`{}` / `null` / 字符串 /
 * 数字 / 数组），好让错误信息指向具体的下标，而不是把垃圾带进披露计数。
 *
 * 为什么用**自有**字段（`Object.hasOwn`）而不是 `in`：原型链上的 `function`
 * 对 JSON 解析出来的请求**不可能**出现（JSON 只产自有属性），用 `in` 只是
 * 让 `{ hasOwnProperty }` 之类的手工构造对象混过校验，白白放松判据。
 */
export function isShallowToolDeclaration(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return Object.prototype.hasOwnProperty.call(value, 'function') || Object.prototype.hasOwnProperty.call(value, 'type');
}


/**
 * OpenAI 定义、但本端点**做不到**的字段。收下它们再忽略 = 静默改变用户请求，
 * 因此一律 422 并指名，让客户端明确知道这个参数没有被采纳。
 *
 * **2026-10-02（COMPAT1）移出三条**：`reasoning_effort`（实现）、
 * `temperature` / `top_p`（接受 + 披露）。
 * **2026-10-02（COMPAT2）再移出七条**：`store` / `seed` / `presence_penalty` /
 * `frequency_penalty` / `service_tier` 进 {@link NOT_FORWARDED_SPECS}；
 * `n` 走"**只接受 1**"那条专用规则（见 {@link parseChoiceCount}）。
 * 依据：真客户端（mcode）**默认就发** `store` / `stream_options` /
 * `max_completion_tokens` / `reasoning_effort`，硬拒等于让它们全线不可用；
 * 而这一批剩下的每一个都会**改变产出语义**，披露也救不回来——用户会以为
 * `stop` / `logprobs` 生效了，所以继续硬拒。
 *
 * **2026-10-02（COMPAT3）移出两条**：`tools` / `tool_choice` 进
 * {@link TOP_LEVEL_ACCEPTED}，但**只在"没有工具"这一个形状上**被接受
 * （`tools: []` / `tool_choice:"none"` 或缺省，见 {@link parseToolDeclarations}）。
 * 移出的理由**不是**"我们能做工具调用"，而是**空形状与我们的实际行为逐字相符**：
 * 客户端要"没有工具"，我们确实一个工具都不提供。**非空 `tools` 与 `tool_choice`
 * 的其它取值仍 422**（语义改变，披露也救不回来）。
 * `parallel_tool_calls` **留在本表**：它是 `tools` 的从属开关，单独接受它等于宣称
 * "支持并行工具调用开关但不支持工具调用"；且真客户端**不发**它（它不在
 * {@link MCODE_FIELD_SOURCES} 里）。
 *
 * **2026-10-02（COMPAT4）裁定（改前那句拒绝理由的**替代依据**）**：上两段里
 * "非空 `tools` 仍 422 / `auto` 仍 422"这条**依据已被推翻并改写**——理由不是
 * "披露救不回来"，而是：
 *  - **实弹证据**：mcode 的 `tool_call:false` **不阻止**它发送工具声明
 *    （`ce()` off 7110 那条分支与调用方配置无关），协调者端到端实测被一个
 *    **26 项**的非空数组整条 422 挡住。硬拒真客户端 = 端到端不可用，
 *    这与 COMPAT1/C2 移出 `store` / `max_completion_tokens` 的理由是**同一条**；
 *  - **"披露救不回来"这句话本身就是错的**：它只对"**要求必须调工具**"成立
 *    （`required` / 具名指定，见 {@link REQUIRED_TOOL_CHOICES}），对
 *    "**声明了一批工具**"不成立——声明不改变本端点的任何行为，而我们可以把
 *    "收到了 N 条、**一条都没转发**、本端点是纯对话形态"逐字写进响应的
 *    `zcc.tools_received` / `zcc.tools_forwarded`；
 *  - **底线不动**：驱动器契约上仍**没有**工具槽位（{@link DriverRequest}），
 *    产出里**永远**不含 `tool_calls`，`zcc.tools_forwarded` 恒为
 *    {@link TOOLS_FORWARDED_NONE}。接受的是**声明**，不是能力。
 * `parallel_tool_calls` **仍留在本表**：本轮工单**未裁定**它，且理由未变
 * （宣称"支持并行工具调用开关但不支持工具调用"仍然自相矛盾；真客户端也不发它）。
 * 若日后裁定放宽，判据应与 `tools` 同族：**只接受"与实际行为相符"的那一档**。
 */
export const TOP_LEVEL_REJECTED: Readonly<Record<string, string>> = {
  stop: '本端点不实现 stop 序列（收下但忽略 = 静默丢掉截断语义）',
  logprobs: '本端点不返回 logprobs',
  top_logprobs: '本端点不返回 logprobs',
  logit_bias: '本端点不实现 logit_bias',
  response_format: '本端点不实现结构化输出',
  parallel_tool_calls: '本端点不实现工具调用',
  functions: '本端点不实现函数调用',
  function_call: '本端点不实现函数调用',
  modalities: '本端点只输出文本',
  prediction: '本端点不实现预测续写',
  audio: '本端点不实现音频',
  web_search_options: '本端点不实现内置联网检索',
  prompt_cache_options: '本端点没有提示缓存可配置',
  moderation: '本端点不做按请求的输出审核旋钮'
};

/**
 * 真实客户端（`mcode@0.5.6`）请求体字段的**逐条出处**。
 *
 * 挖取路径（本机已安装源码，`@minimax-ai/code@0.5.6`）：
 * `chunks/openai-completions-HCLBIIWV.js` 逐字 re-export
 * `chunks/chunk-HVP63X6W.js` 的 `{a,b,c}`；`chunk-TJQSYP6F.js` off 2813500 附近的
 * 分发表把 `api:"openai-completions"` 逐字接到那两个函数上
 * （`streamOpenAICompletions` / `streamSimpleOpenAICompletions`）。
 * 请求体由该 chunk 的 `ce()` 组装；`openai` SDK 侧
 * （`chunks/chunk-IIHJNKC3.js` off 50263 的
 * `create(e,t){return this._client.post("/chat/completions",{body:e,...})}` 与
 * off 103237 的 `buildBody`）**只把 body 原样 JSON.stringify，一个字段都不注入**。
 * 所以下表 = 客户端实际发出的字段全集。
 *
 * 导出这张表是为了让"字段从哪来"这件事**在代码里可查**，而不是只活在工单报告里。
 * 任何一条出处变了，这张表的注释就该跟着改。
 */
export const MCODE_FIELD_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  model: 'chunk-HVP63X6W.js ce() off 6571（恒发）',
  messages: 'chunk-HVP63X6W.js ce() off 6571 + ke() off 10180（恒发）。**role 由 ke() 逐字决定**：`ke()` off 10416 `e.reasoning&&t.supportsDeveloperRole?"developer":"system"`（`supportsDeveloperRole` 缺省 true，off 15435）→ 本机 `reasoning:true` 恒发 `developer`；system 提示词是 mcode reasoning 配置的载体',
  stream: 'chunk-HVP63X6W.js ce() off 6571 逐字 `stream:!0`（恒发，本通道恒为流式）',
  stream_options: 'chunk-HVP63X6W.js ce() off 6852 `o.stream_options={include_usage:!0}`（`supportsUsageInStreaming` 缺省恒 true，off 15536）',
  store: 'chunk-HVP63X6W.js ce() off 6889 `s.supportsStore&&(o.store=!1)`；`supportsStore:!T` off 15418 对自定义 baseURL 恒 true → **恒发**',
  max_completion_tokens: 'chunk-HVP63X6W.js ce() off 6934 `maxTokensField` 缺省 `"max_completion_tokens"`（off 15564）；maxTokens 由 chunk-OS45FJAT.js off 7270362 `maxTokens:r` 传入，缺省 16384（off 7256605）',
  max_tokens: 'chunk-HVP63X6W.js ce() off 6934 的另一分支；仅当 BYOK 模型配了 `compat.maxTokensField:"max_tokens"` 才发（本机未配）',
  reasoning_effort: 'chunk-HVP63X6W.js ce() off 7753；`thinkingFormat` 缺省 `"openai"`（off 15752）且 `supportsReasoningEffort` 对自定义 provider 恒 true',
  temperature: 'chunk-HVP63X6W.js ce() off 7054，仅当调用方给了 temperature（本机未配）',
  tools: 'chunk-HVP63X6W.js ce() off 7110（有工具才发）/ off 7186（历史里有 toolCall|toolResult 时发 `tools:[]`）。**COMPAT4 实弹更正**：本机 `tool_call:false` **不阻止**它走 off 7110 那条分支——协调者 2026-10-02 端到端实测收到的是**非空 26 项**数组（不是 `tools:[]`），所以"只有恢复旧会话才会发空数组"这个推断是错的。现接受**非空合法形状**（逐项浅校验）并如实披露 `zcc.tools_received` / `zcc.tools_forwarded: 0`',
  tool_choice: 'chunk-HVP63X6W.js ce() off 7233，仅当调用方给了 toolChoice；本机不配 → 不发。COMPAT4 起接受 `"none"` / `"auto"` / 缺省并披露 `zcc.tool_choice_received`；`"required"` / 具名指定形式仍拒',
  prompt_cache_key: 'chunk-HVP63X6W.js ce() off 6606，仅当 baseURL 是 api.openai.com 或 `PI_CACHE_RETENTION=long`',
  prompt_cache_retention: 'chunk-HVP63X6W.js ce() off 6737 逐字 `"24h"`，仅当 `PI_CACHE_RETENTION=long`',
  tool_stream: 'chunk-HVP63X6W.js ce() off 7150，仅 zai 系（本端点不适用）',
  provider: 'chunk-HVP63X6W.js ce() off 9026，仅 openrouter 兼容模式',
  providerOptions: 'chunk-HVP63X6W.js ce() off 9257，仅 vercel gateway'
});

const MESSAGE_ACCEPTED = ['role', 'content'] as const;
const MESSAGE_REJECTED: Readonly<Record<string, string>> = {
  name: '本端点不实现具名消息（会改变对话身份语义）',
  function_call: '本端点不实现函数调用',
  refusal: '本端点不产生 refusal 字段',
  audio: '本端点不实现音频',
  reasoning_content: '本端点不接收 reasoning_content'
};

/**
 * 消息级**工具痕迹**字段（COMPAT5）：**接受并剥离**，不再 422。
 *
 * 这两个键**不是** {@link MESSAGE_REJECTED} 的一员，但也不是 {@link MESSAGE_ACCEPTED}
 * 的一员——它们在 {@link parseMessage} 里被**单独识别**后直接跳过（既不报
 * `unsupported_parameter`，也不报 `unknown_field`），随后不再进入
 * {@link ParsedMessage}（那条形状只有 `role` + `content`，所以 `tool_call_id`
 * 天然随之消失）。
 *
 * ## 为什么"剥离"在这里是正确的，而顶层 `tools` 仍然 422
 * 二者要的东西**根本不同**：
 *  - **顶层 `tools` / `tool_choice` / `parallel_tool_calls`** 是"**这一轮**要工具
 *    行为"的请求参数。`required` / 具名指定那几档要的是"**必然**产生一个工具
 *    调用"，本端点做不到（驱动器契约上没有工具槽位，见 {@link DriverRequest}），
 *    收下再忽略会让客户端等一个**永远不会来的** `tool_calls` → 如实 422。
 *    这条理由**一个字都没被本轮改动碰到**。
 *  - **消息里的 `tool_calls` / `role:"tool"`** 是"**过去某一轮**发生过工具调用"的
 *    **历史事实**。本端点**这一轮恒为纯文本**，客户端在剥离后**不会等任何东西**
 *    （它等的东西本就不存在），所以剥离不制造挂起；而拒绝它会让 MiniMax Code
 *    这类 BYOK 客户端对**任何**带工具历史的会话完全不可用（实弹：整条请求 422，
 *    `messages[1].tool_calls 本端点不实现`）。这是"披露能力边界，不打断真客户端"
 *    与 {@link parseToolDeclarations} **同一条**底层逻辑，只是作用面从"这一轮的
 *    声明"移到"历史里的痕迹"。
 *
 * ## 剥离不是静默改写（这是与旧裁定唯一的语义分歧）
 * 旧裁定拒绝 `role:"tool"` 的理由是"压成 user 会**静默**改变语义"。压成 user 确实
 * 改变 role，但现在**这个改变被写进了上下文里**（见 {@link TOOL_RESULT_CONTENT_PREFIX}
 * 与 {@link TOOL_TRACE_PLACEHOLDER_CONTENT}），模型与客户端都看得见"这是一条工具
 * 结果 / 这条 assistant 只发了工具调用"，不再是凭空改写一条 user 轮。
 */
export const MESSAGE_TOOL_TRACE_FIELDS = ['tool_calls', 'tool_call_id'] as const;

/**
 * assistant 轮剥掉 `tool_calls` 后 content 为空时的**占位文本**（COMPAT5）。
 *
 * 为什么要有占位而不是**删掉那条消息**：删消息会改变 `messages` 条数与角色序列，
 * 那是比"改写 role"更重的一种静默改写（顺序即语义，见 {@link foldMessagesToPrompt}
 * 的注释）。占位把痕迹留在原位、留在上下文里，客户端与模型都能看见。
 */
export const TOOL_TRACE_PLACEHOLDER_CONTENT = '[此前调用了工具，内容未纳入上下文]';

/**
 * `role:"tool"` 转成 `role:"user"` 后的 **content 前缀**（COMPAT5）。
 *
 * 尾随空格是**逐字**的一部分：它把标记与原文分开，避免"标记文字"与"工具输出"
 * 粘连成一团不可分辨的文本。
 */
export const TOOL_RESULT_CONTENT_PREFIX = '[工具结果] ';

/* -------------------------------------------------------------------------- */
/* 驱动器契约                                                                  */
/* -------------------------------------------------------------------------- */

/** 可机读的上游状态。映射到界面口径的 未接入 / 无额度 / 已就绪。 */
export type DriverStatus = 'not_attached' | 'no_quota' | 'ready';

export interface DriverModel {
  readonly id: string;
  /** OpenAI 兼容形状固定为 `model`。 */
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
}

/* -------------------------------------------------------------------------- */
/* 目录契约（GET /v1/zcc/catalog）                                               */
/* -------------------------------------------------------------------------- */

/**
 * 目录里的计费类别。**与 I04 `BillingClass` 同一组取值**，但本包不 import
 * contracts 的枚举来定义它（保持包边界单向：api → contracts 只走错误码映射），
 * 改一处必须同时改另一处，由契约测试比对两边的取值集合。
 */
export const CATALOG_BILLING_CLASSES = ['subscription', 'promotion', 'metered_api', 'unknown'] as const;
export type CatalogBillingClass = (typeof CATALOG_BILLING_CLASSES)[number];

/** `GET /v1/zcc/catalog` 的**条目**形状。协调者裁定，UI02 已按此实现，勿改形状。 */
export interface CatalogModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly billingClass: CatalogBillingClass;
  /** token 数；`null` = 来源显式声明未知，不允许用 0 或猜测值占位。 */
  readonly contextLength: number | null;
  readonly reasoning: readonly string[];
  readonly capabilities: readonly string[];
}

/** `GET /v1/zcc/catalog` 的**响应**形状：只有这两个键，不多不少。 */
export interface CatalogPayload {
  readonly revision: string;
  readonly models: readonly CatalogModel[];
}

export interface DriverCatalog {
  readonly revision: string;
  readonly models: readonly CatalogModel[];
}

/** 无驱动器时的目录：revision 固定为 `none`，条目为空。诚实，不占位。 */
export const EMPTY_CATALOG: DriverCatalog = Object.freeze({ revision: 'none', models: Object.freeze([]) });

/** 目录契约的**必填键**。服务端产出侧自检与契约测试共用这一张表。 */
export const CATALOG_MODEL_KEYS = [
  'modelId',
  'displayName',
  'provider',
  'billingClass',
  'contextLength',
  'reasoning',
  'capabilities'
] as const;

/**
 * 服务端是目录的**生产方**，但生产方也必须自检：驱动一旦给出违反已公布契约的目录，
 * 整份响应被拒（4xx/5xx），**绝不**部分采纳后当成合法响应发出去——那会让严格解析的
 * 客户端把整个来源判成非法而拿不到任何条目，且现场无法区分是产品错还是来源错。
 *
 * @param {unknown} catalog
 * @returns {string[]} 缺陷路径列表；空数组 = 合法。
 */
export function catalogContractDefects(catalog: unknown): string[] {
  const defects: string[] = [];
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
    return ['$.catalog'];
  }
  const obj = catalog as Record<string, unknown>;
  if (typeof obj['revision'] !== 'string' || obj['revision'].trim() === '') {
    defects.push('$.revision');
  }
  const models = obj['models'];
  if (!Array.isArray(models)) {
    defects.push('$.models');
    return defects;
  }
  const seen = new Set<string>();
  models.forEach((entry, index) => {
    const at = `$.models[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      defects.push(at);
      return;
    }
    const model = entry as Record<string, unknown>;
    for (const key of CATALOG_MODEL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(model, key)) defects.push(`${at}.${key}`);
    }
    for (const key of Object.keys(model)) {
      if (!(CATALOG_MODEL_KEYS as readonly string[]).includes(key)) defects.push(`${at}.${key}`);
    }
    for (const key of ['modelId', 'displayName', 'provider']) {
      const v = model[key];
      if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) defects.push(`${at}.${key}`);
    }
    if (model['billingClass'] !== undefined && !(CATALOG_BILLING_CLASSES as readonly string[]).includes(String(model['billingClass']))) {
      defects.push(`${at}.billingClass`);
    }
    const ctx = model['contextLength'];
    if (ctx !== undefined && ctx !== null && !(typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0)) {
      defects.push(`${at}.contextLength`);
    }
    for (const key of ['reasoning', 'capabilities']) {
      const v = model[key];
      if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== ''))) {
        defects.push(`${at}.${key}`);
      }
    }
    const modelId = model['modelId'];
    if (typeof modelId === 'string') {
      if (seen.has(modelId)) defects.push(`${at}.modelId`);
      seen.add(modelId);
    }
  });
  return defects;
}

export interface DriverRequest {
  readonly operationId: string;
  readonly model: string;
  /**
   * 规范化后的消息。**含** `system` / `developer` 指令轮（COMPAT3）：驱动器用
   * {@link foldMessagesToPrompt} 把它们与对话轮**按原顺序**折叠成一条 prompt，
   * API 层已在 `zcc.roles_folded` 里披露折叠了哪些 role。
   * 驱动器**不得**把它们改名成 `user`——那会让客户端的披露与实际不符。
   */
  readonly messages: readonly ParsedMessage[];
  /**
   * **这个接口上刻意没有 `tools` / `tool_choice`**（COMPAT4）。
   *
   * 这不是遗漏，是 `zcc.tools_forwarded` 恒为 {@link TOOLS_FORWARDED_NONE} 的
   * **结构依据**：API 层接受工具声明只是为了不打断真客户端，声明**从不**进入
   * 驱动器请求，驱动器因此**无处转发**、官方 `session/send` 也只收一条 `content`
   * 文本。若日后要真做工具调用，必须**在这里加槽位**并同步改
   * `zcc.tools_forwarded` 的取值——只改披露值不加工具能力，就是一条假披露
   * （与 `enforcesMaxTokens` 那次返工同族）。契约测试用静态钉守着这一条。
   */
  /** 已由驱动器**强制执行**的上限；不允许被忽略。 */
  readonly maxTokens: number | null;
  /**
   * 请求级推理档位（工单 COMPAT1/C2）。**缺席** = 客户端没发，驱动器用自己的缺省；
   * **在场**时一定落在 {@link REASONING_EFFORT_LEVELS} 闭集内（API 层已校验，
   * 驱动器侧再过一次 `mapReasoningToThoughtLevel` 的 fail-closed 闭集）。
   *
   * 这条字段**升级自**驱动里那段 `(request as {reasoning?: unknown}).reasoning`
   * 的"可选字段转型"——请求级优先于驱动器缺省是官方那条
   * `rawReasoning === undefined ? derived : map(...)` 的语义，现在由**类型**保证。
   */
  readonly reasoning?: string;
  readonly signal: AbortSignal;
}

export type DriverEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      /** 思考流（官方 `reasoning_delta`）。与正文分开携带：SSE 落 `delta.reasoning_content`，非流式落 `message.reasoning_content`。 */
      readonly type: 'reasoning';
      readonly text: string;
    }
  | {
      readonly type: 'usage';
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly usageMethod: string;
    }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'length' };

export interface ChatDriver {
  readonly name: string;
  readonly status: DriverStatus;
  /** 人可读的如实说明，进 `x-zcc-detail` 响应头。 */
  readonly statusDetail: string;
  readonly models: readonly DriverModel[];
  /**
   * 产出是否来自 fixture。真实上游必须是 `false`。
   */
  readonly fixture: boolean;
  /**
   * **本驱动器是否真的强制执行** `DriverRequest.maxTokens`（COMPAT2）。
   *
   * 为什么这是**必填**而不是可选：2026-10-02 的 D3 实弹发现，official-host 此前把
   * `maxTokens` 原样塞进官方 `session/create` 的 params，而那份 params 的 schema
   * （`zcode.cjs` 偏移 757102 的 `nGt`）是 `.strict()` 的、**逐字没有** `maxTokens` 键
   * （嵌套的 `model` 子 schema `Pu` 偏移 508944 同样 `.strict()`，也没有）。
   * 官方在偏移 14131416 的 `yl(e,t){try{return e.parse(t)}catch{…throw -32602 Invalid params}}`
   * 里逐字用 `e.parse(t)` 校验，于是**任何带上限的请求都会被官方拒掉**。
   * 而 `zcc.max_tokens_enforced` 那时仍然报 `true` —— 一条**假披露**。
   *
   * 现在这个键把"能不能生效"变成驱动器**自报的事实**，响应按它如实披露：
   * `true` → `zcc.max_tokens_enforced: true`；`false` → 客户端实际发来的那个键名
   * 进 `zcc.parameters_not_forwarded`（见 {@link maxTokensNotForwarded}）。
   * 必填 = 少写一个驱动器就**编译不过**，不会退化成"默认 true"那种假披露。
   */
  readonly enforcesMaxTokens: boolean;
  /**
   * 目录来源（`GET /v1/zcc/catalog`）。
   * 真实驱动器接入位：I16 换驱动器时**只提供这个字段**即可让目录自动变成真实的，
   * 端点、校验与契约形状都不动。
   */
  readonly catalog: DriverCatalog;
  /**
   * 驱动器**自报的实现事实**（工单 COMPAT1/C4）。原样进响应 `zcc.host`，
   * 键与值都必须是**短码/短串**，零凭据。
   *
   * 存在的唯一理由是**披露**：official-host 会把"官方 agent 的工具权限是
   * `mode=yolo` 免问、我们自己的工具应答策略是 `allow`"这两件事说出来，
   * 客户端不需要猜我们替它做了什么决定。**可选**——没有可披露事实的驱动器
   * （fixture / 无上游）直接省略该键，而不是给一个空对象。
   */
  readonly host?: Readonly<Record<string, string>>;
  /** 真正的异步产出流。非流式响应也由它收集而来，保证两条路径同源。 */
  stream(request: DriverRequest): AsyncGenerator<DriverEvent>;
}

/** `model_is_real` 推导所需的**最小**驱动器能力面。 */
export interface ModelIsRealInput {
  readonly status: DriverStatus;
  readonly fixture: boolean;
  readonly models: readonly unknown[];
}

/**
 * `model_is_real` 的**唯一**推导口径——不硬编码 `false`，也不接受驱动器自报。
 *
 * 判定向保守方向偏：任何一条不满足即为 `false`。
 *  - fixture 驱动器：`fixture === true`，产出是本地生成的假内容 → **false**
 *  - 无驱动器（`not_attached` / `no_quota`）：`status !== 'ready'`，且**不列任何模型**
 *    （空目录，`/v1/models` 与 `/v1/zcc/catalog` 都是空）→ **false**
 *  - 真实驱动器（未来 I16 接入）：`status === 'ready'` 且 `fixture === false`
 *    且确实列出了可服务模型 → **true**
 *
 * 之所以不只看 `fixture`：`createUnavailableDriver` 的 `fixture` 也是 `false`，
 * 但它没有任何模型产出——只按 `fixture` 判会把"无上游"误报成"真实模型"。
 */
export function deriveModelIsReal(driver: ModelIsRealInput): boolean {
  return driver.status === 'ready' && driver.fixture === false && driver.models.length > 0;
}

/**
 * 无上游驱动器。当前两种订阅都没有额度，生产侧唯一诚实的实现。
 * 它**不会**返回任何模型内容：调用即抛，交给 server 层转成 503。
 */
export function createUnavailableDriver(options: { readonly status: 'not_attached' | 'no_quota'; readonly detail?: string }): ChatDriver {
  const detail =
    options.detail ??
    (options.status === 'no_quota'
      ? '两种订阅当前均无额度：不会返回任何模型内容、token 或 usage'
      : '尚未接入官方上游：不会返回任何模型内容、token 或 usage');
  return {
    name: 'unavailable',
    status: options.status,
    statusDetail: detail,
    models: [],
    fixture: false,
    // 无上游时谈不上"强制执行"任何上限（它连产出都没有）。报 `false` 而不是猜 `true`：
    // 保守方向上它只会让披露**更诚实**，不会让任何请求失败。
    enforcesMaxTokens: false,
    // 无上游就没有目录：`revision: 'none'` + 空数组，绝不列占位模型。
    catalog: EMPTY_CATALOG,
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<DriverEvent> {
      throw new ApiError('upstream_unavailable', detail, { driver: 'unavailable', status: options.status });
    }
  };
}

/** fixture 目录的 revision。前缀固定 `fixture-`，让客户端一眼看出不是真实目录。 */
export const FIXTURE_CATALOG_REVISION = 'fixture-catalog-1';

/**
 * fixture 驱动器的目录。**仅测试配置**。
 *
 * 全部字段都如实取"未知/不适用"：`billingClass: 'unknown'`（fixture 没有订阅也没有
 * 按量计费，硬写 `subscription` 等于伪造权益）、`contextLength: null`（不编造 token 数）、
 * `reasoning: []`（没有推理档位）。`displayName` / `provider` 都带 `fixture` 字样。
 */
export function createFixtureCatalog(modelId: string = FIXTURE_MODEL_ID): DriverCatalog {
  return {
    revision: FIXTURE_CATALOG_REVISION,
    models: [
      {
        modelId,
        displayName: `目录条目（fixture · 不是真实模型）`,
        provider: 'zcc-companion-fixture',
        billingClass: 'unknown',
        contextLength: null,
        reasoning: [],
        capabilities: ['text']
      }
    ]
  };
}

/** fixture 驱动器。**仅测试配置**：产出真实由 fixture 生成，且处处标注。 */
export function createFixtureDriver(
  options: { readonly chunkDelayMs?: number; readonly modelId?: string; readonly created?: number } = {}
): ChatDriver {
  const modelId = options.modelId ?? FIXTURE_MODEL_ID;
  const created = options.created ?? 1_700_000_000;
  const delayMs = Math.max(0, options.chunkDelayMs ?? 0);
  return {
    name: FIXTURE_DRIVER_NAME,
    status: 'ready',
    statusDetail: 'fixture 驱动器：内容由本地 fixture 生成，不是真实模型输出',
    models: [{ id: modelId, object: 'model', created, owned_by: 'zcc-companion-fixture (not a real model)' }],
    fixture: true,
    // fixture 驱动器**真的**按 `maxTokens` 截断（见下面 `truncateToFixtureTokens`），
    // 所以它是当前唯一如实报 `true` 的驱动器。
    enforcesMaxTokens: true,
    catalog: createFixtureCatalog(modelId),
    async *stream(request: DriverRequest): AsyncGenerator<DriverEvent> {
      if (request.signal.aborted) {
        throw new ApiError('upstream_outcome_unknown', '客户端在 fixture 产出前取消', { driver: FIXTURE_DRIVER_NAME });
      }
      // 折叠走**共享**实现（COMPAT3）：与 official-host 逐字同一个函数，
      // 所以两个驱动器不可能各自折叠出不同的格式。
      const renderedPrompt = foldMessagesToPrompt(request.messages);
      const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const full =
        `[FIXTURE zcc-local/1] 这不是真实模型输出，仅用于验证接口链路。model=${request.model} ` +
        `turns=${request.messages.length}\nprompt_tokens=${countFixtureTokens(renderedPrompt)}\n` +
        `fixture_echo: ${truncateForEcho(lastUser)}\nfixture_end`;
      const { text, truncated } =
        request.maxTokens === null
          ? { text: full, truncated: false }
          : truncateToFixtureTokens(full, request.maxTokens);

      const promptTokens = countFixtureTokens(renderedPrompt);
      for (const piece of splitIntoDeltas(text)) {
        if (delayMs > 0) await abortableSleep(delayMs, request.signal);
        if (request.signal.aborted) return;
        yield { type: 'delta', text: piece };
      }
      yield {
        type: 'usage',
        promptTokens,
        // 直接对整段产出计数：分段计数会在边界空白上多算，所以统一在这里数一次。
        completionTokens: countFixtureTokens(text),
        usageMethod: 'fixture_whitespace_token_count'
      };
      yield { type: 'finish', reason: truncated ? 'length' : 'stop' };
    }
  };
}

/**
 * fixture 的 token 计数口径：**按空白切分的真实计数**，并在响应里披露。
 * 它不是 tiktoken 的口径，但它是"对实际产出做的一次真实、可复算的计数"，
 * 而不是编造的 token 数。额度恢复后由真实驱动器替换。
 */
export function countFixtureTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/u).length;
}

/** 截断到恰好 n 个空白 token。截断后的串重拼为单空格分隔，因此计数与上限严格相等。 */
export function truncateToFixtureTokens(text: string, maxTokens: number): { readonly text: string; readonly truncated: boolean } {
  const parts = text.split(/\s+/u).filter((p) => p.length > 0);
  if (maxTokens <= 0) return { text: '', truncated: text.trim().length > 0 };
  if (parts.length <= maxTokens) return { text, truncated: false };
  return { text: parts.slice(0, maxTokens).join(' '), truncated: true };
}

function truncateForEcho(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}

/** 把文本切成若干 delta，**拼接后严格等于原文**（含空白）。 */
function splitIntoDeltas(text: string): string[] {
  const spans = [...text.matchAll(/\S+/gu)].map((m) => [m.index, m.index + m[0].length] as const);
  if (spans.length === 0) return text === '' ? [] : [text];
  const per = Math.max(1, Math.ceil(spans.length / 6));
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i += per) {
    const last = Math.min(i + per, spans.length) - 1;
    const end = spans[last]?.[1] ?? cursor;
    out.push(text.slice(cursor, end));
    cursor = end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/** 可被 abort 打断的 sleep。abort 时立刻清 timer，不留悬挂句柄。 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* 请求体校验                                                                  */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

/** 规范化并校验 OpenAI 形状的 chat 请求。任何不接受的输入都是 4xx，绝不静默丢弃。 */
export function parseChatRequest(raw: unknown): ParsedChatRequest {
  if (!isPlainObject(raw)) {
    throw new ApiError('invalid_request', '请求体必须是 JSON 对象', { received: Array.isArray(raw) ? 'array' : typeof raw });
  }
  for (const key of Object.keys(raw)) {
    if ((TOP_LEVEL_REJECTED as Record<string, string>)[key] !== undefined) {
      throw new ApiError('unsupported_parameter', `字段 ${key} 本端点不实现：${TOP_LEVEL_REJECTED[key]}`, {}, key);
    }
    if (!(TOP_LEVEL_ACCEPTED as readonly string[]).includes(key)) {
      throw new ApiError('unknown_field', `未知字段 ${key}：本端点不静默丢弃未识别字段`, {}, key);
    }
  }

  const model = raw['model'];
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_ID_CHARS || hasControlChars(model)) {
    throw new ApiError('invalid_request', `model 必须是非空字符串且不超过 ${MAX_MODEL_ID_CHARS} 字符`, { param: 'model' }, 'model');
  }

  const rawMessages = raw['messages'];
  if (!Array.isArray(rawMessages)) {
    throw new ApiError('invalid_request', 'messages 必须是数组', { param: 'messages' }, 'messages');
  }
  if (rawMessages.length === 0) {
    throw new ApiError('invalid_request', 'messages 不能为空', { param: 'messages' }, 'messages');
  }
  if (rawMessages.length > MAX_MESSAGES) {
    throw new ApiError('payload_too_large', `messages 超过 ${MAX_MESSAGES} 条上限`, { count: rawMessages.length }, 'messages');
  }
  const messages = rawMessages.map((entry, index) => parseMessage(entry, index));

  const stream = raw['stream'];
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw new ApiError('invalid_request', 'stream 必须是布尔值', { param: 'stream' }, 'stream');
  }

  const { value: maxTokens, source: maxTokensSource, clampedFrom: maxTokensClampedFrom } = parseMaxTokens(raw);

  let includeUsage = false;
  const streamOptions = raw['stream_options'];
  if (streamOptions !== undefined) {
    if (!isPlainObject(streamOptions)) {
      throw new ApiError('invalid_request', 'stream_options 必须是对象', { param: 'stream_options' }, 'stream_options');
    }
    for (const key of Object.keys(streamOptions)) {
      if (key !== 'include_usage' && key !== 'include_obfuscation') {
        throw new ApiError('unsupported_parameter', `stream_options.${key} 本端点不实现`, {}, `stream_options.${key}`);
      }
    }
    const include = streamOptions['include_usage'];
    if (include !== undefined && typeof include !== 'boolean') {
      throw new ApiError('invalid_request', 'stream_options.include_usage 必须是布尔值', {}, 'stream_options.include_usage');
    }
    includeUsage = include === true;
    // `include_obfuscation` 是 OpenAI 官方字段（零数据保留客户端的响应混淆开关）。
    // 我们**从不做**响应混淆，所以这个键只可能"收到但没生效" → 校验 + 披露。
    const obfuscation = streamOptions['include_obfuscation'];
    if (obfuscation !== undefined && typeof obfuscation !== 'boolean') {
      throw new ApiError(
        'invalid_request',
        'stream_options.include_obfuscation 必须是布尔值',
        {},
        'stream_options.include_obfuscation'
      );
    }
  }

  const metadata = parseMetadata(raw['metadata']);

  const rawUser = raw['user'];
  if (rawUser !== undefined && rawUser !== null) {
    if (typeof rawUser !== 'string' || rawUser.length === 0 || rawUser.length > MAX_USER_CHARS) {
      throw new ApiError('invalid_request', `user 必须是非空字符串且不超过 ${MAX_USER_CHARS} 字符`, {}, 'user');
    }
  }
  const user = typeof rawUser === 'string' ? rawUser : null;

  parseChoiceCount(raw['n']);
  const reasoning = parseReasoningEffort(raw['reasoning_effort']);
  // 工具**声明**：接受、浅校验、**但不转发**（COMPAT4）。计数与 `tool_choice`
  // 原样带出去，由响应 `zcc.tools_received` / `zcc.tools_forwarded` /
  // `zcc.tool_choice_received` 如实披露。
  const { toolsReceived, toolChoiceReceived } = parseToolDeclarations(raw);
  const parametersNotForwarded = parseNotForwarded(raw);
  // 折叠了哪些指令 role（COMPAT3）：按首次出现序去重，进响应 `zcc.roles_folded`。
  const rolesFolded = collectFoldedPromptRoles(messages);

  return {
    model,
    messages,
    stream: stream === true,
    includeUsage,
    maxTokens,
    maxTokensSource,
    maxTokensClampedFrom,
    metadata,
    user,
    reasoning,
    parametersNotForwarded,
    rolesFolded,
    toolsReceived,
    toolChoiceReceived
  };
}

/**
 * `tools` / `tool_choice` → **接受声明、明示未转发**（工单 COMPAT3 建立、COMPAT4 裁定）。
 *
 * ## 裁定（本轮唯一的语义变更）
 * 改前：非空 `tools` 与 `tool_choice: "auto"` **一律 422**（理由："要工具调用语义，
 * 披露救不回来"）。协调者 2026-10-02 裁定：**非空 `tools` 从拒绝改为接受**，
 * `tool_choice` 的 `"auto"` 一并接受。依据是实弹：mcode 的 `tool_call:false`
 * **不阻止**它发送工具声明（`ce()` off 7110 那条分支与调用方配置无关），
 * 端到端被一个 26 项的非空数组整条挡住。
 *
 * ## 改后为什么仍然是"诚实"的
 * 接受的是**声明**，不是**能力**：
 *  - 驱动器契约上**没有**工具槽位（{@link DriverRequest}），官方 `session/send`
 *    也只收一条 `content` 文本 ⇒ "转发"在结构上**无处发生**；
 *  - 因此响应**恒定**披露 `zcc.tools_forwarded: 0` 与 `zcc.tools_received: n`
 *    （{@link TOOLS_FORWARDED_NONE}），把"纯对话形态"变成一条可机读事实；
 *  - 产出里**永远**不含 `tool_calls`，本端点不实现工具调用这一条没有变。
 *
 * ## 逐条判定（先 `tools` 后 `tool_choice`，`tools` 优先报错）
 *  - `tools` 缺席 / `[]` → 收到 0 条声明；
 *  - `tools` 非空数组 → **接受**（逐条浅校验，见 {@link isShallowToolDeclaration}），
 *    计入 `toolsReceived`；畸形项逐条 422 并**指名下标** `tools[i]`；
 *  - `tools` **非数组**（含 `null`）→ 422 指名 `tools`。`null` **不**等于空数组：
 *    OpenAI 官方没有把 `tools` 声明成可空，它是个结构字段（与 `messages` / `stream`
 *    同族：`null` 不是"合法形状"，不是一个空值语义）。**与改前逐字一致**；
 *  - `tool_choice` 缺席或 `null` → 没有偏好（`toolChoiceReceived: null`）；
 *  - `tool_choice` 在 {@link ACCEPTED_TOOL_CHOICES}（`none` / `auto`）→ **接受**，
 *    逐名披露客户端实际发的那个值；
 *  - `tool_choice` 在 {@link REQUIRED_TOOL_CHOICES}（`required` / `any`）
 *    或**具名对象**形式 → **仍然 422**：这两类要的是"**这一轮一定产生一个工具调用**"，
 *    本端点做不到，收下再忽略会让客户端等一个永远不会来的 `tool_calls`。
 *
 * `tool_choice` 只在有工具语境的请求里才有意义，所以**先**判 `tools`：
 * `tools` 形状非法时报 `tools`（真正的那个键），不先抱怨它的伴随开关。
 *
 * @param raw 已通过顶层键白名单的原始请求体
 * @returns 收到的声明条数 + 客户端实际发的 `tool_choice`（`null` = 没发）
 */
function parseToolDeclarations(raw: Record<string, unknown>): {
  readonly toolsReceived: number;
  readonly toolChoiceReceived: AcceptedToolChoice | null;
} {
  const tools = raw['tools'];
  let toolsReceived = 0;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      throw new ApiError(
        'unsupported_parameter',
        'tools 必须是数组；本端点接受工具声明但**不转发**它们（响应 zcc.tools_forwarded 恒为 0），null 也不等于空数组',
        { param: 'tools' },
        'tools'
      );
    }
    // 浅校验：**逐项**指名下标，好让客户端直接知道是哪一条畸形，而不是笼统的 `tools`。
    tools.forEach((item, index) => {
      if (!isShallowToolDeclaration(item)) {
        throw new ApiError(
          'unsupported_parameter',
          `tools[${String(index)}] 必须是对象且有 function 或 type 字段（OpenAI 工具声明形状；本端点接受声明但不转发它们）`,
          { param: `tools[${String(index)}]`, index },
          `tools[${String(index)}]`
        );
      }
    });
    toolsReceived = tools.length;
  }

  const toolChoice = raw['tool_choice'];
  let toolChoiceReceived: AcceptedToolChoice | null = null;
  if (toolChoice !== undefined && toolChoice !== null) {
    if (typeof toolChoice === 'string' && (ACCEPTED_TOOL_CHOICES as readonly string[]).includes(toolChoice)) {
      toolChoiceReceived = toolChoice as AcceptedToolChoice;
    } else {
      const kind =
        typeof toolChoice === 'string' && (REQUIRED_TOOL_CHOICES as readonly string[]).includes(toolChoice)
          ? '要求必须调用工具'
          : '要求调用某一个具名工具';
      throw new ApiError(
        'unsupported_parameter',
        `字段 tool_choice 本端点不实现：${kind}，而本端点不调用工具（zcc.tools_forwarded 恒为 0）。` +
          `只接受 ${ACCEPTED_TOOL_CHOICES.join(' | ')} 或缺省；${REQUIRED_TOOL_CHOICES.join(' | ')} 与具名指定形式一律拒绝`,
        {
          param: 'tool_choice',
          accepted: [...ACCEPTED_TOOL_CHOICES],
          required: [...REQUIRED_TOOL_CHOICES]
        },
        'tool_choice'
      );
    }
  }
  return { toolsReceived, toolChoiceReceived };
}

/**
 * `max_tokens` **与** `max_completion_tokens` → 同一个 `maxTokens` 槽位（工单 COMPAT2）。
 *
 * 两者在 OpenAI 形状里是**同一件事**的两个名字：`max_tokens` 是旧名（已 deprecated），
 * `max_completion_tokens` 是现名（计入 reasoning token）。本端点**只回一条**候选、
 * 产出由官方 agent 给，所以"生成 token 上限"这个语义对两者一模一样 → 共用一个槽位。
 *
 * **为什么必须有这个别名**（不是"顺手兼容"，是"不接就全线不可用"）：真客户端
 * mcode 对**自定义** provider 的缺省 `maxTokensField` 逐字就是 `"max_completion_tokens"`
 * （`chunk-HVP63X6W.js` off 15564 的缺省能力表），而 BYOK 模型条目只要没显式配
 * `limit.output` 就会拿到 16384 的缺省上限（`chunk-OS45FJAT.js` off 7256605），
 * 于是一条**普通**的 mcode 请求必然带这个键。只认 `max_tokens` = 必然 422
 * `unknown_field`。
 *
 * **同时给两个**：值**相同** → 接受（不猜、不折中，两边说的是同一件事）；
 * 值**不同** → 422 `unsupported_parameter` 并指名两个键——静默挑一个就是替用户做决定。
 *
 * **超额钳制**：值超过 {@link MAX_MAX_TOKENS} 不再 400，钳到上限并在
 * `clampedFrom` 里记下原值（响应经 `zcc.max_tokens_clamped_from` / `_to` 披露）。
 * 依据见 {@link assertMaxTokens} 注释：真客户端发的上限是它自认的模型能力，
 * 不是它能接受的生成预算——钳制是两边语义的交集，拒收则一线不可用。
 *
 * **它到底生不生效，不由这里决定**（见 {@link ChatDriver.enforcesMaxTokens} 与
 * {@link maxTokensNotForwarded}）：API 层只负责**校验**与**记住客户端用的键名**。
 *
 * @param raw 已通过顶层键白名单的原始请求体
 * @returns 生效的上限 + 客户端用的键名 + 钳制前原值（未钳制为 `null`）；两个键都没发时 `value`/`source` 为 `null`
 */
function parseMaxTokens(raw: Record<string, unknown>): {
  readonly value: number | null;
  readonly source: MaxTokensSource | null;
  readonly clampedFrom: number | null;
} {
  const clamp = (v: number): { readonly value: number; readonly clampedFrom: number | null } =>
    v > MAX_MAX_TOKENS ? { value: MAX_MAX_TOKENS, clampedFrom: v } : { value: v, clampedFrom: null };
  const legacy = raw['max_tokens'];
  const modern = raw['max_completion_tokens'];
  const hasLegacy = legacy !== undefined && legacy !== null;
  const hasModern = modern !== undefined && modern !== null;
  if (hasLegacy && hasModern) {
    assertMaxTokens(legacy, 'max_tokens');
    assertMaxTokens(modern, 'max_completion_tokens');
    if (legacy !== modern) {
      throw new ApiError(
        'unsupported_parameter',
        'max_tokens 与 max_completion_tokens 同时出现且取值不同；本端点把它们当同一个上限，不会替你挑一个',
        { max_tokens: legacy, max_completion_tokens: modern },
        'max_completion_tokens'
      );
    }
    // 两个键都发且相同：**记下先出现的那个**（`max_tokens` 是旧名，客户端多半是
    // "补了一个新键"而不是"换了个新键"），披露给客户端它一定认得的那个。
    const c = clamp(legacy as number);
    return { value: c.value, source: 'max_tokens', clampedFrom: c.clampedFrom };
  }
  if (hasModern) {
    assertMaxTokens(modern, 'max_completion_tokens');
    const c = clamp(modern as number);
    return { value: c.value, source: 'max_completion_tokens', clampedFrom: c.clampedFrom };
  }
  if (hasLegacy) {
    assertMaxTokens(legacy, 'max_tokens');
    const c = clamp(legacy as number);
    return { value: c.value, source: 'max_tokens', clampedFrom: c.clampedFrom };
  }
  return { value: null, source: null, clampedFrom: null };
}

/**
 * 上限参数在**当前驱动器**下是否需要进披露表（工单 COMPAT2）。
 *
 * 披露的**键名取客户端实际发来的那个**（`maxTokensSource`），因为披露的作用是让客户端
 * 在自己发的那份请求里看到"这个参数没生效"。驱动器**强制执行**时不披露（它生效了）。
 *
 * @param parsed 已解析的请求
 * @param enforcesMaxTokens 当前驱动器是否真的强制执行上限
 * @returns 需要追加进 `zcc.parameters_not_forwarded` 的键名（0 或 1 个）
 */
export function maxTokensNotForwarded(
  parsed: Pick<ParsedChatRequest, 'maxTokensSource'>,
  enforcesMaxTokens: boolean
): readonly string[] {
  if (enforcesMaxTokens) return [];
  return parsed.maxTokensSource === null ? [] : [parsed.maxTokensSource];
}

/**
 * 上限被**钳制**时的披露片段（工单 COMPAT2 的姊妹机制）。
 *
 * 钳制与"未转发"是两回事：前者是**接受了但缩小到端点上限**（值仍生效，只是变小），
 * 后者是**收下但没进驱动**。两者都必须可机读，但混在一张表里会让客户端读错语义——
 * 所以钳制走独立键：`zcc.max_tokens_clamped_from`（客户端原值）+
 * `zcc.max_tokens_clamped_to`（端点上限 {@link MAX_MAX_TOKENS}）。
 *
 * @param parsed 已解析的请求
 * @returns 未钳制时为空对象（键**缺席**，不是 `null`——与 `zcc.host` 的"缺省缺席"口径一致）
 */
export function maxTokensClampDisclosure(
  parsed: Pick<ParsedChatRequest, 'maxTokensClampedFrom'>
): Record<string, number> {
  return parsed.maxTokensClampedFrom === null
    ? {}
    : { max_tokens_clamped_from: parsed.maxTokensClampedFrom, max_tokens_clamped_to: MAX_MAX_TOKENS };
}

function assertMaxTokens(value: unknown, name: string): void {
  // 形状校验只拦**真畸形**（非整数 / 负数）。上限超额不再 400：真客户端 mcode 对 BYOK
  // 模型条目**不尊重 `limit.output`**（2026-10-10 抓包实测：条目已写 32000，请求仍带
  // `max_completion_tokens: 128000`——mcode 按自家模型认知构造上限），拒绝等于整个客户端
  // 不可用。超额值由 parseMaxTokens 钳到 MAX_MAX_TOKENS，并经 `zcc.max_tokens_clamped_*`
  // 披露——"接受了但缩小到端点上限"必须可机读，不许静默。
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    // 实际收到值随错误披露：参数值本就来自请求方，指出来才能定位"客户端到底发了多少"。
    const received = typeof value === 'number' ? String(value) : typeof value === 'string' ? JSON.stringify(value) : String(value);
    throw new ApiError(
      'invalid_request',
      `${name} 必须是 0..${MAX_MAX_TOKENS} 之间的整数（实际收到 ${received}）`,
      { param: name, received: value === undefined ? null : value },
      name
    );
  }
}

/**
 * `n` → **只接受 1**（工单 COMPAT2 对 D2 三条指定裁定之一的实现）。
 *
 * 本端点固定只回一个 `choices[0]`。`n:1` 是**如实的 no-op**（客户端要的正是我们唯一
 * 给的东西），所以接受；`n>1` 则是"要 3 个候选"，收下再只回 1 个 = 静默丢数据 →
 * 422 并指名。这也解释了为什么 `n` 走单独一条规则而不是
 * {@link NOT_FORWARDED_SPECS}：它不是"元数据"，披露救不回来。
 *
 * `null` 与缺席都算"没这个偏好"。
 *
 * @param raw `n` 的原始值
 */
function parseChoiceCount(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (raw === 1) return;
  throw new ApiError(
    'unsupported_parameter',
    'n 必须是 1（本端点固定只返回 1 个候选，n>1 收下就等于静默丢掉其余候选）',
    { received: typeof raw === 'number' && Number.isInteger(raw) ? raw : null },
    'n'
  );
}

/**
 * `reasoning_effort` → 闭集档位（工单 COMPAT1/C2）。
 *
 * 三条硬规则：
 *  1. **缺席 / `null`** = 客户端没这个偏好 → 返回 `null`（驱动器用自己的缺省）。
 *  2. **必须是字符串且逐字在 {@link REASONING_EFFORT_LEVELS} 闭集内**。
 *  3. **闭集外的值（OpenAI 的 `medium` / `minimal` 也在这里）一律 422 并列出合法值**。
 *     绝不 `?? 'high'`、绝不大小写折叠后蒙一个：官方会以
 *     `reasoning-level-not-supported` 拒掉，提前在这里失败信息更准。
 *
 * 错误码用 `unsupported_parameter`（422）而不是 `invalid_request`（400）：那条消息
 * 说的是"这个取值我们不提供"，与本端点对 `tools` / `response_format` 一类字段的
 * 处置**同一族**，客户端按 422 分支重试或降级、按 400 分支只会当成请求畸形。
 *
 * @param raw `reasoning_effort` 的原始值
 * @returns 闭集内的档位，或 `null`（没发）
 */
function parseReasoningEffort(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const levels = REASONING_EFFORT_LEVELS.join(' | ');
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(
      'unsupported_parameter',
      `reasoning_effort 必须是非空字符串，只接受 ${levels}（官方 GLM 档位；OpenAI 的 medium / minimal 官方不支持）`,
      { accepted: [...REASONING_EFFORT_LEVELS] },
      'reasoning_effort'
    );
  }
  const key = raw.trim();
  if (!(REASONING_EFFORT_LEVELS as readonly string[]).includes(key)) {
    throw new ApiError(
      'unsupported_parameter',
      `reasoning_effort=${JSON.stringify(key)} 不在闭集内，只接受 ${levels}（不猜一档、不折中）`,
      { received: key, accepted: [...REASONING_EFFORT_LEVELS] },
      'reasoning_effort'
    );
  }
  return key;
}

/**
 * A 类参数 → 逐类型校验 + 返回**被接收但没有转发**的参数名（工单 COMPAT1/C3 建立，
 * COMPAT2 推广成通用机制）。
 *
 * 返回顺序**固定**，因此 `zcc.parameters_not_forwarded` 是稳定输出：
 *  1. {@link NOT_FORWARDED_SPECS} 的键序（`temperature` 在 `top_p` 之前——COMPAT1 钉死）；
 *  2. {@link ACCEPTED_NOT_FORWARDED_BUILTINS} 的键序（`metadata` → `user`）；
 *  3. `stream_options.include_obfuscation`。
 *
 * **接受不等于什么形状都收**：每个键按自己的 spec 校验，非法值仍 422
 * （`unsupported_parameter`），理由与 {@link parseReasoningEffort} 同族——
 * `store: "false"` 不是"我们不实现"，是"这个请求畸形"。
 * **`null` 与缺席同义**（OpenAI 把这批键几乎都声明成 `T | null`），不校验也不披露。
 *
 * @param raw 已通过顶层键白名单的原始请求体
 * @returns 已接收但未转发的参数名（可能为空数组）
 */
function parseNotForwarded(raw: Record<string, unknown>): readonly string[] {
  const out: string[] = [];
  for (const [name, spec] of Object.entries(NOT_FORWARDED_SPECS)) {
    const value = raw[name];
    // **`null` 与缺席同义**：OpenAI 把 A 类里几乎每个键都声明成 `T | null`
    // （`store: boolean|null` / `seed: number|null` / `frequency_penalty: number|null` …），
    // 所以 `null` 就是"客户端没有这个偏好"，不是畸形值。与 `metadata` / `user` /
    // `max_tokens` 的既有处理保持一致，也因此**不**进披露表（披露它反而是噪声）。
    if (value === undefined || value === null) continue;
    assertNotForwarded(name, value, spec);
    out.push(name);
  }
  for (const name of ACCEPTED_NOT_FORWARDED_BUILTINS) {
    if (raw[name] !== undefined && raw[name] !== null) out.push(name);
  }
  const streamOptions = raw['stream_options'];
  if (isPlainObject(streamOptions) && streamOptions['include_obfuscation'] !== undefined) {
    out.push('stream_options.include_obfuscation');
  }
  return out;
}

/** 一条 A 类参数的形状校验。失败一律 422 `unsupported_parameter` 并指名。 */
function assertNotForwarded(name: string, value: unknown, spec: NotForwardedSpec): void {
  switch (spec.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ApiError(
          'unsupported_parameter',
          `${name} 必须是布尔值（本端点接受但不转发它，非法值仍然拒绝）`,
          { param: name },
          name
        );
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) {
        throw new ApiError(
          'unsupported_parameter',
          `${name} 必须是 [${spec.min}, ${spec.max}] 之间的有限数值（本端点接受但不转发它，非法值仍然拒绝）`,
          { min: spec.min, max: spec.max },
          name
        );
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
        throw new ApiError(
          'unsupported_parameter',
          `${name} 必须是 [${spec.min}, ${spec.max}] 之间的整数（本端点接受但不转发它，非法值仍然拒绝）`,
          { min: spec.min, max: spec.max },
          name
        );
      }
      return;
    case 'string':
      if (typeof value !== 'string' || value.length === 0 || value.length > spec.maxChars) {
        throw new ApiError(
          'unsupported_parameter',
          `${name} 必须是非空字符串且不超过 ${spec.maxChars} 字符（本端点接受但不转发它，非法值仍然拒绝）`,
          { max_chars: spec.maxChars },
          name
        );
      }
      return;
    case 'enum': {
      const values = spec.values;
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new ApiError(
          'unsupported_parameter',
          `${name} 必须是 ${values.join(' | ')} 之一（OpenAI 官方闭集；不猜一档、不折中）`,
          { accepted: [...values] },
          name
        );
      }
      return;
    }
    default: {
      // 穷尽性检查：spec 新增 kind 而这里没跟上时**编译期**就该红。
      const exhaustive: never = spec;
      throw new Error(`UNREACHABLE_NOT_FORWARDED_SPEC: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function parseMessage(entry: unknown, index: number): ParsedMessage {
  const path = `messages[${index}]`;
  if (!isPlainObject(entry)) {
    throw new ApiError('invalid_request', `${path} 必须是对象`, { param: path }, path);
  }
  for (const key of Object.keys(entry)) {
    // COMPAT5：`tool_calls` / `tool_call_id` 被**接受并剥离**——既不进拒绝表也不进
    // 未知字段表。它们是"历史里的工具痕迹"，不是"这一轮要工具行为"（见
    // {@link MESSAGE_TOOL_TRACE_FIELDS} 的两条理由分界）。
    if ((MESSAGE_TOOL_TRACE_FIELDS as readonly string[]).includes(key)) continue;
    if ((MESSAGE_REJECTED as Record<string, string>)[key] !== undefined) {
      throw new ApiError(
        'unsupported_parameter',
        `${path}.${key} 本端点不实现：${MESSAGE_REJECTED[key]}`,
        {},
        `${path}.${key}`
      );
    }
    if (!(MESSAGE_ACCEPTED as readonly string[]).includes(key)) {
      throw new ApiError('unknown_field', `${path}.${key} 是未知字段`, {}, `${path}.${key}`);
    }
  }
  const role = entry['role'];
  if (typeof role !== 'string') {
    throw new ApiError('invalid_request', `${path}.role 必须是字符串`, { param: `${path}.role` }, `${path}.role`);
  }
  // COMPAT5：`tool` 轮**不再** 422，转成 `user` 并在 content 前缀
  // {@link TOOL_RESULT_CONTENT_PREFIX}——改写**在文本里可见**，不是静默压平。
  if (role === 'tool') {
    return { role: 'user', content: parseToolResultContent(entry['content'], path) };
  }
  if (!(SUPPORTED_ROLES as readonly string[]).includes(role)) {
    // 明确拒绝，绝不压成 user 字符串：那会静默改变消息语义。
    //
    // **COMPAT3 收敛**：真客户端 mcode 对自定义 provider 的缺省 `supportsDeveloperRole`
    // 是 true（`chunk-HVP63X6W.js` off 15435），于是它**必然**把系统提示词发成
    // `role:"developer"`（`ke()` off 10416）。这两个 role 已按协调者裁定改为
    // **接受 + 折叠**（见 {@link FOLDED_PROMPT_ROLES} / {@link foldMessagesToPrompt}，
    // 披露在响应 `zcc.roles_folded`）。
    //
    // **COMPAT5 收敛**：只剩**旧式函数调用**轮（`function`）与一切别的 role。
    // `tool` 那一档已改为"接受 + 前缀转写"（上一段）；`function` **仍然拒**——
    // 旧式 `functions` / `function_call` 是另一套**参数面**的同族键，而那套在
    // {@link TOP_LEVEL_REJECTED} 里是逐条钉死的 422，消息侧若放行就与它自相矛盾。
    const hint =
      role === 'function'
        ? '；本端点不实现函数调用，请把函数结果并进 user content 或用它的纯文本内容另起一轮 user'
        : '';
    throw new ApiError(
      'unsupported_role',
      `role=${role} 本端点不支持，只接受 ${SUPPORTED_ROLES.join(' | ')}；不合并为 user${hint}`,
      { role, accepted: [...SUPPORTED_ROLES] },
      `${path}.role`
    );
  }
  // COMPAT5：`tool_calls` 被剥离后，若这条 assistant 的 content 为空/null，
  // 用 {@link TOOL_TRACE_PLACEHOLDER_CONTENT} 占位——**消息不删、条数与顺序不变**
  // （删消息比改写 role 更重地改变语义）。
  if (Object.prototype.hasOwnProperty.call(entry, 'tool_calls') && isBlankContent(entry['content'])) {
    return { role: role as SupportedRole, content: TOOL_TRACE_PLACEHOLDER_CONTENT };
  }
  return { role: role as SupportedRole, content: parseContent(entry['content'], path) };
}

/**
 * 这条消息的 content 是否"空"到需要占位（COMPAT5）。
 *
 * 只认三种形状，其余交给 {@link parseContent} 原样判定：
 * 字段**缺席**、显式 `null`、以及**零长度字符串**（OpenAI 允许 `content:""`）。
 * 内容分段数组（哪怕拼出来是空串）**不**走占位——它仍是客户端明确给出的形状。
 */
function isBlankContent(content: unknown): boolean {
  if (content === undefined || content === null) return true;
  return typeof content === 'string' && content.length === 0;
}

/**
 * `role:"tool"` 的 content → 带 {@link TOOL_RESULT_CONTENT_PREFIX} 前缀的纯文本。
 *
 * 三条规则，逐条都有理由：
 *  - **字符串原样**：工具输出本来就是纯文本，加前缀即可，**不重排、不截断语义**；
 *  - **非字符串 → JSON 文本化**（`JSON.stringify`）：真客户端会把结构化工具结果
 *    直接放进 content。文本化保证内容**一个字都不丢**（不丢比不漂亮重要）；
 *  - **缺席 / `null` → 空串**（只留前缀）：不凭空造内容，也不报错。
 *
 * 结果仍走 {@link assertContentLength}：上限**不因转换而放宽**。
 */
function parseToolResultContent(content: unknown, path: string): string {
  if (content === undefined || content === null) return TOOL_RESULT_CONTENT_PREFIX;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const out = `${TOOL_RESULT_CONTENT_PREFIX}${text === undefined ? '' : text}`;
  assertContentLength(out.length, path);
  return out;
}

function assertContentLength(chars: number, path: string): void {
  if (chars > MAX_CONTENT_CHARS) {
    throw new ApiError(
      'payload_too_large',
      `${path}.content 超过 ${MAX_CONTENT_CHARS} 字符上限`,
      { chars },
      `${path}.content`
    );
  }
}

/** 非 text 分段的占位文本。原值（图片 data URL 等）**绝不**进占位——只留类型名。 */
function omittedPartPlaceholder(type: string): string {
  return `[${type} 未纳入上下文：本端点为纯文本，该分段已省略]`;
}

function parseContent(content: unknown, path: string): string {
  if (typeof content === 'string') {
    assertContentLength(content.length, path);
    return content;
  }
  if (!Array.isArray(content)) {
    throw new ApiError('invalid_request', `${path}.content 必须是字符串或内容分段数组`, {}, `${path}.content`);
  }
  let out = '';
  content.forEach((part, partIndex) => {
    const partPath = `${path}.content[${partIndex}]`;
    if (!isPlainObject(part)) {
      throw new ApiError('invalid_request', `${partPath} 必须是对象`, {}, partPath);
    }
    const type = part['type'];
    if (type !== 'text') {
      // 2026-10-10 起非 text 分段（image_url / input_image / file …）不再 422：
      // 真客户端 mmx 的附件会话（attachment:true）历史里**每轮**都带图片分段，
      // 422 让整个会话死锁（重发永远被拒）。改为占位文本放行——占位在 prompt
      // 里可见，模型与客户端都知道"这里有过一张图、图没进上下文"，与
      // MESSAGE_TOOL_TRACE_FIELDS 的占位同哲学；**不静默**（原值从不进 prompt）。
      if (typeof type === 'string' && type.length > 0 && type.length <= 64) {
        out += omittedPartPlaceholder(type);
        return;
      }
      throw new ApiError(
        'unsupported_content_type',
        `${partPath}.type=${String(type)} 本端点只支持 text 分段`,
        { part_type: String(type) },
        `${partPath}.type`
      );
    }
    for (const key of Object.keys(part)) {
      if (key !== 'type' && key !== 'text') {
        throw new ApiError('unknown_field', `${partPath}.${key} 是未知字段`, {}, `${partPath}.${key}`);
      }
    }
    const text = part['text'];
    if (typeof text !== 'string') {
      throw new ApiError('invalid_request', `${partPath}.text 必须是字符串`, {}, `${partPath}.text`);
    }
    out += text;
  });
  if (out.length > MAX_CONTENT_CHARS) {
    throw new ApiError(
      'payload_too_large',
      `${path}.content 拼接后超过 ${MAX_CONTENT_CHARS} 字符上限`,
      { chars: out.length },
      `${path}.content`
    );
  }
  return out;
}

function parseMetadata(raw: unknown): Readonly<Record<string, string | number | boolean>> | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw new ApiError('invalid_request', 'metadata 必须是对象', { param: 'metadata' }, 'metadata');
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new ApiError('invalid_request', `metadata 键数超过 ${MAX_METADATA_KEYS} 上限`, { keys: keys.length }, 'metadata');
  }
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new ApiError('invalid_request', `metadata.${key} 只接受 string / number / boolean`, {}, `metadata.${key}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > METADATA_MAX_BYTES) {
    throw new ApiError('payload_too_large', `metadata 超过 ${METADATA_MAX_BYTES} 字节上限`, { param: 'metadata' }, 'metadata');
  }
  return out;
}

/**
 * 规范化后的请求指纹：键序无关、值敏感。幂等冲突判据。
 *
 * **含 `reasoning`**（工单 COMPAT1/C2）：同一幂等作用域下用**不同**档位发两次，
 * 那**不是**同一次操作的重试。漏掉它会让 `reasoning_effort` 变成一条"改了也不算数"
 * 的静默参数——正是本文件一直在消灭的那类缺陷。
 *
 * **含 `messages[].role`**（COMPAT3）：`system` / `developer` 会被折叠进 prompt，
 * 也就是说它们**改变**这次请求发给上游的内容。折叠出来的行文本逐字进入 prompt，
 * 两条 role 不同或内容不同的请求**不是**同一次操作 → 必须进指纹。
 *
 * **不含 `tools` / `tool_choice`**（COMPAT4）：工具声明**从不转发**（驱动器契约上
 * 没有槽位，见 {@link DriverRequest}），所以它们**不改变**发给上游的任何内容——
 * 与其它 A 类"接受但未转发"参数（`temperature` / `store` / `top_p`…）同口径，
 * 不是"操作身份"的一部分。把它们塞进指纹只会造出一次**假的 409**：同一次操作
 * 因为带了一份没生效的声明清单而被判成重放冲突。契约测试钉住这一条。
 */
export function normalizedRequestHash(parsed: ParsedChatRequest): string {
  return canonicalRequestHash({
    model: parsed.model,
    messages: parsed.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: parsed.stream,
    includeUsage: parsed.includeUsage,
    maxTokens: parsed.maxTokens,
    metadata: parsed.metadata,
    user: parsed.user,
    reasoning: parsed.reasoning
  });
}

/* -------------------------------------------------------------------------- */
/* SSE                                                                        */
/* -------------------------------------------------------------------------- */

/** 单次响应的 SSE 字节预算。超限抛错而不是静默截断出一个"看起来成功"的流。 */
export class SseBudget {
  frames = 0;
  bufferedBytes = 0;

  write(frame: string): void {
    const size = Buffer.byteLength(frame, 'utf8');
    if (size > SSE_FRAME_MAX_BYTES) {
      throw new Error(`SSE_FRAME_TOO_LARGE: 单帧 ${size} 字节 > ${SSE_FRAME_MAX_BYTES}`);
    }
    if (this.bufferedBytes + size > STREAM_BUFFER_MAX_BYTES) {
      throw new Error(
        `SSE_BUFFER_TOO_LARGE: 累计 ${this.bufferedBytes + size} 字节 > ${STREAM_BUFFER_MAX_BYTES}`
      );
    }
    this.bufferedBytes += size;
    this.frames += 1;
  }
}

export interface SseFrameContext {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly zcc: Readonly<Record<string, unknown>>;
}

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

export function emitChunk(
  ctx: SseFrameContext,
  choices: readonly unknown[],
  extra: Readonly<Record<string, unknown>> = {}
): string {
  return sseFrame({ id: ctx.id, object: ctx.object, created: ctx.created, model: ctx.model, choices, zcc: ctx.zcc, ...extra });
}
