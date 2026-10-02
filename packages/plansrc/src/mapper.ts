/**
 * PLANSRC mapper —— 官方本地目录 / 选择 / 资格 → 既有目录契约 + 独立 planStatus。
 *
 * 四条硬事实：
 *  1. **catalog 条目形状一字不改。** 这里产出的就是 `/v1/zcc/catalog` 已经在用的
 *     `CatalogModel` 七字段（`modelId/displayName/provider/billingClass/contextLength/
 *     reasoning/capabilities`）+ `DriverCatalog.revision`。类型直接 `import type` 自
 *     `packages/api/src/chat.js`（**仅类型，运行时无 import**，所以不产生包间运行时边），
 *     这样"形状一致"由编译器保证，而不是靠两处手工同步。
 *  2. **billingClass 映射保守。** 只有四条 `access.mode` 有证据，其余一律 `unknown`。
 *     绝不把未知 mode 落成 `subscription` / `promotion`——那是在没有资格读数的情况下
 *     伪造权益。证据逐条写在 {@link PLAN_ACCESS_MODE_BILLING} 的注释里。
 *  3. **模型能力按官方的匹配语义解析。** 证据：注册名 `matchesRule`（压缩名 `vWt`）
 *     `vWt(e,t,n=!1){ return new RegExp("^(?:"+e+")$", n?"i":void 0).test(t) }`，
 *     以及调用点 `vWt(s.modelMatch, t.modelId, !0)`——**整串锚定 + 大小写不敏感**。
 *     合并语义证据：同处 `n = n.overlay(s.config)` 逐条叠加，`ModelPropertiesConfig.overlay`
 *     与 `ModelInputFormatConfig.overlay` 都是**逐键**合并，
 *     所以"后出现的规则覆盖同名键、嵌套对象逐键合并"。
 *     全部条目的可复核引用见 {@link PLAN_EVIDENCE_ANCHORS}（注册名 + 代码片段双锚）。
 *  4. **planStatus 只用本地可得的三类事实。** 目录来自 builtin、当前选择来自 setting、
 *     资格来自 coding-plan-cache 快照。缓存里没有对应键的套餐一律 `unknown` 并注明原因，
 *     **不外推、不从 group 猜**。缓存是快照：`availabilityObservedAt` 是唯一的时效锚点，
 *     它证明"某时刻 refresh 返回 available"，不证明"现在仍然 available"。
 */
import { createHash } from 'node:crypto';
import type { CatalogBillingClass, CatalogModel, DriverCatalog } from '../../api/src/chat.js';
import type {
  BuiltinDocument,
  BuiltinModelRule,
  BuiltinProviderRule,
  CacheDocument,
  PlanSourceDocument,
  PlanSources,
  SettingDocument
} from './reader.js';

/* -------------------------------------------------------------------------- */
/* 证据注册表                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一条可复核的官方证据。
 *
 * **为什么是双锚（REV11 I-1）**：本包早先把官方代码的引用写成"文件 + 字节偏移"
 * （例如 `zcode.cjs` @936,102）。`zcode.cjs` / `app.asar` 都是**随版本滚动的构建产物**：
 * 发一次版，压缩名可能换、函数顺序可能变、字节偏移整体平移。偏移量级可达十万级，
 * 一次无关联的依赖升级就足以让整条引用指到别的地方去，而**看起来仍然"有引用"**——
 * 这正是"文档级欠锚"最危险的地方：它不会报错，只会让下一位复核者复核错的东西。
 *
 * 因此每条证据必须给出两个**不依赖偏移**的锚：
 *  - {@link registeredName}：**官方注册名**。`r(KKi,"resolvePlanIdentitySnapshot")`
 *    形式的注册字符串，或 zod 类的 `r(this,"ModelPropertiesConfig")`，
 *    或 i18n 键（`manualClaimPlan.banner.aria`）。注册名由发布方显式写死，
 *    压缩器不会重命名它——这是最稳定的一层。
 *  - {@link snippet}：可在产物里**逐字搜到**的代码或文案片段。注册名可能被复用/改名，
 *    片段不会：只要这行代码还在，结论就还成立。
 *
 * {@link offsetHint} **只是辅助信息**，记录本次核验时的字节偏移以便人工快速跳转。
 * 它不参与判断，**不得**被当作引用；产物一更新它就失效，引用靠上面两个锚继续成立。
 */
