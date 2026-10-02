#!/usr/bin/env node
/**
 * install-tap.mjs — 把 tap 装到 taproot 的 `scripts/dev/` 下。
 *
 * 官方钩子用 `findUpward("scripts/dev/zcode-stdio-tap.mjs")` 从宿主进程 cwd 向上找
 * 这份脚本，所以安装位置是**唯一**契约：`\<taproot\>/scripts/dev/zcode-stdio-tap.mjs`。
 * 默认 taproot `C:\zcode-taproot`。
 *
 * 装三样东西：
 *  1. 运行时脚本（入口 + 它的三个模块，必须整组复制——入口是相对 import）；
 *  2. 控制令牌文件（随机 32 字节 hex，**不打印、不回显**，已存在则原样保留，
 *     免得重装把正在用的令牌换掉导致控制端掉线）；
 *  3. `zcode-tap-control.json`（端口 + 令牌文件名），tap 从自己同目录读它。
 *
 * 令牌为什么落文件而不是只认环境变量：官方 spawn 走
 * `sanitizeZCodeRuntimeEnv(process.env)`，自定义环境变量能透传（实测源码：该函数是
 * 键级**拒绝清单**，`ZCC_TAP_TOKEN` 不在清单里）；但已经在运行的桌面进程没有这个
 * 变量，而本轮不许重启它。文件是让控制通道在"不重启桌面"的前提下仍可用的退路。
 * 两条路都拿不到令牌时，tap **拒绝监听控制端口**，没有写死的默认令牌。
 *
 * 本脚本不启动任何东西、不碰 `C:\ZCode`、不发任何请求。
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROL_DEFAULT_PORT } from './tap-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** 必须与入口一起安装的文件。入口靠相对 import 找后三个。 */
export const RUNTIME_FILES = Object.freeze([
  'zcode-stdio-tap.mjs',
  'tap-core.mjs',
  'tap-relay.mjs',
  'tap-control.mjs'
]);

export const CONTROL_CONFIG_FILE = 'zcode-tap-control.json';
export const CONTROL_TOKEN_FILE = 'zcode-tap-control.token';

const USAGE = 'USAGE: node install-tap.mjs [--taproot <dir>] [--port <n>] [--dry-run]';

/**
 * @param {readonly string[]} argv
 * @returns {{ taproot: string, port: number, dryRun: boolean } | { error: string }}
 */
export function parseInstallArgs(argv) {
  let taproot = 'C:\\zcode-taproot';
  let port = CONTROL_DEFAULT_PORT;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--taproot') {
      const value = argv[i + 1];
      if (value === undefined) return { error: '--taproot requires a value' };
      taproot = value;
      i += 1;
    } else if (arg === '--port') {
      const value = argv[i + 1];
      const parsed = value !== undefined && /^\d{1,5}$/u.test(value) ? Number(value) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return { error: '--port requires 0..65535' };
      port = parsed;
      i += 1;
    } else {
      return { error: `unknown option ${arg}` };
    }
  }
  return { taproot, port, dryRun };
}

/**
 * @param {string[]} argv
 */
function main(argv) {
  const parsed = parseInstallArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const targetDir = join(resolve(parsed.taproot), 'scripts', 'dev');
  const tokenPath = join(targetDir, CONTROL_TOKEN_FILE);
  const configPath = join(targetDir, CONTROL_CONFIG_FILE);

  for (const file of RUNTIME_FILES) {
    const from = join(SCRIPT_DIR, file);
    if (!existsSync(from)) {
      process.stderr.write(`missing runtime file: ${from}\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (!parsed.dryRun) {
    mkdirSync(targetDir, { recursive: true });
    for (const file of RUNTIME_FILES) {
      copyFileSync(join(SCRIPT_DIR, file), join(targetDir, file));
    }
  }

  const tokenExisted = existsSync(tokenPath);
  if (!parsed.dryRun && !tokenExisted) {
    // 32 字节随机 hex。写完立刻 chmod 0600（POSIX 生效；Windows 上 ACL 仍来自
    // 目录继承，README/报告里如实说明，不假装 chmod 在 Windows 上等价）。
    writeFileSync(tokenPath, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // Windows 上可能不支持，忽略。
    }
  }

  if (!parsed.dryRun) {
    writeFileSync(
      configPath,
      `${JSON.stringify({ port: parsed.port, tokenFile: CONTROL_TOKEN_FILE, protocol: 1 }, null, 2)}\n`,
      'utf8'
    );
  }

  // 只回报路径与端口，**永不回显令牌本身**。
  const lines = [
    `mode: ${parsed.dryRun ? 'dry-run' : 'install'}`,
    `target: ${targetDir}`,
    `files: ${RUNTIME_FILES.length}`,
    `config: ${configPath}`,
    `tokenFile: ${tokenPath} ${parsed.dryRun ? '(would create)' : tokenExisted ? '(kept existing)' : '(created)'}`,
    `controlPort: ${parsed.port}`
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = 0;
}

/**
 * 只有被当作脚本直接执行时才跑安装。**必须**有这道闸：本文件为了可单测而导出
 * `parseInstallArgs` 等纯函数，测试 import 本模块时不该顺手把 tap 装进 taproot
 * ——顶层副作用会变成"跑一次单测就改一次系统目录"。
 *
 * @param {string} entryPath
 * @returns {boolean}
 */
function invokedAsScript(entryPath) {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  return resolve(argv1).toLowerCase() === resolve(entryPath).toLowerCase();
}

if (invokedAsScript(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`install-tap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
