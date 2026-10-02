/**
 * official-tap-core.test.mjs — tap 纯逻辑层的单测。
 *
 * 覆盖工单点名的四个可单测纯函数：argv 切分、id 命名空间匹配、白名单判定、
 * 帧路由决策；外加旁路行扫描器、回环判定、子进程环境、控制令牌与诊断字段净化。
 * 这一层不 spawn 任何进程，全部是纯函数断言。
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_CHANNEL_PREFIX,
  BLOCKED_CHANNEL_IDS,
  CONTROL_DEFAULT_PORT,
  CONTROL_MAX_LINE_BYTES,
  DIAG_FIELD_ALLOWLIST,
  MAX_INJECT_LINE_BYTES,
  MAX_SCAN_LINE_BYTES,
  OFFICIAL_REQUEST_ID_SCHEMA_NOTE,
  OFFICIAL_REQUEST_TOP_LEVEL_KEYS,
  TAP_ID_PREFIX,
  NdjsonLineScanner,
  buildChildEnv,
  buildOfficialRequestLine,
  classifyChildFrame,
  collectChannelTokens,
  evaluateInjectPolicy,
  isLoopbackAddress,
  isNamespacedId,
  isUsableControlToken,
  parseTapArgv,
  resolveControlToken,
  sanitizeDiagFields,
  validateOfficialRequestFrame
} from '../../scripts/official-tap/tap-core.mjs';
import { parseInstallArgs } from '../../scripts/official-tap/install-tap.mjs';

describe('argv 切分（官方钩子的 spawn 形状）', () => {
  it('以第一个 -- 为界，-- 之后原样交给真实命令', () => {
    const result = parseTapArgv([
      '--workspace-key',
      'K',
      '--log-dir',
      'C:/x/y',
      '--',
      'C:/ZCode/ZCode.exe',
      'C:/x/zcode.cjs',
      'app-server',
      '--stdio',
      '--surface',
      'desktop'
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.command).toBe('C:/ZCode/ZCode.exe');
    expect(result.parsed.args).toEqual(['C:/x/zcode.cjs', 'app-server', '--stdio', '--surface', 'desktop']);
    expect(result.parsed.workspaceKey).toBe('K');
    expect(result.parsed.logDir).toBe('C:/x/y');
    expect(result.parsed.controlPort).toBe(CONTROL_DEFAULT_PORT);
  });

  it('第二个 -- 属于真实命令的参数，不被当成边界', () => {
    const result = parseTapArgv(['--workspace-key', 'K', '--', 'node', 'app.js', '--', '--log-dir']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.args).toEqual(['app.js', '--', '--log-dir']);
  });

  it('缺少分界符 / 缺少命令 / 未知选项 / 重复选项 / 缺值 / 非法端口都拒绝', () => {
    const cases = [
      [['--workspace-key', 'K'], 'missing_boundary'],
      [['--', ], 'missing_command'],
      [['--nope', 'x', '--', 'node'], 'unknown_option'],
      [['--workspace-key', 'a', '--workspace-key', 'b', '--', 'node'], 'duplicate_option'],
      [['--log-dir', '--', 'node'], 'missing_value'],
      [['--control-port', '0x10', '--', 'node'], 'bad_port'],
      [['--control-port', '70000', '--', 'node'], 'bad_port'],
      [['--control-port', '1e3', '--', 'node'], 'bad_port'],
      [['--control-port', '1e3', '--', 'node'], 'bad_port']
    ];
    for (const [argv, code] of cases) {
      const result = parseTapArgv(/** @type {string[]} */ (argv));
      expect(result.ok, JSON.stringify(argv)).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, JSON.stringify(argv)).toBe(code);
    }
  });

  it('支持带空格的值（日志目录是 Windows 路径）', () => {
    const result = parseTapArgv(['--log-dir', 'C:/Users/someone/.zcode/v2/dev/stdio-traffic', '--', 'node']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.logDir).toBe('C:/Users/someone/.zcode/v2/dev/stdio-traffic');
  });
});

describe('安装脚本参数', () => {
  it('默认 taproot 与 8791 端口，可覆盖', () => {
    const base = parseInstallArgs([]);
    expect('taproot' in base && base.taproot).toBe('C:\\zcode-taproot');
    expect('port' in base && base.port).toBe(8791);
    const custom = parseInstallArgs(['--taproot', 'D:/other', '--port', '9999', '--dry-run']);
    expect('taproot' in custom && custom.taproot).toBe('D:/other');
    expect('port' in custom && custom.port).toBe(9999);
    expect('dryRun' in custom && custom.dryRun).toBe(true);
    expect('error' in parseInstallArgs(['--nope'])).toBe(true);
  });
});