export interface PlanEvidenceAnchor {
  /** 稳定 id（人工可读，不随产物变化）。 */
  readonly id: string;
  /** 本条证据支撑的 `access.mode`。 */
  readonly accessModes: readonly string[];
  /** 证据所在的官方产物（绝对路径或产物内路径）。 */
  readonly sourceFile: string;
  /** 锚一：官方注册名（导出别名 / 类注册名 / i18n 键）。 */
  readonly registeredName: string;
  /** 锚二：可逐字搜到的代码或文案片段。 */
  readonly snippet: string;
  /** 辅助：本次核验的字节偏移。**不是引用**，产物更新后即失效。 */
  readonly offsetHint?: string;
  /** 这条证据支撑的结论（一句话）。 */
  readonly claim: string;
}

/**
 * 全部 billingClass / 能力解析结论的证据注册表。
 *
 * 只读不写：测试直接遍历它并断言"每条都有非空注册名与非空片段"
 * （`tests/contract/plansrc.test.mjs` §8），所以**删掉任一锚会让 `npm test` 变红**——
 * 这就是让"引用加固"变成可执行约束而不是文档许诺的方式。
 */
export const PLAN_EVIDENCE_ANCHORS: readonly PlanEvidenceAnchor[] = Object.freeze([
  Object.freeze({
    id: 'coding-plan-identity-from-subscription',
    accessModes: Object.freeze(['individual-coding-plan', 'team-coding-plan']),
    sourceFile: 'C:/ZCode/resources/glm/zcode.cjs',
    registeredName: 'resolvePlanIdentitySnapshot',
    snippet: 'function KKi(e){let t=lXe(e.now,"unknown","")',
    offsetHint: '936046',
    claim: 'coding plan 身份取自订阅对象：n.kind==="active" 成立后 lXe(n.generatedAt,"coding_plan",n.planProductId)，而 planProductId=t.subscription?.details[0]?.productId'
  }),
  Object.freeze({
    id: 'coding-plan-active-requires-quota-or-subscription',
    accessModes: Object.freeze(['individual-coding-plan', 'team-coding-plan']),
    sourceFile: 'C:/ZCode/resources/glm/zcode.cjs',
    registeredName: 'resolvePlanEntitlementState',
    snippet: 't.quota||t.subscription||t.remaining?{kind:"active",generatedAt:t.generatedAt,planProductId:t.subscription?.details[0]?.productId??""}',
    offsetHint: '936622',
    claim: '个人 / 团队编码套餐挂在 subscription 上；两种 mode 走同一条判定路径，只是购买主体不同'
  }),
  Object.freeze({
    id: 'start-plan-is-time-limited-claim',
    accessModes: Object.freeze(['start-plan']),
    sourceFile: 'C:/ZCode/resources/app.asar',
    registeredName: 'manualClaimPlan.banner.aria',
    snippet: '可领取的体验套餐',
    claim: 'Start Plan 是限时活动领取制的体验额度（配 manualClaimPlan.banner.tag=限时可领取、manualClaimPlan.claim.dialog.confirm=开始体验），不是常规订阅，故落 promotion 而非 subscription'
  }),
  Object.freeze({
    id: 'start-plan-claim-operation-name',
    accessModes: Object.freeze(['start-plan']),
    sourceFile: 'C:/ZCode/resources/glm/zcode.cjs',
    registeredName: 'claim_zcode_plan',
    snippet: 'm.object({type:m.literal("claim_zcode_plan"),args:m.object({plan_id:PXe})})',
    offsetHint: '991575',
    claim: '官方以 claim_zcode_plan / claim_plan 作为操作类型名，佐证 start-plan 走"领取"而非"订阅"'
  }),
  Object.freeze({
    id: 'offpeak-classified-separately-from-account-plan',
    accessModes: Object.freeze(['off-peak']),
    sourceFile: 'C:/ZCode/resources/glm/zcode.cjs',
    registeredName: 'createNodeModelSelectionFacade',
    snippet: 'Object.values(fXe).some(n=>n===t)?"account-offpeak":"ordinary"',
    offsetHint: '1066745',
    claim: '官方分类器把 off-peak 归成与 account-plan 并列的 account-offpeak 类别；没有任何购买/领取/活动/余额语义证据，故不判 subscription 也不判 promotion，保守落 unknown'
  })
]);

