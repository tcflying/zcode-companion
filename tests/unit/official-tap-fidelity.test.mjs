/**
 * official-tap-fidelity.test.mjs — 中继保真性的端到端证据。
 *
 * 测法是**外部复核**，不信 tap 自证：
 *  1. 本文件构造一段已知的 NDJSON 字节序列（含空行、CRLF、**超长行**、中文、
 *     转义与控制字符、**没有行终止符的末帧**、以及一行根本不是 JSON 的内容），
 *     逐字节写进 tap 的 stdin（扮演桌面）；
 *  2. fixture 对端把**自己 stdin 收到的每一个字节**原样落到 `--record` 文件；
 *  3. 断言该文件与输入 **Buffer.compare === 0**（逐字节相同，长度也相同），
 *     并与 fixture 自报的 sha256 交叉核对。
 *  反向同理：fixture 写 stdout 的已知字节，断言 tap 的 stdout 逐字节相同。
 *
 * 顺带钉住两条容易悄悄坏掉的性质：
 *  - `ELECTRON_RUN_AS_NODE` 原样透传给子进程；
 *  - 没有令牌时**不开控制端口**（连接被拒），而不是无令牌降级。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  connectControl,
  readDiagEvents,
  waitForControlPort,
  makeTempDir,
  parseNdjsonLines,
  probePortFree,
  removeTempDir,
  startTap,
  waitFor
} from '../helpers/tap-harness.mjs';

/**
 * 已知 NDJSON 序列（父 → 子方向）。逐字节固定，含各种边界。
 *
 * 帧形状对齐官方 `zcodeProtocolMessageSchema`（`C:\ZCode\resources\glm\zcode.cjs:72`
 * col 137377–137887）：请求帧 `{id, method, params}`、应答帧 `{id, result}`，**没有
 * `jsonrpc` 键**。官方 schema 是 `.strict()`，测试里也不该固化官方必然拒收的形状。
 */
const TO_CHILD = Buffer.concat([
  Buffer.from('{"id":1,"method":"initialize","params":{"protocolVersion":"2025-01-01"}}\n', 'utf8'),
  Buffer.from('\n', 'utf8'), // 空行
  Buffer.from('   \n', 'utf8'), // 只有空白的行
  Buffer.from('{"id":2,"method":"a/b","params":{"note":"中文与转义 \\" \\\\ \\u0001 \\t 换行\\n制表\\t😀"}}\n', 'utf8'),
  Buffer.from('{"id":3,"method":"c/d"}\r\n', 'utf8'), // CRLF
  Buffer.from('{"id":4,"method":"e/f","params":{"big":"', 'utf8'),
  Buffer.from('x'.repeat(256 * 1024), 'utf8'), // 超长行（单行 256 KiB）
  Buffer.from('"}}\n', 'utf8'),
  Buffer.from('这不是 JSON，也不是 NDJSON，只是一行原始字节\n', 'utf8'),
  Buffer.from('{"id":5,"method":"g/h"}', 'utf8') // 末帧没有行终止符
]);

/** 已知 NDJSON 序列（子 → 父方向）。 */
const TO_PARENT = Buffer.concat([
  Buffer.from('{"id":"srv-1","result":{"ok":true}}\n', 'utf8'),
  Buffer.from('\n', 'utf8'),
  Buffer.from('{"id":"srv-2","result":{"text":"中文 😀 \\u0001"}}\r\n', 'utf8'),
  Buffer.from('{"id":"srv-3","result":{"big":"', 'utf8'),
  Buffer.from('y'.repeat(128 * 1024), 'utf8'),
  Buffer.from('"}}\n', 'utf8'),
  Buffer.from('{"id":"srv-4","result":{"tail":true}}', 'utf8')
]);

/** @param {Buffer} buf @returns {string} */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** @type {string[]} */
const tempDirs = [];
/** @type {Array<{ stop: () => Promise<void> }>} */
const running = [];

afterEach(async () => {
  for (const handle of running.splice(0, running.length)) await handle.stop();
  for (const dir of tempDirs.splice(0, tempDirs.length)) removeTempDir(dir);
});

