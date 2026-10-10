/**
 * COMPAT5：消息级**工具痕迹**从拒绝改为**兼容剥离**。
 *
 * ## 缺陷事实（真实故障，不是构造出来的）
 * MiniMax Code（BYOK 客户端）重放旧会话历史时，历史 `messages` 里带两类工具痕迹：
 *  - assistant 轮上的 `tool_calls`（OpenAI 形状，content 常常是 `null`）；
 *  - 紧跟其后的 `role:"tool"` 结果轮（还带 `tool_call_id`）。
 * 改动前 `parseMessage` 对两者一律 422（`messages[3].tool_calls 本端点不实现` /
 * `role=tool 本端点不支持`），于是**整个请求**被拒：该客户端对**任何**有工具历史的
 * 会话完全不可用。
 *
 * ## 为什么"拒绝"在这里是错的、"顶层参数拒绝"却必须留着
 * 本端点是**纯文本**端点：`DriverRequest` 上根本没有工具槽位，产出里**永不发**
 * `tool_calls`（结构事实，契约测试用静态钉守着，见 api-contract.test.mjs 的
 * "COMPAT4：`tools_forwarded: 0` 是**结构可证**的事实"）。于是：
 *  - **顶层** `tools` / `tool_choice` / `parallel_tool_calls` 是"**这一轮**要工具
 *    行为"的请求参数 → 仍然逐条 422 / 闭集接受（**本轮一条语义都不动**）；
 *  - **消息级**工具痕迹是"**过去某一轮**发生过工具调用"的历史事实 → 剥离即可，
 *    因为**这一轮**恒为纯文本，客户端**不会**等任何 `tool_calls`（它等的东西根本
 *    不存在），剥离不会让它挂起；而拒绝会直接让真客户端全线不可用。
 * 这与 COMPAT4"接受声明但不转发"同一条底层逻辑：**披露能力边界，不打断真客户端**。
 *
 * ## 剥离不是静默改写（这是与旧裁定唯一的语义分歧，必须逐条钉住）
 * 旧代码的理由是"把工具结果轮压成 user 会**静默**改变语义"。现在压成 user **仍然**
 * 会改变 role，但**改变被写进了产出可见的文本里**：
 *  - assistant 的 `tool_calls` 被剥离；若该消息 content 为空/null，填
 *    {@link TOOL_TRACE_PLACEHOLDER_CONTENT} 占位（消息**不删**、条数与顺序不变）；
 *  - `role:"tool"` 转成 `role:"user"`，content 前缀 {@link TOOL_RESULT_CONTENT_PREFIX}
 *    ——模型与客户端都能看见"这是一条工具结果"，不是被悄悄改写的 user 轮。
 *
 * ## 位置说明
 * 本文件在 `tests/unit/` 下：它同时驱动**纯函数**（`parseChatRequest` 直调）与
 * **HTTP 端到端**（fixture 驱动器，不发任何真实模型请求），零网络外联。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApiServer, FIXTURE_TEST_TOKEN } from '../../packages/api/src/server.js';
import * as chatModule from '../../packages/api/src/chat.js';
import {
  createFixtureDriver,
  FIXTURE_MODEL_ID,
  parseChatRequest,
  foldMessagesToPrompt,
  TOOLS_FORWARDED_NONE
} from '../../packages/api/src/chat.js';

/**
 * 期望的占位/前缀**逐字**文本。
 *
 * 这里刻意写成**本文件自带的字面量**（而不是直接 import 生产常量）：红的形态必须是
 * "真客户端形状被 422 挡住"这条**行为**事实，而不是"某个具名导出还不存在"的链接错误。
 * 生产常量由「钉 · 两个具名常量逐字相等」那条用例反向钉住，两者必须同时成立。
 */
const TOOL_TRACE_PLACEHOLDER_CONTENT = '[此前调用了工具，内容未纳入上下文]';
const TOOL_RESULT_CONTENT_PREFIX = '[工具结果] ';

/** 测试专用 key。**不是**任何真实凭据，只存在于本进程内；输出里绝不允许出现。 */
const TEST_KEY = 'zcc_tooltrace_test_key_0123456789abcdef';