/* -------------------------------------------------------------------------- */
/* billingClass 证据表                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `access.mode` → `billingClass`。**这张表是白名单，不是默认分支。**
 *
 * 证据逐条（**可复核的引用一律见 {@link PLAN_EVIDENCE_ANCHORS}**，此处只留结论摘要；
 * 不要再往这里写裸字节偏移——见该类型的双锚说明）：
 *
 * - `individual-coding-plan` / `team-coding-plan` → `subscription`
 *   证据（`coding-plan-identity-from-subscription` /
 *   `coding-plan-active-requires-quota-or-subscription`）：
 *   coding plan 的身份是从**订阅对象**上取的 ——
 *   `n.kind==="active"` 成立条件是 `t.quota||t.subscription||t.remaining`，
 *   随后 `lXe(n.generatedAt, "coding_plan", n.planProductId)` 而
 *   `planProductId = t.subscription?.details[0]?.productId`。
 *   即"个人/团队编码套餐"在官方实现里就是挂在 `subscription` 上的产品。
 *   两种 mode 走同一条判定路径，只是购买主体（个人 / 团队）不同。
 *
 * - `start-plan` → `promotion`
 *   证据（`start-plan-is-time-limited-claim` / `start-plan-claim-operation-name`）：
 *   `C:/ZCode/resources/app.asar` 内 i18n 键 `manualClaimPlan.banner.aria` 的
 *   逐字文案"可领取的体验套餐"、`manualClaimPlan.banner.tag` "限时可领取"、
 *   `manualClaimPlan.claim.dialog.confirm` "开始体验"、
 *   `manualClaimPlan.claim.failure.unavailable` "活动已结束或套餐暂不可领取"、
 *   `manualClaimPlan.claim.failure.quotaExhausted` "今日领取名额已用完"；
 *   另有 `zcode.cjs` 里的操作类型名 `claim_zcode_plan` / `claim_plan`。
 *   即 Start Plan 是**限时活动领取制**的体验额度，不是常规订阅。
 *   与本产品既有合同对齐：`packages/contracts/src/operation.ts:319`
 *   "promotion 为订阅通道：需活动有效期证据独立成立，目录出现活动条目不等于可立即发送"。
 *
 * - `off-peak` → `unknown`
 *   证据（`offpeak-classified-separately-from-account-plan`）只支持"它不是订阅"：
 *   `zcode-builtin.json` 里两条 off-peak providerRule 带 `visibility: "hidden"`；
 *   官方分类器 `createNodeModelSelectionFacade`（压缩名 `gmr`，E1R §3.3）把它归成
 *   `account-offpeak` 这一与 `account-plan` **并列**的类别；i18n 侧只有
 *   `offPeak.chatCreated.queued` = "已加入闲时队列" 这类闲时任务文案。
 *   **没有**任何购买 / 领取 / 活动 / 余额语义的证据，
 *   所以既不判 subscription 也不判 promotion，保守落 `unknown`。
 *
 * - 其它任何 `access.mode`（含缺 `mode`、`mode` 非字符串、大小写不同的写法）→ `unknown`。
 *   保守方向是**不可发送**：`BILLING_CLASS_SENDABLE.unknown === false`。
 */
export const PLAN_ACCESS_MODE_BILLING: Readonly<Record<string, CatalogBillingClass>> = Object.freeze({
  'individual-coding-plan': 'subscription',
  'team-coding-plan': 'subscription',
  'start-plan': 'promotion',
  'off-peak': 'unknown'
});

/** 有证据的 mode 全集。测试钉死：映射表的键集合必须恰好等于它。 */
export const KNOWN_ACCESS_MODES = Object.freeze(Object.keys(PLAN_ACCESS_MODE_BILLING));

/**
 * 保守映射。**只有精确命中 {@link PLAN_ACCESS_MODE_BILLING} 的字符串**才有非 `unknown` 结果。
 *
 * @param raw `access.mode` 原值（可能是任意类型）
 * @returns `CatalogBillingClass`；不认识一律 `unknown`
 */
export function mapAccessModeToBillingClass(raw: unknown): CatalogBillingClass {
  if (typeof raw !== 'string') return 'unknown';
  const hit = PLAN_ACCESS_MODE_BILLING[raw];
  return hit ?? 'unknown';
}

/* -------------------------------------------------------------------------- */
/* 模型能力解析                                                                    */
/* -------------------------------------------------------------------------- */

/** 目录 `capabilities` 的**闭集**标签（顺序即展示顺序，确定性输出）。 */
export const CAPABILITY_TOKENS = [
  'text',
  'image',
  'video',
  'audio',
  'pdf',
  'tool_call',
  'json_schema_output',
  'native_web_search',
  'mid_conversation_system',
  'output_text'
] as const;
export type CapabilityToken = (typeof CAPABILITY_TOKENS)[number];