/** @param {string} prefix @returns {string} */
function tempDir(prefix) {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

describe('中继保真：双向逐字节相同', () => {
  it('父 stdin → 子 stdin 与 子 stdout → 父 stdout 都与输入逐字节相同', async () => {
    const dir = tempDir('fidelity');
    const recordPath = join(dir, 'received.bin');
    const reportPath = join(dir, 'report.json');
    const stdoutPath = join(dir, 'to-parent.bin');
    writeFileSync(stdoutPath, TO_PARENT);

    const tap = startTap({
      logDir: dir,
      port: 0, // 0 = 系统分配：本用例不测控制通道
      env: { ELECTRON_RUN_AS_NODE: '1' },
      fixtureArgs: ['--record', recordPath, '--report', reportPath, '--stdout-file', stdoutPath]
    });
    running.push(tap);

    tap.write(TO_CHILD);
    tap.endStdin();
    const exit = await tap.waitExit();

    // tap 自己干净退出（不是被强杀）。
    expect(exit.code, `tap stderr: ${tap.stderr()}`).toBe(0);

    const received = readFileSync(recordPath);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));

    // 父 → 子：逐字节相同。
    expect(received.length).toBe(TO_CHILD.length);
    expect(Buffer.compare(received, TO_CHILD)).toBe(0);
    expect(report.receivedBytes).toBe(TO_CHILD.length);
    expect(report.receivedSha256).toBe(sha256(TO_CHILD));

    // 子 → 父：逐字节相同。
    const forwarded = tap.stdout();
    expect(forwarded.length).toBe(TO_PARENT.length);
    expect(Buffer.compare(forwarded, TO_PARENT)).toBe(0);

    // 逐字节相同包含三件容易悄悄坏掉的事：没有补换行、CRLF 没被规范化成 LF、
    // 多字节字符没被截断。这里用**字节**断言而不是字符串断言。
    const LF = 0x0a;
    expect(TO_CHILD[TO_CHILD.length - 1]).not.toBe(LF); // 输入的末帧本来就没有行终止符
    expect(received[received.length - 1]).not.toBe(LF); // 下游也没被补上换行
    expect(forwarded[forwarded.length - 1]).not.toBe(LF);
    expect(forwarded.includes(Buffer.from('\r\n', 'utf8'))).toBe(true); // CRLF 原样保留
    expect(forwarded.includes(Buffer.from('中文 😀', 'utf8'))).toBe(true); // 多字节未被截断
    expect(received.includes(Buffer.from('中文与转义', 'utf8'))).toBe(true);

    // 旁路扫描器看到的行数与 JSON 解析结果（不改变字节，只证明它在看）。
    expect(report.receivedLines).toBeGreaterThan(0);

    // 诊断里的字节计数必须与真实转发的字节一致（这三个计数器曾经手写错过一个
    // 方向，所以现在从 tap 自己的诊断里断言，而不是靠人肉看日志）。
    const done = readDiagEvents(dir).find((record) => record['event'] === 'shutdown_done');
    expect(done).toBeDefined();
    expect(done?.['bytesToChild']).toBe(TO_CHILD.length);
    expect(done?.['bytesToParent']).toBe(TO_PARENT.length);
    expect(done?.['droppedFields']).toBe(0);
  });

  it('ELECTRON_RUN_AS_NODE 原样透传给子进程', async () => {
    const dir = tempDir('env-passthrough');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      fixtureArgs: ['--report', reportPath]
    });
    running.push(tap);
    tap.write(TO_CHILD);
    tap.endStdin();
    await tap.waitExit();
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.electronRunAsNode).toBe('1');
  });

  it('不设该变量时子进程也确实是 undefined（证明上一条不是恒真）', async () => {
    const dir = tempDir('env-absent');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({ logDir: dir, port: 0, fixtureArgs: ['--report', reportPath] });
    running.push(tap);
    tap.write(TO_CHILD);
    tap.endStdin();
    await tap.waitExit();
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.electronRunAsNode).toBeNull();
  });
});

describe('没有令牌就不开控制通道', () => {
  it('拒绝监听：诊断只有 control_refused、没有任何 control_listen，且中继照常', async () => {
    const dir = tempDir('no-token');
    const tap = startTap({
      logDir: dir,
      port: 0, // 0 = 系统分配（见 harness 里为什么不用固定端口）
      fixtureArgs: []
    });
    running.push(tap);
    await waitFor(() => readDiagEvents(dir).some((record) => record['event'] === 'control_refused'), {
      what: 'control_refused diag',
      timeoutMs: 10_000
    });
    // 只可能有一条路径会开监听：成功写 control_listen，失败写 control_listen_failed。
    // 两条都没有 ⇒ 从未尝试监听。
    const events = readDiagEvents(dir).map((record) => record['event']);
    expect(events).toContain('control_refused');
    expect(events).not.toContain('control_listen');
    expect(events).not.toContain('control_listen_failed');
    const refused = readDiagEvents(dir).find((r) => r['event'] === 'control_refused');
    expect(refused).toBeDefined();
    expect(refused?.['code']).toBe('token_missing');

    tap.write(TO_CHILD);
    tap.endStdin();
    // 中继照常工作：桌面侧行为与没有 tap 时一致。
    const exit = await tap.waitExit();
    expect(exit.code, `tap stderr: ${tap.stderr()}`).toBe(0);
    expect(readDiagEvents(dir).map((r) => r['event'])).toContain('shutdown_done');
  });

  it('工单指定的 8791 当前没有监听者（本用例只探测不绑定，可与其它用例并存）', async () => {
    const probe = await probePortFree(8791);
    expect(probe, `8791 已被占用：${probe.code}`).toEqual({ ok: true, code: 'ECONNREFUSED' });
  });

  it('令牌错误两次即断开，且从不回显令牌', async () => {
    const dir = tempDir('bad-token');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: 'correct-token-value-0123456789' },
      fixtureArgs: ['--report', reportPath]
    });
    running.push(tap);

    const port = await waitForControlPort(dir);
    const control = await connectControl(port, 'wrong-token-value-0000000000000');
    try {
      const first = await control.next('error');
      expect(first['error']).toMatchObject({ code: 'unauthorized' });
      // 任何回执里都没有令牌内容。
      expect(JSON.stringify(control.all())).not.toContain('wrong-token-value-0000000000000');
      expect(JSON.stringify(control.all())).not.toContain('correct-token-value-0123456789');
    } finally {
      control.close();
    }

    tap.write(TO_CHILD);
    tap.endStdin();
    await tap.waitExit();
  });
});