describe('id 命名空间隔离', () => {
  it('只有带前缀的非空字符串才算我们的 id', () => {
    expect(isNamespacedId('zcc-tap-1')).toBe(true);
    expect(isNamespacedId(TAP_ID_PREFIX)).toBe(false);
    expect(isNamespacedId('zcode-cred-7')).toBe(false);
    expect(isNamespacedId(1)).toBe(false);
    expect(isNamespacedId(null)).toBe(false);
    expect(isNamespacedId(undefined)).toBe(false);
  });
});

describe('官方请求帧形状（B1：`.strict()` 键集合）', () => {
  it('键集合就是官方 zcodeProtocolRequestSchema 的四个键，且不含 jsonrpc', () => {
    expect([...OFFICIAL_REQUEST_TOP_LEVEL_KEYS]).toEqual(['id', 'method', 'params', 'trace']);
    expect(OFFICIAL_REQUEST_TOP_LEVEL_KEYS.includes('jsonrpc')).toBe(false);
    expect(OFFICIAL_REQUEST_TOP_LEVEL_KEYS.includes('result')).toBe(false);
    expect(OFFICIAL_REQUEST_TOP_LEVEL_KEYS.includes('error')).toBe(false);
  });

  it('字符串 id 合法——依据被钉在代码里（zcodeProtocolRequestIdSchema = string | int）', () => {
    // 这条例证写在 tap-core.mjs 的注释与这个常量里，指到具体文件行号列，
    // 免得"字符串 id 能不能用"以后又变成一个靠记忆的假设。
    expect(OFFICIAL_REQUEST_ID_SCHEMA_NOTE).toContain('zcodeProtocolRequestIdSchema');
    expect(OFFICIAL_REQUEST_ID_SCHEMA_NOTE).toContain('zcode.cjs:72');
    expect(validateOfficialRequestFrame({ id: 'zcc-tap-1', method: 'a/b' }).ok).toBe(true);
    expect(validateOfficialRequestFrame({ id: 1, method: 'a/b' }).ok).toBe(true);
  });

  it('jsonrpc（或任何官方键集合外的顶层键）一律拒收，并指名 offending 键', () => {
    for (const key of ['jsonrpc', 'result', 'error', 'meta', 'JSONRPC']) {
      const verdict = validateOfficialRequestFrame({ [key]: 'x', id: 'zcc-tap-1', method: 'a/b' });
      expect(verdict.ok, key).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code, key).toBe('invalid_frame_shape');
      expect(verdict.field, key).toBe(`frame.${key}`);
      expect(verdict.matched, key).toBeNull();
    }
  });

  it('id / method 不合法也拒收', () => {
    const bad = [
      { method: 'a/b' }, // 缺 id
      { id: 1.5, method: 'a/b' }, // 非整数
      { id: null, method: 'a/b' },
      { id: {}, method: 'a/b' },
      { id: 'zcc-tap-1' }, // 缺 method
      { id: 'zcc-tap-1', method: '' },
      { id: 'zcc-tap-1', method: '   ' }, // 官方是 m.string().trim().min(1)
      { id: 'zcc-tap-1', method: 42 }
    ];
    for (const frame of bad) {
      const verdict = validateOfficialRequestFrame(frame);
      expect(verdict.ok, JSON.stringify(frame)).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code, JSON.stringify(frame)).toBe('invalid_frame_shape');
    }
    // 非对象帧是 unparsable_frame（另一个码），不是 invalid_frame_shape。
    for (const frame of [null, 42, 'x', [1, 2]]) {
      const verdict = validateOfficialRequestFrame(frame);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code).toBe('unparsable_frame');
    }
  });

  it('空字符串 id 是官方 schema 接受、但被 tap 命名空间规则拒绝的（分层不混淆）', () => {
    // 官方 `zcodeProtocolRequestIdSchema = m.string() | m.number().int()` 里的
    // `m.string()` 没有 min(1)，所以空串在官方看来合法。把它算作"形状不合法"
    // 会让这一层**比官方更严**，那不是形状校验该干的事——tap 自己的更严规则
    // （`zcc-tap-` 前缀且非空）由 `isNamespacedId` 在控制通道层强制。
    expect(validateOfficialRequestFrame({ id: '', method: 'a/b' }).ok).toBe(true);
    expect(isNamespacedId('')).toBe(false);
    expect(isNamespacedId('zcc-tap-')).toBe(false);
  });

  it('buildOfficialRequestLine 输出的是重建后的投影：键序固定、只有官方键', () => {
    const built = buildOfficialRequestLine({
      method: 'a/b',
      trace: { traceId: 't' },
      params: { model: 'account:plan' },
      id: 'zcc-tap-1'
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // 键序是官方 schema 的声明序，不是调用方给的顺序。
    expect(built.line).toBe('{"id":"zcc-tap-1","method":"a/b","params":{"model":"account:plan"},"trace":{"traceId":"t"}}\n');
    expect(Object.keys(JSON.parse(built.line))).toEqual(['id', 'method', 'params', 'trace']);
    expect(built.line).not.toContain('jsonrpc');
  });

  it('大小边界：恰好 1 MiB 接受，1 MiB + 1 拒绝（1 MiB 是本通道自选的保守界，非对齐官方强制上限）', () => {
    expect(MAX_INJECT_LINE_BYTES).toBe(1024 * 1024);
    /** @param {number} bytes */
    const at = (bytes) => {
      const probe = { id: 'zcc-tap-x', method: 'a/b', params: { pad: '' } };
      const pad = bytes - JSON.stringify(probe).length - 1;
      return { ...probe, params: { pad: 'x'.repeat(pad) } };
    };
    const ok = buildOfficialRequestLine(at(MAX_INJECT_LINE_BYTES));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.bytes).toBe(MAX_INJECT_LINE_BYTES);
    const over = buildOfficialRequestLine(at(MAX_INJECT_LINE_BYTES + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('frame_too_large');
    // 形状不合法时优先报形状错误（不先被大小掩盖）。
    expect(buildOfficialRequestLine({ jsonrpc: '2.0', id: 'zcc-tap-x', method: 'a/b' }).ok).toBe(false);
  });

  it('超界回执的 detail 只陈述本通道自设的上限，不引证"对齐官方强制上限"（TAPN / N2）', () => {
    // 这条文案是**发给控制端的运行时输出**，比注释更容易被当成权威依据，所以它的
    // 方向必须准。TAPFIX3 / P3 只更正了注释层，产品层这一句当时还留着被更正掉的
    // 说法（"超过官方 maxFrameBytes 上限"）——那是**错的**：`fc.maxFrameBytes` 只用在
    // 官方**出站**物理信封/分片组装那一侧，官方**入站**读取器没有任何行长守卫。
    const probe = { id: 'zcc-tap-x', method: 'a/b', params: { pad: '' } };
    const pad = MAX_INJECT_LINE_BYTES + 1 - JSON.stringify(probe).length - 1;
    const over = buildOfficialRequestLine({ ...probe, params: { pad: 'x'.repeat(pad) } });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    const detail = over.detail;
    expect(typeof detail).toBe('string');
    // **正向**：说清了两件事——上限是多少、这是我们自选的保守界。
    expect(detail).toContain(String(MAX_INJECT_LINE_BYTES));
    expect(detail).toContain('本通道自设');
    expect(detail).toContain('保守');
    // **反向**：不得再出现任何"对齐官方/官方上限"这类引证表述。
    expect(detail).not.toContain('官方');
    expect(detail).not.toContain('maxFrameBytes');
    expect(detail).not.toContain('对齐');
  });

  it('控制通道上限大于注入上限（否则界内帧永远过不了控制层）', () => {
    expect(CONTROL_MAX_LINE_BYTES).toBeGreaterThan(MAX_INJECT_LINE_BYTES);
  });
});

describe('出站白名单（默认拒绝）', () => {
  it('工单点名的五个付费通道 id 一律拒绝', () => {
    expect([...BLOCKED_CHANNEL_IDS]).toEqual([
      'bigmodel-api',
      'zai-api',
      'zai-standard-api',
      'builtin:bigmodel',
      'builtin:zai'
    ]);
    for (const blocked of BLOCKED_CHANNEL_IDS) {
      const verdict = evaluateInjectPolicy({ id: 'zcc-tap-x', params: { model: blocked } });
      expect(verdict.ok, blocked).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code, blocked).toBe('blocked_channel');
      expect(verdict.matched, blocked).toBe(blocked);
      expect(verdict.field, blocked).toBe('params.model');
    }
  });

  it('account: 前缀放行', () => {
    const verdict = evaluateInjectPolicy({
      id: 'zcc-tap-1',
      method: 'session/prompt',
      params: { model: 'account:bigmodel-individual-coding-plan' }
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.channel).toBe('account:bigmodel-individual-coding-plan');
    expect(verdict.channel.startsWith(ALLOWED_CHANNEL_PREFIX)).toBe(true);
  });

  it('任何非 account: 前缀的通道标识都拒绝（不只黑名单那五个）', () => {
    for (const id of ['bigmodel', 'zai', 'openai-api', 'accountless', 'api-key-lane', 'xai-api']) {
      const verdict = evaluateInjectPolicy({ id: 'zcc-tap-1', params: { model: id } });
      expect(verdict.ok, id).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code, id).toBe('channel_not_allowlisted');
      // 非黑名单命中时一个字符都不回显。
      expect(verdict.matched, id).toBeNull();
    }
  });

  it('拿不到通道标识 → 拒绝（无法证明走订阅通道就不放行）', () => {
    const verdict = evaluateInjectPolicy({ id: 'zcc-tap-1', method: 'session/list' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('model_field_missing');
  });

  it('嵌套与数组里的通道标识同样被检查', () => {
    expect(collectChannelTokens({ a: { b: [{ model: 'zai-api' }] } }).map((t) => t.field)).toEqual([
      'a.b[0].model'
    ]);
    const verdict = evaluateInjectPolicy({ id: 'zcc-tap-1', params: { options: [{ provider: 'builtin:zai' }] } });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('blocked_channel');
    expect(verdict.field).toBe('params.options[0].provider');
  });

  it('非对象帧拒绝', () => {
    for (const frame of [null, 42, 'x', [1, 2]]) {
      const verdict = evaluateInjectPolicy(frame);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code).toBe('unparsable_frame');
    }
  });
});

describe('子进程帧路由（凭据隔离的结构性判据）', () => {
  const pending = new Set(['zcc-tap-1']);

  it('命名空间 id + 应答形状 + 在等待表里 → 回控制端', () => {
    expect(classifyChildFrame({ id: 'zcc-tap-1', result: { ok: true } }, pending)).toEqual({
      kind: 'control_response',
      id: 'zcc-tap-1'
    });
  });

  it('凭据请求帧（有 method）永不回控制端', () => {
    // 即便 id 被伪造成我们的命名空间，带 method 的请求帧仍然只中继。
    expect(classifyChildFrame({ id: 'zcc-tap-1', method: 'zcode/credentialHeaders/request' }, pending)).toEqual({
      kind: 'forward_only',
      reason: 'request_frame'
    });
  });

  it('凭据应答帧（id 不在命名空间）永不回控制端', () => {
    const frame = { id: 'zcode-cred-7', result: { headers: { authorization: 'Bearer SYNTHETIC' } } };
    expect(classifyChildFrame(frame, pending)).toEqual({ kind: 'forward_only', reason: 'namespace' });
  });

  it('命名空间内但没人等待的 id：不交给控制端、不猜测归属', () => {
    expect(classifyChildFrame({ id: 'zcc-tap-stale', result: {} }, pending)).toEqual({
      kind: 'forward_only',
      reason: 'unmatched'
    });
  });

  it('无 result/error 的帧不当应答', () => {
    expect(classifyChildFrame({ id: 'zcc-tap-1' }, pending)).toEqual({ kind: 'forward_only', reason: 'no_result' });
    expect(classifyChildFrame({ id: 'zcc-tap-1', error: { code: -32000 } }, pending)).toEqual({
      kind: 'control_response',
      id: 'zcc-tap-1'
    });
  });
});

describe('旁路 NDJSON 行扫描器', () => {
  it('按行切出完整行，保留空行信息（空行被原样转交扫描结果）', () => {
    const scanner = new NdjsonLineScanner();
    expect(scanner.push(Buffer.from('{"a":1}\n\n{"b":2}\n', 'utf8'))).toEqual(['{"a":1}', '', '{"b":2}']);
  });

  it('跨 chunk 的行在最后一块才成形', () => {
    const scanner = new NdjsonLineScanner();
    expect(scanner.push(Buffer.from('{"lo', 'utf8'))).toEqual([]);
    expect(scanner.push(Buffer.from('ng":"中"}\n', 'utf8'))).toEqual(['{"long":"中"}']);
  });

  it('CRLF 的 \r 不进行内容', () => {
    const scanner = new NdjsonLineScanner();
    expect(scanner.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n', 'utf8'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('没有行终止符的尾段在 flush 时交出来（官方 NDJSON 末帧可能没有换行）', () => {
    const scanner = new NdjsonLineScanner();
    expect(scanner.push(Buffer.from('{"a":1}', 'utf8'))).toEqual([]);
    expect(scanner.flush()).toEqual(['{"a":1}']);
    expect(scanner.flush()).toEqual([]);
  });

  it('超长行只停观察，不吞掉后续行', () => {
    const scanner = new NdjsonLineScanner();
    const huge = 'x'.repeat(MAX_SCAN_LINE_BYTES + 16);
    expect(scanner.push(Buffer.from(`${huge}\n{"after":true}\n`, 'utf8'))).toEqual([]);
    expect(scanner.overflowed).toBe(true);
    expect(scanner.push(Buffer.from('{"more":1}\n', 'utf8'))).toEqual([]);
    expect(scanner.overflowed).toBe(true);
  });
});

describe('回环判定', () => {
  it('只认 127.0.0.0/8 与 ::1', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.6.7')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('128.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('子进程环境', () => {
  it('ELECTRON_RUN_AS_NODE 原样透传', () => {
    const env = buildChildEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'C:/Windows' });
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(env['PATH']).toBe('C:/Windows');
  });

  it('控制通道变量不下发给 app-server', () => {
    const env = buildChildEnv({ ZCC_TAP_TOKEN: 'secret-token-value', ZCC_TAP_TOKEN_FILE: 'C:/t', PATH: 'x' });
    expect(Object.keys(env)).toEqual(['PATH']);
    expect(JSON.stringify(env)).not.toContain('secret-token-value');
  });

  it('undefined 值不进子进程环境', () => {
    expect(buildChildEnv({ A: undefined, B: 'b' })).toEqual({ B: 'b' });
  });
});

describe('控制令牌（无默认值）', () => {
  it('环境变量优先', () => {
    const result = resolveControlToken({ ZCC_TAP_TOKEN: 'a'.repeat(32) }, '/x', 'b'.repeat(32));
    expect(result).toEqual({ ok: true, token: 'a'.repeat(32), source: 'env' });
  });

  it('退回令牌文件', () => {
    const result = resolveControlToken({}, '/x', `${'c'.repeat(32)}\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('file');
    expect(result.token).toBe('c'.repeat(32));
  });

  it('两者都没有 → 拒绝启动控制通道，不给默认令牌', () => {
    expect(resolveControlToken({}, null, null)).toEqual({ ok: false, code: 'token_missing' });
    expect(resolveControlToken({}, '/x', '   \n')).toEqual({ ok: false, code: 'token_missing' });
  });

  it('过短或含空白/控制字符的令牌不可用', () => {
    expect(resolveControlToken({ ZCC_TAP_TOKEN: 'short' }, null, null)).toEqual({
      ok: false,
      code: 'token_too_short'
    });
    expect(isUsableControlToken('has space in it long enough')).toBe(false);
    expect(isUsableControlToken('has\nnewline-long-enough-x')).toBe(false);
    expect(isUsableControlToken('x'.repeat(32))).toBe(true);
  });
});

describe('诊断字段净化（帧内容出不去）', () => {
  it('内容类字段一律被丢弃并计数', () => {
    const result = sanitizeDiagFields({
      event: 'child_exit',
      exitCode: 0,
      bytes: 1234,
      frame: { secret: 'x' },
      params: { a: 1 },
      message: 'a long message',
      token: 'zzz',
      workspaceKey: 'w',
      detail: 'd'
    });
    expect(result.safe).toEqual({ event: 'child_exit', exitCode: 0, bytes: 1234 });
    expect(result.dropped).toBe(6);
  });

  it('非原语值被丢弃；超长字符串被丢弃', () => {
    const result = sanitizeDiagFields({
      event: 'x',
      exitCode: {},
      result: 'x'.repeat(200),
      signal: null,
      overflowed: true
    });
    expect(result.safe).toEqual({ event: 'x', signal: null, overflowed: true });
    expect(result.dropped).toBe(2);
  });

  it('计数器类字段可以通过（它们不含内容）', () => {
    const result = sanitizeDiagFields({ event: 'shutdown_done', unmatchedFrames: 0, scannedLines: 12, bytesToChild: 7 });
    expect(result.safe).toEqual({ event: 'shutdown_done', unmatchedFrames: 0, scannedLines: 12, bytesToChild: 7 });
    expect(result.dropped).toBe(0);
  });

  it('白名单里没有任何与内容有关的键', () => {
    for (const forbidden of ['frame', 'params', 'message', 'text', 'body', 'payload', 'token', 'secret', 'model', 'authorization', 'workspaceKey', 'logDir']) {
      expect(DIAG_FIELD_ALLOWLIST.includes(forbidden), forbidden).toBe(false);
    }
  });
});
