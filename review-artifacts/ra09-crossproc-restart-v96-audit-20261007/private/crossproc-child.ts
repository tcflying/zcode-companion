// RA-09 跨进程重启承接 · **子进程**入口（真实独立 OS 进程，不是同进程内的新实例）。
//
// 为什么必须是真进程：929.md:853「终止本应用子进程后重开零重发」。
// 同进程内 `createApiServer()` 再来一次，只能证明「新实例读到了盘」，
// 证明不了「上一进程真的死了、盘是它死前写的」。本文件就是那个「上一进程」。
//
// 约束（逐条对应本轮授权边界）：
//  - 端口传 0，由 OS 分配临时端口，绝不碰 8790/8791 等真实占用端口。
//  - 驱动器是本地 fixture，**不发任何网络请求**、不起任何子进程、不碰真实凭据。
//  - 所有落盘都在 os.tmpdir() 传进来的临时 data 目录里。
//  - 本进程**永不自行退出**：等父进程 kill，这才造得出「崩溃时停在 in_flight」的现场。
//
// 两种模式：
//  - hang   ：驱动器记一次调用后永不返回 ⇒ operation 停在 in_flight 直到被杀。
//  - normal ：驱动器记一次调用后走真 fixture 流 ⇒ operation 正常 terminal（正向对照用）。

import fs from 'node:fs';
import path from 'node:path';

// 本文件位于 <repo>/review-artifacts/<轮次>/private/ ⇒ 到仓库根是**三层**上溯。
// （与既有探针 journal-api.probe.test.mjs 的 '../../../packages/...' 一致。）
import { createApiServer, FIXTURE_TEST_TOKEN } from '../../../packages/api/src/server.js';
import { createFixtureDriver } from '../../../packages/api/src/chat.js';

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

async function main() {
  const dataDir = requiredEnv('ZCC_CP_DATA_DIR');
  const readyFile = requiredEnv('ZCC_CP_READY_FILE');
  const apiKey = requiredEnv('ZCC_CP_API_KEY');
  const mode = requiredEnv('ZCC_CP_MODE');
  const logFile = requiredEnv('ZCC_CP_LOG_FILE');
  if (mode !== 'hang' && mode !== 'normal') throw new Error(`bad ZCC_CP_MODE=${mode}`);

  const callsFile = path.join(dataDir, 'driver-calls.jsonl');
  let callCount = 0;

  /** 驱动器被调用的**可核查凭证**：追加一行，父进程按行数判定「driver 调用 0」不是口头声明。 */
  function recordCall(model) {
    callCount += 1;
    fs.appendFileSync(
      callsFile,
      `${JSON.stringify({ n: callCount, model, pid: process.pid, at: new Date().toISOString() })}\n`,
      'utf8'
    );
    return callCount;
  }

  function appendLog(line) {
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      // 日志落盘失败不得影响被测行为；吞掉但不留假绿依据（本文件不据此断言）。
    }
  }

  const fixture = createFixtureDriver();
  const driver =
    mode === 'hang'
      ? {
          ...fixture,
          async *stream(request) {
            recordCall(request.model);
            appendLog(`event=driver_call mode=hang n=${callCount} pid=${process.pid}`);
            // 永不返回、永不结算：operation 因此停在 in_flight，直到父进程杀掉本进程。
            await new Promise(() => {});
          }
        }
      : {
          ...fixture,
          async *stream(request) {
            recordCall(request.model);
            appendLog(`event=driver_call mode=normal n=${callCount} pid=${process.pid}`);
            yield* fixture.stream(request);
          }
        };

  const server = createApiServer({
    enabled: true,
    port: 0,
    apiKeys: [apiKey],
    testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
    rateLimit: { maxConcurrent: 8, requests: 500, windowMs: 60000 },
    logger: { info: appendLog, warn: appendLog, error: appendLog },
    driver,
    journalDir: dataDir
  });

  const started = await server.start();
  if (started.started !== true || started.port === undefined) {
    throw new Error(`child server did not start: ${JSON.stringify(started)}`);
  }

  // ready 文件是父子之间唯一的握手：父进程看到它，才知道端口与 PID 已经可用。
  fs.writeFileSync(
    readyFile,
    `${JSON.stringify({ pid: process.pid, port: started.port, mode, dataDir, apiKeyBound: true })}\n`,
    'utf8'
  );
  appendLog(`event=child_ready mode=${mode} pid=${process.pid} port=${started.port}`);

  // 永不自行退出。等父进程 kill —— 这正是「崩溃前停在 in_flight」的现场。
  await new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(`CHILD_FATAL ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});