export interface ResolvedModelProperties {
  /** token 数；`null` = 来源没有给出（不编造、不用 0 占位）。 */
  readonly contextWindow: number | null;
  /** 官方 `optionSpecs.reasoningLevel.values`，逐字；没有则空数组。 */
  readonly reasoning: readonly string[];
  readonly capabilities: readonly string[];
  /** 编译失败的正则（按"不命中"处理，不让一条坏规则炸掉整份目录）。 */
  readonly invalidPatterns: readonly string[];
  /** 目录显式声明 `enabled: false` 时为 false。 */
  readonly enabled: boolean;
}

/** 官方锚定 + 大小写不敏感（证据：`vWt(s.modelMatch, t.modelId, !0)`）。 */
function compileModelMatch(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, 'i');
}

function laterValue<T>(current: T | undefined, incoming: unknown): T | undefined {
  return incoming === undefined || incoming === null ? current : (incoming as T);
}

function mergeRecord(
  current: Readonly<Record<string, unknown>> | undefined,
  incoming: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainObject(incoming)) return current;
  return { ...(current ?? {}), ...incoming };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 按官方语义解析一个模型 id 的能力：`^(?:modelMatch)$` 大小写不敏感匹配，
 * 命中规则**按文件顺序逐键 overlay**。
 *
 * @param modelRules `$.config.modelConfigRules.modelRules`（未知结构时按空处理）
 * @param modelId 模型 id
 * @returns 解析结果；一条都没命中时 `contextLength: null` / 空数组
 */
export function resolveModelProperties(modelRules: unknown, modelId: string): ResolvedModelProperties {
  const rules: BuiltinModelRule[] = Array.isArray(modelRules) ? (modelRules as BuiltinModelRule[]) : [];
  const invalidPatterns: string[] = [];
  let contextWindow: number | null = null;
  let reasoning: string[] = [];
  let inputFormat: Readonly<Record<string, unknown>> | undefined;
  let outputFormat: Readonly<Record<string, unknown>> | undefined;
  let supportsToolCall: boolean | undefined;
  let supportsJsonSchemaOutput: boolean | undefined;
  let supportsNativeWebSearch: boolean | undefined;
  let supportsMidConversationSystem: boolean | undefined;
  let enabled = true;
  let matched = 0;

  for (const rule of rules) {
    const pattern = rule?.['modelMatch'];
    if (typeof pattern !== 'string') continue;
    let re: RegExp;
    try {
      re = compileModelMatch(pattern);
    } catch {
      // 坏正则按"不命中"处理：一条坏规则不该让整份目录拿不到。
      invalidPatterns.push(pattern);
      continue;
    }
    if (!re.test(modelId)) continue;
    matched += 1;
    const config = isPlainObject(rule['config']) ? rule['config'] : {};
    if (config['enabled'] === false) enabled = false;
    const properties = isPlainObject(config['properties']) ? config['properties'] : {};
    const cw = properties['contextWindow'];
    if (typeof cw === 'number' && Number.isInteger(cw) && cw > 0) contextWindow = cw;
    inputFormat = mergeRecord(inputFormat, properties['inputFormat']);
    outputFormat = mergeRecord(outputFormat, properties['outputFormat']);
    supportsToolCall = laterValue(supportsToolCall, properties['supportsToolCall']);
    supportsJsonSchemaOutput = laterValue(supportsJsonSchemaOutput, properties['supportsJsonSchemaOutput']);
    supportsNativeWebSearch = laterValue(supportsNativeWebSearch, properties['supportsNativeWebSearch']);
    supportsMidConversationSystem = laterValue(supportsMidConversationSystem, properties['supportsMidConversationSystem']);
    const optionSpecs = isPlainObject(config['optionSpecs']) ? config['optionSpecs'] : {};
    const levels = isPlainObject(optionSpecs['reasoningLevel']) ? optionSpecs['reasoningLevel'] : undefined;
    if (levels !== undefined && Array.isArray(levels['values'])) {
      // 档位集合是整体替换而不是合并：官方 overlay 对 values 走 overlayValue（整体）。
      const values = (levels['values'] as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      reasoning = values;
    }
  }

  const capabilities: string[] = [];
  if (matched === 0) {
    // 一条都没命中：来源没有对这个模型说过任何能力。如实空，不从"看起来像"里推。
    return { contextWindow: null, reasoning: [], capabilities: [], invalidPatterns, enabled };
  }
  const flag = (bag: Readonly<Record<string, unknown>> | undefined, key: string): boolean => bag?.[key] === true;
  if (flag(inputFormat, 'supportsText')) capabilities.push('text');
  if (flag(inputFormat, 'supportsImage')) capabilities.push('image');
  if (flag(inputFormat, 'supportsVideo')) capabilities.push('video');
  if (flag(inputFormat, 'supportsAudio')) capabilities.push('audio');
  if (flag(inputFormat, 'supportsPdf')) capabilities.push('pdf');
  if (supportsToolCall === true) capabilities.push('tool_call');
  if (supportsJsonSchemaOutput === true) capabilities.push('json_schema_output');
  if (supportsNativeWebSearch === true) capabilities.push('native_web_search');
  if (supportsMidConversationSystem === true) capabilities.push('mid_conversation_system');
  if (flag(outputFormat, 'supportsText')) capabilities.push('output_text');
  return { contextWindow, reasoning, capabilities, invalidPatterns, enabled };
}

/* -------------------------------------------------------------------------- */
/* builtin 文档 → 目录契约                                                         */
/* -------------------------------------------------------------------------- */

/** 目录条目的 modelId 分隔符（套餐维度 + 模型维度）。 */
export const OFFERING_ID_SEPARATOR = '::';

/** `providerId::modelId` → 真实 modelId。供消费者把目录条目还原成可选项。 */
export function splitOfferingId(offeringId: string): { readonly providerId: string; readonly modelId: string } {
  const at = offeringId.indexOf(OFFERING_ID_SEPARATOR);
  if (at < 0) return { providerId: '', modelId: offeringId };
  return { providerId: offeringId.slice(0, at), modelId: offeringId.slice(at + OFFERING_ID_SEPARATOR.length) };
}

/**
 * 目录 `revision`：由**内容**派生，不含时钟，所以同一份文件两次读出同一个 id，
 * 换了内容就换 id（UI 靠它判断"来源变了"）。
 *
 * @param document 已擦除的 builtin 文档
 * @returns `local-official:builtin:<sha256 前 16 位>`
 */
function deriveCatalogRevision(document: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(document) ?? 'null').digest('hex').slice(0, 16);
  return `local-official:builtin:${digest}`;
}