/** 用户故障形状（逐字）：assistant 带 tool_calls 且 content 为 null，后面跟一条 role:"tool"。 */
const REPLAY_BODY = {
  model: FIXTURE_MODEL_ID,
  messages: [
    { role: 'user', content: '看一下 package.json' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', content: '{ "name": "zcode-companion" }', tool_call_id: 'call_1' },
    { role: 'assistant', content: '这个包叫 zcode-companion。' },
    { role: 'user', content: '再看看版本' }
  ]
};

/**
 * 用户故障的**第二**种形状：assistant 带 tool_calls **且**有正常 content
 * （剥离后**保留原文**，不覆盖）。
 */
const REPLAY_WITH_TEXT_BODY = {
  model: FIXTURE_MODEL_ID,
  messages: [
    { role: 'user', content: '跑一下' },
    { role: 'assistant', content: '我先看看。', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', content: 'exit 0', tool_call_id: 'c' },
    { role: 'user', content: '结果呢' }
  ]
};

/** 另一类真客户端形状：工具结果是**非字符串**（结构化 JSON），必须被文本化而不是丢。 */
const REPLAY_OBJECT_RESULT_BODY = {
  model: FIXTURE_MODEL_ID,
  messages: [
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', content: { temp: 21, sky: 'clear' }, tool_call_id: 'call_x' },
    { role: 'user', content: '谢谢' }
  ]
};

/**
 * @typedef {object} Res
 * @property {number} status
 * @property {string} text
 * @property {import('node:http').IncomingHttpHeaders} headers
 */

/**
 * 取第 i 条消息。越界**立刻**抛错，而不是让断言读到 `undefined` 再报一条假绿。
 *
 * tsconfig 开着 `noUncheckedIndexedAccess`，所以下标访问一律走这里。
 *
 * @param {readonly import('../../packages/api/src/chat.js').ParsedMessage[]} messages
 * @param {number} index
 * @returns {import('../../packages/api/src/chat.js').ParsedMessage}
 */
function pick(messages, index) {
  const message = messages[index];
  if (message === undefined) throw new Error(`messages[${String(index)}] 越界（长度 ${String(messages.length)}）`);
  return message;
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
  return JSON.parse(text);
}

/**
 * @param {{port: number, headers?: Record<string, string>, body: unknown}} opts
 * @returns {Promise<Res>}
 */
function authed(opts) {
  const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
  const headers = {
    authorization: `Bearer ${TEST_KEY}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    ...opts.headers
  };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: opts.port, method: 'POST', path: '/v1/chat/completions', headers },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * @typedef {object} Harness
 * @property {number} port
 * @property {import('../../packages/api/src/server.js').ApiServer} server
 */

/** @type {Harness} */
let harness;

beforeAll(async () => {
  const server = createApiServer({
    enabled: true,
    port: 0,
    apiKeys: [TEST_KEY],
    driver: createFixtureDriver(),
    testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  });
  const started = await server.start();
  if (!started.started || started.port === undefined) {
    throw new Error(`server did not start: ${JSON.stringify(started)}`);
  }
  harness = { port: started.port, server };
});

afterAll(async () => {
  await harness.server.stop();
});

/** 每次请求一个独立幂等作用域，避免 409 干扰本文件的判定。 */
let seq = 0;
/**
 * @param {unknown} body
 * @returns {Promise<Res>}
 */
function postUnique(body) {
  seq += 1;
  return authed({ port: harness.port, headers: { 'x-zcc-session-id': `tooltrace-${String(seq)}` }, body });
}

/* -------------------------------------------------------------------------- */
/* 1. 靶点：用户故障形状从 422 变 200（红→绿的那条命令）                          */
/* -------------------------------------------------------------------------- */

describe('COMPAT5 · 旧会话历史里的工具痕迹不再整条 422', () => {
  it('靶点：assistant(tool_calls, content:null) + role:"tool" 的多轮重放请求 → 200', async () => {
    const res = await postUnique(REPLAY_BODY);
    // 改前：422（`messages[1].tool_calls 本端点不实现` / `messages[2].role`）。
    // 改后：整条请求**正常出结果**，客户端对旧会话重新可用。
    expect(res.status).toBe(200);
    const body = parseJson(res.text);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    // 本端点是纯文本端点：产出里**永远**不含工具调用（本轮语义没变）。
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(typeof body.choices[0].message.content).toBe('string');
    expect(body.choices[0].message.content.length).toBeGreaterThan(0);
  });

  it('钉 · 剥离后的占位文本存在，且 assistant 有原文时**不被覆盖**', () => {
    const parsed = parseChatRequest(REPLAY_BODY);
    const assistantWithTrace = pick(parsed.messages, 1);
    expect(assistantWithTrace).toEqual({ role: 'assistant', content: TOOL_TRACE_PLACEHOLDER_CONTENT });
    // 占位文本是**写进上下文**的可见标记，不是静默丢弃。
    expect(assistantWithTrace.content).toContain('此前调用了工具');
    // 另一形状：content 非空 → 原样保留，`tool_calls` 只被剥掉。
    const withText = parseChatRequest(REPLAY_WITH_TEXT_BODY);
    expect(pick(withText.messages, 1)).toEqual({ role: 'assistant', content: '我先看看。' });
  });

  it('钉 · role:"tool" 转 user 并带前缀，tool_call_id 随之消失', () => {
    const parsed = parseChatRequest(REPLAY_BODY);
    const toolTurn = pick(parsed.messages, 2);
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.content.startsWith(TOOL_RESULT_CONTENT_PREFIX)).toBe(true);
    expect(toolTurn.content).toBe(`${TOOL_RESULT_CONTENT_PREFIX}{ "name": "zcode-companion" }`);
    // `tool_call_id` 不再是任何下游可见字段（消息形状只有 role + content）。
    expect(Object.keys(toolTurn).sort()).toEqual(['content', 'role']);
    // 非字符串工具结果：JSON 文本化，**不丢内容**。
    const objectResult = pick(parseChatRequest(REPLAY_OBJECT_RESULT_BODY).messages, 2);
    expect(objectResult.role).toBe('user');
    expect(objectResult.content).toContain('"temp":21');
  });

  it('钉 · messages 总数与角色序列不变（不删轮、不重排）', () => {
    const parsed = parseChatRequest(REPLAY_BODY);
    expect(parsed.messages).toHaveLength(REPLAY_BODY.messages.length);
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    // 折叠后的 prompt 里两条工具痕迹都**看得见**（占位 / 前缀都在行内）。
    const prompt = foldMessagesToPrompt(parsed.messages);
    expect(prompt).toContain(TOOL_TRACE_PLACEHOLDER_CONTENT);
    expect(prompt).toContain(TOOL_RESULT_CONTENT_PREFIX);
    // 顺序原样保留：工具结果轮没有被提到最后。
    expect(prompt.indexOf('此前调用了工具')).toBeLessThan(prompt.indexOf('这个包叫'));
  });

  it('钉 · 两条占位文本由生产源码导出并与本文件的字面量逐字相等', () => {
    // 本文件顶部用的是**自带字面量**（为了让红是行为红）；生产侧必须导出**同一个**常量，
    // 否则"文档里写的标记"与"代码里实际写的标记"就会漂移。
    const module = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (chatModule));
    expect(module['TOOL_TRACE_PLACEHOLDER_CONTENT']).toBe(TOOL_TRACE_PLACEHOLDER_CONTENT);
    expect(module['TOOL_RESULT_CONTENT_PREFIX']).toBe(TOOL_RESULT_CONTENT_PREFIX);
    // 占位文本自带一句可读说明（"内容未纳入上下文"），前缀自带角色标记（"[工具结果] "）。
    expect(String(module['TOOL_TRACE_PLACEHOLDER_CONTENT'])).toContain('内容未纳入上下文');
    expect(String(module['TOOL_RESULT_CONTENT_PREFIX']).endsWith(' ')).toBe(true);
  });

  it('钉 · 驱动侧收到的 DriverRequest 已经是剥离后的形状（工具痕迹不进入上游）', async () => {
    /** @type {Array<Array<{ role: string; content: string }>>} */
    const seen = [];
    const inner = createFixtureDriver();
    /** @type {import('../../packages/api/src/server.js').ApiServer} */
    const server = createApiServer({
      enabled: true,
      port: 0,
      apiKeys: [TEST_KEY],
      driver: {
        ...inner,
        /**
         * @param {import('../../packages/api/src/chat.js').DriverRequest} req
         */
        stream(req) {
          seen.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
          return inner.stream(req);
        }
      },
      testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    });
    const started = await server.start();
    try {
      if (!started.started || started.port === undefined) throw new Error('server did not start');
      const res = await authed({ port: started.port, headers: { 'x-zcc-session-id': 'strip-1' }, body: REPLAY_BODY });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      const messages = seen[0] ?? [];
      expect(messages).toHaveLength(REPLAY_BODY.messages.length);
      // 驱动侧**没有** `tool` role 的消息（已转 user），也没有任何 tool_calls 痕迹。
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    } finally {
      await server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 回归钉：顶层参数拒绝语义一条不许动                                          */
/* -------------------------------------------------------------------------- */

describe('COMPAT5 · 顶层参数拒绝语义未被顺带放宽', () => {
  it('回归 · 顶层 `tools` 畸形形状仍 422 unsupported_parameter（COMPAT4 语义原样）', async () => {
    // 非数组：`tools: 1` 与 `tools: null` 仍逐条 422 并指名 `tools`。
    for (const tools of [1, null, 'nope', {}]) {
      const res = await postUnique({ model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], tools });
      expect(res.status, JSON.stringify(tools)).toBe(422);
      const parsed = parseJson(res.text);
      expect(parsed.error.code, JSON.stringify(tools)).toBe('unsupported_parameter');
      expect(parsed.error.param, JSON.stringify(tools)).toBe('tools');
    }
    // 畸形声明项仍逐条指名下标。
    const badItem = await postUnique({
      model: FIXTURE_MODEL_ID,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function' }, {}]
    });
    expect(badItem.status).toBe(422);
    expect(parseJson(badItem.text).error.param).toBe('tools[1]');
  });

  it('回归 · `tool_choice` / `parallel_tool_calls` / `functions` / `function_call` 仍逐条 422', async () => {
    for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
      ['tool_choice', 'required'],
      ['tool_choice', 'any'],
      ['tool_choice', { type: 'function', function: { name: 'f' } }],
      ['parallel_tool_calls', true],
      ['parallel_tool_calls', false],
      ['functions', []],
      ['function_call', 'auto'],
      ['function_call', 'none']
    ])) {
      const res = await postUnique({ model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], [key]: value });
      expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(422);
      const parsed = parseJson(res.text);
      expect(parsed.error.code, key).toBe('unsupported_parameter');
      expect(parsed.error.param, key).toBe(key);
    }
  });

  it('回归 · tools_received / tools_forwarded 计数语义未变（剥离历史不影响声明计数）', async () => {
    // 旧会话重放**同时**带 26 项声明时：声明照收、转发恒 0，历史痕迹剥离不参与计数。
    const tools = Array.from({ length: 26 }, (_, i) => ({ type: 'function', function: { name: `t${String(i)}` } }));
    const res = await postUnique({ ...REPLAY_BODY, tools });
    expect(res.status).toBe(200);
    const zcc = parseJson(res.text).zcc;
    expect(zcc.tools_received).toBe(26);
    expect(zcc.tools_forwarded).toBe(TOOLS_FORWARDED_NONE);
    expect(zcc.tools_forwarded).toBe(0);
    // 消息级剥离**没有**新增/改动任何顶层披露键（整张 `zcc` 键集逐字钉死）。
    expect(Object.keys(zcc).sort()).toEqual(
      [
        'auto_resend_allowed',
        'driver',
        'fixture',
        'idempotency',
        'max_tokens_enforced',
        'model_is_real',
        'parameters_not_forwarded',
        'reasoning_effort_applied',
        'roles_folded',
        'status',
        'tool_choice_received',
        'tools_forwarded',
        'tools_received',
        'usage_method'
      ].sort()
    );
  });

  it('回归 · reasoning 闭集未变（不受影响）', async () => {
    const bad = await postUnique({ model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'ultra' });
    expect(bad.status).toBe(422);
    expect(parseJson(bad.text).error.param).toBe('reasoning_effort');
    const ok = await postUnique({ model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'high' });
    expect(ok.status).toBe(200);
    expect(parseJson(ok.text).zcc.reasoning_effort_applied).toBe('high');
  });

  it('回声 · messages[].reasoning_content 接受并剥离（2026-10-11：本端点思考流的回传）', async () => {
    // 客户端按 OpenAI 惯例把上一轮 assistant 消息原样回传，历史里带着我们产出的
    // reasoning_content（实录 messages[69] 422）。剥离不占位：同轮 content 完整在场。
    const res = await postUnique({
      model: FIXTURE_MODEL_ID,
      messages: [
        { role: 'assistant', content: '上轮正文', reasoning_content: '上轮思考全文……' },
        { role: 'user', content: '继续' }
      ]
    });
    expect(res.status).toBe(200);
    const zcc = parseJson(res.text).zcc;
    // 剥离是接受不是未转发参数：不该出现在披露表里（参数表只管顶层参数）。
    expect(zcc.parameters_not_forwarded).not.toContain('reasoning_content');
  });

  it('回归 · 其它消息级拒绝字段一条没被顺带放宽（name / function_call / refusal / audio）', async () => {
    for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
      ['name', 'bob'],
      ['function_call', { name: 'f' }],
      ['refusal', null],
      ['audio', { id: 'a' }]
    ])) {
      const res = await postUnique({
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'assistant', content: 'x', [key]: value }]
      });
      expect(res.status, key).toBe(422);
      const parsed = parseJson(res.text);
      expect(parsed.error.code, key).toBe('unsupported_parameter');
      expect(parsed.error.param, key).toBe(`messages[0].${key}`);
    }
    // 未知的消息级字段仍 400 unknown_field（不是"接受一切"）。
    const unknown = await postUnique({
      model: FIXTURE_MODEL_ID,
      messages: [{ role: 'user', content: 'x', definitely_unknown: 1 }]
    });
    expect(unknown.status).toBe(400);
    expect(parseJson(unknown.text).error.code).toBe('unknown_field');
  });

  it('回归 · role="function" 及其余一切 role 仍 422 unsupported_role（只放开 tool 一档）', async () => {
    for (const role of ['function', 'Tool', 'System', 'Developer', '', 'user ', 'assistant ', 'model']) {
      const res = await postUnique({ model: FIXTURE_MODEL_ID, messages: [{ role, content: 'x' }] });
      expect(res.status, JSON.stringify(role)).toBe(422);
      const parsed = parseJson(res.text);
      expect(parsed.error.code, JSON.stringify(role)).toBe('unsupported_role');
      expect(parsed.error.param, JSON.stringify(role)).toBe('messages[0].role');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 回归钉：普通多轮 / 纯单轮 / 指令折叠完全不变                                */
/* -------------------------------------------------------------------------- */

describe('COMPAT5 · 无工具痕迹的请求逐字不变', () => {
  it('回归 · 纯单轮：messages 原样、占位/前缀一条都不出现', async () => {
    const res = await postUnique({ model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: '你好' }] });
    expect(res.status).toBe(200);
    const body = parseJson(res.text);
    expect(body.zcc.tools_received).toBe(0);
    expect(body.zcc.tools_forwarded).toBe(0);
    expect(body.zcc.tool_choice_received).toBeNull();
    expect(body.zcc.roles_folded).toEqual([]);
    // fixture 驱动器回显最后一条 user 原文，且**没有**任何工具标记。
    expect(body.choices[0].message.content).toContain('fixture_echo: 你好');
    expect(body.choices[0].message.content).not.toContain(TOOL_TRACE_PLACEHOLDER_CONTENT);
    expect(body.choices[0].message.content).not.toContain(TOOL_RESULT_CONTENT_PREFIX);
  });

  it('回归 · 普通多轮（含 developer 折叠）逐字不变', async () => {
    const body = {
      model: FIXTURE_MODEL_ID,
      messages: [
        { role: 'developer', content: '系统提示词' },
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二轮' }
      ]
    };
    const res = await postUnique(body);
    expect(res.status).toBe(200);
    const parsed = parseJson(res.text);
    expect(parsed.zcc.roles_folded).toEqual(['developer']);
    expect(parsed.zcc.parameters_not_forwarded).toEqual([]);
    const normalized = parseChatRequest(body).messages.map((m) => `${m.role}:${m.content}`);
    expect(normalized).toEqual(['developer:系统提示词', 'user:第一轮', 'assistant:第一答', 'user:第二轮']);
  });

  it('回归 · 纯解析期（不经过 HTTP）同样判定：工具痕迹被剥离、其余校验一条不动', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    // 剥离路径不抛错。
    expect(() =>
      parseChatRequest({
        ...base,
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f' } }] },
          { role: 'tool', content: 'r', tool_call_id: 'c' }
        ]
      })
    ).not.toThrow();
    // 顶层拒绝仍逐条生效（解析期直调，与 HTTP 同源）。
    expect(() => parseChatRequest({ ...base, parallel_tool_calls: true })).toThrow();
    expect(() => parseChatRequest({ ...base, tool_choice: 'required' })).toThrow();
    // 消息级其它拒绝字段仍抛。
    expect(() => parseChatRequest({ ...base, messages: [{ role: 'user', content: 'x', name: 'bob' }] })).toThrow();
    // tool_calls 剥离后**不改变**消息条数：指纹里也认得出这条消息（内容不同）。
    const stripped = parseChatRequest(REPLAY_BODY);
    expect(stripped.messages).toHaveLength(REPLAY_BODY.messages.length);
  });

  it('回归 · 凭据形态不进日志与响应（沿用本仓既有纪律）', async () => {
    const res = await postUnique(REPLAY_BODY);
    expect(res.text).not.toContain(TEST_KEY);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});