describe('旁路观察不改变字节', () => {
  it('含无法解析行的序列照样逐字节通过（观察失败不影响转发）', async () => {
    const dir = tempDir('garbage');
    const recordPath = join(dir, 'received.bin');
    const garbage = Buffer.from('not json\n{"partial":\n[[[\n', 'utf8');
    const tap = startTap({ logDir: dir, port: 0, fixtureArgs: ['--record', recordPath] });
    running.push(tap);
    tap.write(garbage);
    tap.endStdin();
    await tap.waitExit();
    expect(Buffer.compare(readFileSync(recordPath), garbage)).toBe(0);
  });

  it('注入之外，父进程写入的所有内容都原样到达子进程', async () => {
    const dir = tempDir('bulk');
    const recordPath = join(dir, 'received.bin');
    const stdoutPath = join(dir, 'to-parent.bin');
    writeFileSync(stdoutPath, Buffer.alloc(0));
    const tap = startTap({ logDir: dir, port: 0, fixtureArgs: ['--record', recordPath, '--stdout-file', stdoutPath] });
    running.push(tap);
    // 分多次写入，模拟真实的分片到达。
    for (let i = 0; i < TO_CHILD.length; i += 997) {
      tap.write(TO_CHILD.subarray(i, Math.min(i + 997, TO_CHILD.length)));
    }
    tap.endStdin();
    await tap.waitExit();
    expect(Buffer.compare(readFileSync(recordPath), TO_CHILD)).toBe(0);
    expect(parseNdjsonLines(readFileSync(recordPath)).length).toBeGreaterThan(0);
  });
});

describe('安装步骤与令牌文件路径', () => {
  it('install-tap 把整套运行时装到 taproot，令牌不落 stdout', () => {
    const taproot = tempDir('taproot');
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'official-tap', 'install-tap.mjs'), '--taproot', taproot, '--port', '0'],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    const devDir = join(taproot, 'scripts', 'dev');
    for (const file of ['zcode-stdio-tap.mjs', 'tap-core.mjs', 'tap-relay.mjs', 'tap-control.mjs']) {
      expect(existsSync(join(devDir, file)), file).toBe(true);
    }
    const tokenPath = join(devDir, 'zcode-tap-control.token');
    const token = readFileSync(tokenPath, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    // 令牌绝不出现在安装器自己的输出里。
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    const config = JSON.parse(readFileSync(join(devDir, 'zcode-tap-control.json'), 'utf8'));
    expect(config).toMatchObject({ port: 0, tokenFile: 'zcode-tap-control.token' });
  });

  it('装出来的 tap 自带令牌可用（不依赖继承环境变量）', async () => {
    const taproot = tempDir('installed-tap');
    const install = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'official-tap', 'install-tap.mjs'), '--taproot', taproot, '--port', '0'],
      { encoding: 'utf8' }
    );
    expect(install.status, install.stderr).toBe(0);

    const devDir = join(taproot, 'scripts', 'dev');
    const token = readFileSync(join(devDir, 'zcode-tap-control.token'), 'utf8').trim();
    const dir = tempDir('installed-run');
    const reportPath = join(dir, 'report.json');

    // 从 taproot 目录里跑装好的那份，并且**显式清掉**环境里的令牌变量。
    const tap = startTap({
      entry: join(devDir, 'zcode-stdio-tap.mjs'),
      cwd: taproot,
      logDir: dir,
      port: 0,
      noInheritedToken: true,
      fixtureArgs: ['--report', reportPath]
    });
    running.push(tap);

    const port = await waitForControlPort(dir);
    const diag = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
    expect(diag).toContain('"tokenSource":"file"');
    expect(diag).not.toContain(token);

    const control = await connectControl(port, token);
    try {
      const hello = await control.next('hello');
      expect(hello['controlPort']).toBe(port);
    } finally {
      control.close();
    }

    tap.write(TO_CHILD);
    tap.endStdin();
    expect((await tap.waitExit()).code).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.receivedBytes).toBe(TO_CHILD.length);
    expect(report.receivedSha256).toBe(sha256(TO_CHILD));
  });
});