function readProviderRules(doc: BuiltinDocument | null): BuiltinProviderRule[] {
  const rules = doc?.config?.providerConfigRules?.providerRules;
  return Array.isArray(rules) ? (rules as BuiltinProviderRule[]) : [];
}

function readModelRules(doc: BuiltinDocument | null): BuiltinModelRule[] {
  const rules = doc?.config?.modelConfigRules?.modelRules;
  return Array.isArray(rules) ? (rules as BuiltinModelRule[]) : [];
}

/**
 * `(providerId, modelId)` → 是否启用。
 *
 * 用**交集**而不是只用 `builtinModelIds`：`builtinModelIds` 是该套餐**声明**提供的模型，
 * `builtinProviderModelRules[*].config.enabled` 是**逐组合的启用表**。本机实测两者并不一致
 * （individual/team 声明 2 个，启用表里却有 4 个），只信其一会多列或少列。两个都要求为真
 * 才出条目：声明了但没启用的不出，启用了但没声明的也不出。
 */
function readEnablement(doc: BuiltinDocument | null): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const rules = doc?.config?.modelConfigRules?.builtinProviderModelRules;
  if (!Array.isArray(rules)) return out;
  for (const rule of rules as Array<{ providerId?: unknown; modelId?: unknown; config?: { enabled?: unknown } }>) {
    if (typeof rule?.providerId !== 'string' || typeof rule?.modelId !== 'string') continue;
    out.set(`${rule.providerId}\u0000${rule.modelId}`, rule.config?.enabled !== false);
  }
  return out;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 把 builtin providerRules 映射成既有目录契约。
 *
 * **一条目录条目 = 一个（套餐 × 模型）组合**，不是"去重后的模型"。
 * 理由：同一个 `GLM-5.3` 在 Individual Coding Plan 下是 `subscription`、在 Start Plan 下
 * 是 `promotion`。契约要求 `modelId` 唯一，如果按裸 modelId 去重，就必须给同一个 id 塞一个
 * 计费类别，那等于替用户在两种权益之间随便挑一个。把 id 限定成 `providerId::modelId` 是
 * **唯一能让契约与事实同时成立**的做法，也把"这个额度从哪个套餐出"显式带进 id。
 *
 * @param source builtin 源（已擦除）
 * @returns `DriverCatalog`；形状与 `/v1/zcc/catalog` 完全一致
 */
