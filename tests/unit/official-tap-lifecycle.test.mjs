/**
 * official-tap-lifecycle.test.mjs — Windows 生命周期行为。
 *
 * Windows 上无法向子进程投递真信号，所以"父进程（桌面）消失"必须由 tap **自己**
 * 发现并收拾干净。本文件验证四件事：
 *  1. 桌面关掉 stdin 之后，tap 自己退出，且退出码来自子进程（不是强杀 0）；
 *  2. 退出时控制端口被释放（不留悬挂监听）；
 *  3. 退出时在等的控制端收到确定性的 `shutting_down` 错误，而不是被静默丢掉；
 *  4. **关停升级**（子进程在 5 s 宽限内不退出 → `shutdown_escalate` → 终止自己
 *     持有的 spawn handle）这条路径真的会发生，而且事件名就叫
 *     `shutdown_escalate`。
 *
 * 另外验证"子进程先死"的方向：tap 不会变成僵尸，退出码如实透出。
 *
 * 注入帧一律用**官方形状**（`{id, method, params}`，无 `jsonrpc`）——官方
 * `zcodeProtocolRequestSchema` 是 `.strict()` 且没有 `jsonrpc` 键。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectControl,
  makeTempDir,
  probePortFree,
  readDiagEvents,
  removeTempDir,
  startTap,
  waitFor,
  waitForControlPort
} from '../helpers/tap-harness.mjs';

const TOKEN = 'test-lifecycle-token-0123456789';

/**
 * 启动拒绝的 stderr 断言。
 *
 * TAPFIX（F1）之前这里根本没有测试：实测是 13 行 Node 栈（含
 * `file:///G:/zcode-project/...` 绝对安装路径）、退出码 1。现在收敛成一行固定
 * 文本 + 退出码 2，所以这三条断言各有明确的失败方式。
 *
 * @param {string} stderr
 */
function expectRefusalStderr(stderr) {
  const lines = stderr.split(/\r?\n/u).filter((line) => line.length > 0);
  expect(lines, `stderr 应恰好一行，实际：${JSON.stringify(stderr)}`).toHaveLength(1);
  expect(lines[0]).toMatch(/^zcode-stdio-tap: startup refused \([a-z_]+\)$/u);
  // 不含任何 Node 栈痕迹，也**不含绝对路径**（taproot / 安装目录 / 工程根）。
  expect(stderr).not.toContain('    at ');
  expect(stderr).not.toContain('.mjs');
  expect(stderr).not.toContain('file:///');
  expect(stderr).not.toContain('G:\\');
  expect(stderr).not.toContain('G:/');
  expect(stderr).not.toMatch(/[A-Za-z]:[\\/]/u);
  expect(stderr).not.toContain('zcode-companion');
  expect(stderr).not.toContain('zcode-taproot');
}

afterEach(() => {
  for (const dir of dirs.splice(0, dirs.length)) removeTempDir(dir);
});

/** @type {string[]} */
const dirs = [];
/** @type {Array<{ stop: () => Promise<void> }>} */
const running = [];
/** @type {Array<{ close: () => void }>} */
const sockets = [];

afterEach(async () => {
  for (const socket of sockets.splice(0, sockets.length)) socket.close();
  for (const handle of running.splice(0, running.length)) await handle.stop();
});