export function mapBuiltinToCatalog(source: PlanSourceDocument): DriverCatalog {
  const doc = (source.document ?? null) as BuiltinDocument | null;
  const modelRules = readModelRules(doc);
  const enabled = readEnablement(doc);
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const rule of readProviderRules(doc)) {
    const providerId = rule?.providerId;
    if (!nonEmptyString(providerId)) continue;
    const config = isPlainObject(rule.config) ? rule.config : {};
    const access = isPlainObject(config['access']) ? config['access'] : {};
    const billingClass = mapAccessModeToBillingClass(access['mode']);
    const providerName = nonEmptyString(rule.providerName) ? rule.providerName.trim() : providerId;
    const declared = Array.isArray(config['builtinModelIds']) ? (config['builtinModelIds'] as unknown[]) : [];
    for (const rawModelId of declared) {
      if (!nonEmptyString(rawModelId)) continue;
      const modelId = rawModelId.trim();
      if (enabled.get(`${providerId}\u0000${modelId}`) !== true) continue;
      const resolved = resolveModelProperties(modelRules, modelId);
      if (!resolved.enabled) continue;
      const offeringId = `${providerId}${OFFERING_ID_SEPARATOR}${modelId}`;
      if (seen.has(offeringId)) continue;
      seen.add(offeringId);
      models.push({
        modelId: offeringId,
        displayName: `${modelId} · ${providerName}`,
        provider: providerId,
        billingClass,
        contextLength: resolved.contextWindow,
        reasoning: [...resolved.reasoning],
        capabilities: [...resolved.capabilities]
      });
    }
  }
  return { revision: deriveCatalogRevision(doc), models };
}

/* -------------------------------------------------------------------------- */
/* planStatus                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `account:*` providerId → coding-plan-cache 里的 `builtin:*` 缓存键。
 *
 * 证据：E1R §3.3 引 `out/preload/resourceManager.cjs` @602,400 的字面量映射
 * ```js
 * var Un={"builtin:bigmodel":"bigmodel-api","builtin:zai":"zai-api",
 *   "builtin:bigmodel-start-plan":"account:bigmodel-start-plan",
 *   "builtin:zai-start-plan":"account:zai-start-plan",
 *   "builtin:bigmodel-coding-plan":"account:bigmodel-individual-coding-plan",
 *   "builtin:zai-coding-plan":"account:zai-individual-coding-plan"};
 * ```
 * 只有这四个。团队套餐与 off-peak 套餐**没有**缓存键，所以它们的可用性只能落
 * `unknown`——这正是"不外推"的具体含义。
 */
export const CACHE_KEY_BY_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  'account:zai-start-plan': 'builtin:zai-start-plan',
  'account:bigmodel-start-plan': 'builtin:bigmodel-start-plan',
  'account:zai-individual-coding-plan': 'builtin:zai-coding-plan',
  'account:bigmodel-individual-coding-plan': 'builtin:bigmodel-coding-plan'
});

export type PlanAvailability = 'available' | 'unavailable' | 'unknown';
export type PlanAvailabilitySource = 'coding-plan-cache' | 'no-cache-entry' | 'cache-absent';

export interface PlanStatus {
  readonly providerId: string;
  readonly providerName: string;
  readonly group: string | null;
  /** `access.mode` 原值；缺失时为 `null`（不编造一个）。 */
  readonly kind: string | null;
  readonly accountType: string | null;
  readonly billingClass: CatalogBillingClass;
  /** `visibility === 'hidden'` 的套餐在官方 UI 里不可见，这里如实标出。 */
  readonly visible: boolean;
  /** 当前 `providerFamilyDomain` 域里，用户选中的就是这一档吗。 */
  readonly selected: boolean;
  readonly availability: PlanAvailability;
  readonly unavailableReason: string | null;
  readonly availabilitySource: PlanAvailabilitySource;
  readonly availabilitySourceFile: string | null;
  /** 缓存快照的时间戳。这是**唯一的时效锚点**。 */
  readonly availabilityObservedAt: number | null;
  readonly selectionSourceFile: string | null;
  readonly selectionObservedAt: number | null;
  /** 该套餐在目录里真实提供的模型（裸 modelId，不是限定 id）。 */
  readonly modelIds: readonly string[];
}

export interface BuildPlanStatusOptions {
  readonly sources: PlanSources;
  readonly catalog: DriverCatalog;
}

function readSelection(sources: PlanSources): { domain: string | null; selections: Readonly<Record<string, { kind?: unknown }>>; updatedAt: number | null } {
  const doc = (sources.setting.document ?? null) as SettingDocument | null;
  const domain = nonEmptyString(doc?.providerFamilyDomain) ? doc.providerFamilyDomain.trim() : null;
  const raw = doc?.providerFamilyConnectionSelections;
  const selections: Record<string, { kind?: unknown }> = isPlainObject(raw) ? (raw as Record<string, { kind?: unknown }>) : {};
  const updatedAt = typeof doc?.providerFamilyDomainUpdatedAt === 'number' ? doc.providerFamilyDomainUpdatedAt : null;
  return { domain, selections, updatedAt };
}