/** @param {string} prefix @returns {string} */
function tempDir(prefix) {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

describe('生命周期：父进程消失后自己收尾', () => {
  it('桌面关掉 stdin → tap 自行退出，退出码取自子进程，并释放控制端口', async () => {
    const dir = tempDir('lifecycle');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);

    const controlPort = await waitForControlPort(dir);
    const control = await connectControl(controlPort, TOKEN);
    sockets.push(control);
    await control.next('hello');
    expect((await probePortFree(controlPort)).ok).toBe(false); // 现在确实在监听

    // 桌面消失：关掉 tap 的 stdin。
    tap.endStdin();
    const exit = await tap.waitExit();

    // fixture 在 stdin 结束时干净退出 0，tap 如实透出这个退出码。
    expect(exit.code, `tap stderr: ${tap.stderr()}`).toBe(0);
    expect(exit.signal).toBeNull();

    // 端口释放：没有悬挂监听。
    const released = await waitFor(async () => (await probePortFree(controlPort)).ok === true, {
      what: 'control port released',
      timeoutMs: 10_000
    }).catch(async () => {
      const after = await probePortFree(controlPort);
      throw new Error(`control port ${controlPort} still accepting connections: ${after.code}`);
    });
    expect(released).toBe(true);

    // 诊断里有完整的关闭链，且不含内容。
    const diag = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
    expect(diag).toContain('"event":"shutdown_begin"');
    expect(diag).toContain('"event":"child_exit"');
    expect(diag).toContain('"event":"shutdown_done"');
    // TAPFIX(F2)：这一条原来是 `not.toContain('"escalate"')`——**恒假断言**。
    // 真名是 `shutdown_escalate`，序列化后 `escalate` 前面是 `_` 而不是 `"`，
    // 所以那个子串永远不可能出现，断言永远绿，等于门禁里没有这条。
    // 现在钉住真名：子进程在宽限期内干净退出 ⇒ **不该**出现升级事件。
    // 这条是真能红的：把 fixture 换成 `--hang-after-stdin-end`（见下一条用例），
    // 同一行断言立刻失败。
    expect(diag).not.toContain('shutdown_escalate');
  });

  it('关停升级：子进程在宽限期内不退出时，诊断里出现 shutdown_escalate（F2 的正向锚点）', async () => {
    // 这一条是上面那条负向断言的**正向锚点**，也是 F2 红→绿证明的第二半。
    // 没有它，"干净退出路径里没有 shutdown_escalate" 这句话就只是因为那条路径
    // 从来不会产生它，而不是因为断言真的在看着它。
    // 红证据（TAPFIX 之前，tap 代码未改动时实测）：
    //   - `expect(diag).toContain('shutdown_escalate')`        → 绿（升级确实发生）
    //   - `expect(diag).not.toContain('"escalate"')`            → **仍然绿**（恒假）
    //   - `expect(diag).not.toContain('shutdown_escalate')`    → **红**（新断言能失败）
    const dir = tempDir('escalate');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      // stdin 收完也不退出 ⇒ tap 的 SHUTDOWN_GRACE_MS 宽限耗尽 ⇒ 走升级分支。
      fixtureArgs: ['--hang-after-stdin-end']
    });
    running.push(tap);
    await waitForControlPort(dir);

    tap.endStdin();
    await tap.waitExit();

    const diag = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
    expect(diag).toContain('"event":"shutdown_begin"');
    expect(diag).toContain('"event":"shutdown_escalate"');
    expect(diag).toContain('"result":"kill_child"');
    expect(diag).toContain('"event":"shutdown_done"');
    // 升级确实发生 ⇒ 上一条用例里那条 `not.toContain('shutdown_escalate')`
    // 不是恒真断言（这一份 diag 上它会红）。
    expect(diag).toContain('shutdown_escalate');
  }, 30000);

  it('关闭时在等的控制端收到确定性的 shutting_down 错误（不重发、不静默丢）', async () => {
    const dir = tempDir('shutdown-pending');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      // 静默 id：子进程记账但不回帧，于是请求一直在等待表里。
      fixtureArgs: ['--inject-respond', '--inject-silent-id', 'zcc-tap-pending-1']
    });
    running.push(tap);
    const port = Number(
      await waitFor(
        () => {
          const text = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
          const hit = text.split('\n').find((line) => line.includes('"control_listen"'));
          return hit === undefined ? null : JSON.parse(hit).controlPort;
        },
        { what: 'control_listen' }
      )
    );
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'pending-1',
        // 官方请求形状：{id, method, params}，没有 jsonrpc 键。
        frame: { id: 'zcc-tap-pending-1', method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    expect((await control.next('inject.ack'))['requestId']).toBe('zcc-tap-pending-1');

    tap.endStdin();
    const shutdownFrame = await control.nextWhere(
      (frame) => frame['op'] === 'response.error',
      10_000
    );
    expect(/** @type {Record<string, unknown>} */ (shutdownFrame['error'])['code']).toBe('shutting_down');
    expect(shutdownFrame['requestId']).toBe('zcc-tap-pending-1');

    const exit = await tap.waitExit();
    expect(exit.code).toBe(0);
  });

  it('子进程先退出时 tap 如实透出退出码，不变成悬挂进程', async () => {
    const dir = tempDir('child-first');
    // 一个立刻退出的子命令（node -e 打印后退出，退出码 3）。
    const tap = startTap({ logDir: dir, port: 0, fixtureArgs: [] });
    running.push(tap);
    tap.write(Buffer.from('{"id":1,"method":"initialize"}\n', 'utf8'));
    // fixture 收到 stdin EOF 才退；这里再关一次桌面侧 stdin 让链路闭合。
    tap.endStdin();
    const exit = await tap.waitExit();
    expect(exit.code, `tap stderr: ${tap.stderr()}`).toBe(0);
    const diag = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
    expect(diag).toContain('"event":"child_exit"');
  });

  it('真实命令不存在 → 如实非零退出，绝不静默假绿', async () => {
    const dir = tempDir('bad-command');
    const tap = startTap({
      logDir: dir,
      port: 0,
      // 一个不存在的可执行文件：tap 必须如实把 spawn 失败报出来。
      command: join(dir, 'definitely-not-an-executable.exe')
    });
    running.push(tap);
    tap.write(Buffer.from(String.fromCharCode(10), 'utf8'));
    tap.endStdin();
    const exit = await tap.waitExit();
    expect(exit.code, `tap stderr: ${tap.stderr()}`).toBe(1);
    const diag = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
    expect(diag).toContain('"event":"child_error"');
    expect(diag).toContain('ENOENT');
  });
});