function readCacheItems(sources: PlanSources): {
  items: Readonly<Record<string, { status?: unknown; reason?: unknown }>>;
  updatedAt: number | null;
} {
  const doc = (sources.cache.document ?? null) as CacheDocument | null;
  const raw = doc?.entryStatus?.items;
  const items = isPlainObject(raw) ? (raw as Record<string, { status?: unknown; reason?: unknown }>) : {};
  const updatedAt = typeof doc?.entryStatus?.updatedAt === 'number' ? doc.entryStatus.updatedAt : null;
  return { items, updatedAt };
}

/**
 * 产出每个套餐的 planStatus。
 *
 * 三个来源各管一件事，互不越界：
 *  - **目录**（builtin）：套餐存在吗、叫什么、属于哪个 group、mode 是什么、hidden 吗。
 *  - **当前选择**（setting）：`providerFamilyDomain` 是哪个域、该域选的是哪一档。
 *  - **可用性**（coding-plan-cache）：某一时刻 refresh 返回的 available / unavailable + 原因。
 *
 * 缓存没有对应键、缓存文件缺失、状态值不认识 —— 三种情况都落 `unknown` 并在
 * `availabilitySource` / `unavailableReason` 里说明是哪一种。不猜、不外推。
 *
 * @param options 三个已读源 + 目录
 * @returns 每个 providerRule 一条
 */
export function buildPlanStatuses(options: BuildPlanStatusOptions): PlanStatus[] {
  const { sources, catalog } = options;
  const doc = (sources.builtin.document ?? null) as BuiltinDocument | null;
  const { domain, selections, updatedAt } = readSelection(sources);
  const { items, updatedAt: cacheUpdatedAt } = readCacheItems(sources);

  const modelIdsByProvider = new Map<string, string[]>();
  for (const entry of catalog.models) {
    const list = modelIdsByProvider.get(entry.provider) ?? [];
    list.push(splitOfferingId(entry.modelId).modelId);
    modelIdsByProvider.set(entry.provider, list);
  }

  return readProviderRules(doc).map((rule) => {
    const providerId = nonEmptyString(rule?.providerId) ? rule.providerId.trim() : '';
    const config = isPlainObject(rule.config) ? rule.config : {};
    const access = isPlainObject(config['access']) ? config['access'] : {};
    const kind = nonEmptyString(access['mode']) ? access['mode'].trim() : null;
    const accountType = nonEmptyString(access['accountType']) ? access['accountType'].trim() : null;

    // 选择是**按族**记的：setting.json 里 `providerFamilyConnectionSelections[domain].kind`
    // 只说"这个域选了哪一档"，必须同时满足 accountType === domain 才算选中这一条 providerRule。
    // 少了 accountType 这一半，zai 域选的 individual-coding-plan 会把 bigmodel 域的同名档位
    // 一起标成"已选"——那是把两个不同供应商的套餐混成一条。
    const selectedKind = domain === null ? undefined : selections[domain]?.kind;
    const selected =
      domain !== null && accountType === domain && kind !== null && nonEmptyString(selectedKind) && selectedKind === kind;

    const cacheKey = CACHE_KEY_BY_PROVIDER[providerId];
    const cacheItem = cacheKey === undefined ? undefined : items[cacheKey];
    let availability: PlanAvailability = 'unknown';
    let unavailableReason: string | null = null;
    let availabilitySource: PlanAvailabilitySource;
    let availabilityObservedAt: number | null = null;
    if (!sources.cache.present) {
      availabilitySource = 'cache-absent';
      unavailableReason = 'coding_plan_cache_absent';
    } else if (cacheItem === undefined) {
      availabilitySource = 'no-cache-entry';
    } else if (cacheItem.status === 'available') {
      availability = 'available';
      availabilitySource = 'coding-plan-cache';
      availabilityObservedAt = cacheUpdatedAt;
    } else if (cacheItem.status === 'unavailable') {
      availability = 'unavailable';
      availabilitySource = 'coding-plan-cache';
      availabilityObservedAt = cacheUpdatedAt;
      unavailableReason = nonEmptyString(cacheItem.reason) ? cacheItem.reason.trim() : null;
    } else {
      availabilitySource = 'coding-plan-cache';
      availabilityObservedAt = cacheUpdatedAt;
      // 状态值不认识 → 保持 unknown，不当成 available
    }

    return {
      providerId,
      providerName: nonEmptyString(rule?.providerName) ? rule.providerName.trim() : providerId,
      group: nonEmptyString(config['group']) ? config['group'].trim() : null,
      kind,
      accountType,
      billingClass: mapAccessModeToBillingClass(kind),
      visible: config['visibility'] !== 'hidden',
      selected,
      availability,
      unavailableReason,
      availabilitySource,
      availabilitySourceFile: availabilitySource === 'coding-plan-cache' ? sources.cache.path : null,
      availabilityObservedAt,
      selectionSourceFile: sources.setting.present ? sources.setting.path : null,
      selectionObservedAt: updatedAt,
      modelIds: [...(modelIdsByProvider.get(providerId) ?? [])]
    };
  });
}

/* -------------------------------------------------------------------------- */
/* E1 证据                                                                        */
/* -------------------------------------------------------------------------- */

export interface E1EvidenceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly readAt: number;
}

export interface E1Evidence {
  readonly catalog: E1EvidenceFile & {
    readonly source: 'local-official';
    readonly schemaVersion: number | null;
    readonly documentRevision: number | null;
    readonly providerRuleCount: number;
    readonly catalogRevision: string;
    readonly catalogEntryCount: number;
  };
  readonly entitlement: E1EvidenceFile & {
    readonly source: 'coding-plan-cache';
    readonly present: boolean;
    readonly updatedAt: number | null;
    readonly items: ReadonlyArray<{ readonly cacheKey: string; readonly status: string; readonly reason: string | null }>;
  };
  readonly selection: E1EvidenceFile & {
    readonly source: 'setting';
    readonly present: boolean;
    readonly providerFamilyDomain: string | null;
    readonly domainUpdatedAt: number | null;
    readonly selections: ReadonlyArray<{ readonly domain: string; readonly kind: string }>;
  };
  /** 凭据**位置**（JSONPath）。值永不出现——见 reader.ts 的擦除说明。 */
  readonly credentialLocations: readonly string[];
  /** planStatus 条数。用来核对"目录 / 资格 / 选择"三份事实彼此对得上。 */
  readonly planCount: number;
}

/**
 * 汇总 E1 证据。**本包不定级**：只把三类来源、它们的 sha256 与时间戳如实摆出来，
 * 定级由 I06 依据这份对象决定。
 *
 * @param sources 三个已读源
 * @param catalog 目录
 * @param plans planStatus
 * @returns 证据对象（不含任何凭据值）
 */
export function buildE1Evidence(sources: PlanSources, catalog: DriverCatalog, plans: readonly PlanStatus[]): E1Evidence {
  const builtinDoc = (sources.builtin.document ?? null) as BuiltinDocument | null;
  const cacheDoc = (sources.cache.document ?? null) as CacheDocument | null;
  const { domain, selections, updatedAt } = readSelection(sources);
  const { items, updatedAt: cacheUpdatedAt } = readCacheItems(sources);

  const base = (doc: PlanSourceDocument): E1EvidenceFile => ({
    path: doc.path,
    sha256: doc.sha256,
    bytes: doc.bytes,
    readAt: doc.readAt
  });

  return {
    catalog: {
      ...base(sources.builtin),
      source: 'local-official',
      schemaVersion: typeof builtinDoc?.schemaVersion === 'number' ? builtinDoc.schemaVersion : null,
      documentRevision: typeof builtinDoc?.revision === 'number' ? builtinDoc.revision : null,
      providerRuleCount: readProviderRules(builtinDoc).length,
      catalogRevision: catalog.revision,
      catalogEntryCount: catalog.models.length
    },
    entitlement: {
      ...base(sources.cache),
      source: 'coding-plan-cache',
      present: sources.cache.present,
      updatedAt: cacheUpdatedAt,
      items: Object.entries(items).map(([cacheKey, item]) => ({
        cacheKey,
        status: typeof item?.status === 'string' ? item.status : 'unknown',
        reason: nonEmptyString(item?.reason) ? item.reason.trim() : null
      }))
    },
    selection: {
      ...base(sources.setting),
      source: 'setting',
      present: sources.setting.present,
      providerFamilyDomain: domain,
      domainUpdatedAt: updatedAt,
      selections: Object.entries(selections)
        .filter(([, value]) => nonEmptyString(value?.kind))
        .map(([key, value]) => ({ domain: key, kind: String(value.kind) }))
    },
    credentialLocations: [
      ...sources.builtin.credentialLocations,
      ...sources.setting.credentialLocations,
      ...sources.cache.credentialLocations
    ],
    planCount: plans.length
  };
}