/**
 * TAPFIX(F1)：启动拒绝路径此前**零测试覆盖**，而实施报告声称"只写一行固定文本、
 * 退出码 2"。实测是 13 行 Node 栈（含绝对安装路径）、退出码 1——因为 `throw` 在模块
 * 顶层无人接管，`process.exitCode = 2` 被未捕获异常覆盖成 1。
 * harness 平时构造的 argv 永远合法，所以这里用 `tapArgs` 原样喂坏 argv。
 */
describe('启动拒绝：恰好一行固定文本 + 退出码 2 + 无绝对路径', () => {
  const cases = [
    { what: '缺少 -- 分界符', argv: ['--workspace-key', 'K'], code: 'missing_boundary' },
    { what: '-- 之后没有真实命令', argv: ['--'], code: 'missing_command' },
    { what: '未知选项', argv: ['--nope', 'x', '--', 'node'], code: 'unknown_option' },
    { what: '选项缺值', argv: ['--log-dir', '--', 'node'], code: 'missing_value' },
    { what: '选项重复', argv: ['--workspace-key', 'a', '--workspace-key', 'b', '--', 'node'], code: 'duplicate_option' },
    { what: '非法控制端口', argv: ['--control-port', '0x10', '--', 'node'], code: 'bad_port' }
  ];

  for (const testCase of cases) {
    it(`${testCase.what} → 退出码 2、stderr 恰好一行、不含绝对路径`, async () => {
      const dir = tempDir('refuse');
      const tap = startTap({ logDir: dir, port: 0, tapArgs: testCase.argv });
      running.push(tap);
      const exit = await tap.waitExit();
      expect(exit.code).toBe(2);
      expect(exit.signal).toBeNull();
      expectRefusalStderr(tap.stderr());
      expect(tap.stderr().trim()).toBe(`zcode-stdio-tap: startup refused (${testCase.code})`);
    });
  }

  it('拒绝时 stdout 一个字节都没有，也不碰 taproot', async () => {
    const dir = tempDir('refuse-stdout');
    const tap = startTap({ logDir: dir, port: 0, tapArgs: ['--workspace-key', 'K'] });
    running.push(tap);
    await tap.waitExit();
    expect(tap.stdoutLength()).toBe(0);
    // 没有子进程被 spawn ⇒ 没有 child_spawn 诊断，也没有子进程可留下。
    expect(readDiagEvents(dir)).toEqual([]);
  });
});
