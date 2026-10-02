/**
 * 运行时寻址：反代入口、界面产物、设置文件在 **dev 形态** 与 **打包后形态** 下的位置。
 *
 * 两条硬事实：
 *  1. **入口不猜。** `resolveRuntimePaths()` 返回的每个路径都必须落在
 *     「仓库内」或「`process.resourcesPath/runtime` 内」这两个闭集之一；都不命中时
 *     返回 `errors` 而不是回落到某个看起来合理的默认值——找不到就如实说找不到。
 *  2. **打包形态是自足的。** `extraResources` 把 `packages/`、`scripts/`、`ui/dist`
 *     铺到 `resources/runtime` 下，因此打包后的应用不依赖仓库、也不依赖 `node_modules`
 *     里的任何第三方包（本仓 `packages/**` 与 `scripts/**` 只 import `node:` 内置模块，
 *     这条前提由 `verify:package` 门在包外实跑验证）。
 *
 * 纯函数 + 无 Electron 依赖（`resourcesPath` 由调用方注入），因此可被单测直接引用。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 打包形态下 runtime 根下三块资源的相对位置（`extraResources` 铺出来的形状）。 */
const API_ENTRY_REL = path.join('packages', 'api', 'bin', 'start-api.mjs');
const SCRIPTS_REL = 'scripts';
const UI_DIST_REL = path.join('ui', 'dist');

/** 开发形态下三块资源在仓库里的相对位置（界面在 `apps/` 下面，与打包形态不同构）。 */
const DEV_API_ENTRY_REL = API_ENTRY_REL;
const DEV_SCRIPTS_REL = SCRIPTS_REL;
const DEV_UI_DIST_REL = path.join('apps', 'ui', 'dist');

/**
 * @typedef {object} RuntimePaths
 * @property {'dev'|'packaged'} kind
 * @property {string} runtimeRoot 反代运行时根目录（仓库根，或 `resources/runtime`）。
 * @property {string} apiEntry    `packages/api/bin/start-api.mjs` 的绝对路径。
 * @property {string} scriptsRoot `scripts/` 的绝对路径。
 * @property {string} uiDist      界面产物目录的绝对路径。
 * @property {string[]} errors    无法解析的项（逐条带原因）；空数组表示全部命中。
 */

/**
 * 判断一个路径是否**在**某个目录之内。
 *
 * 注意这里**不能**用 `rel.startsWith('..')`：Windows 上一个合法的目录名就可能叫
 * `....`（`DIST\....\file` 明明在 DIST 之内，却会被 `startsWith('..')` 判成越界）。
 * 判据必须是「相对路径正好是 `..`，或以 `..` + 分隔符开头」。
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 解析反代运行时寻址。
 *
 * dev 与 packaged 两套相对位置**写死在本表里**，不做「猜一个默认位置再回退」：
 * 猜出来的路径要么指向一个不存在的东西（启动时才炸），要么指向一个**存在但不是
 * 本产品的东西**（后者更糟）。命中不上就进 `errors`。
 *
 * @param {object} options
 * @param {string} [options.repoRoot] 仓库根（dev 形态）。
 * @param {string} [options.resourcesPath] Electron 的 `process.resourcesPath`（打包形态）。
 * @param {boolean} [options.isPackaged] 是否打包形态。
 * @returns {RuntimePaths}
 */
function resolveRuntimePaths(options) {
  const isPackaged = options.isPackaged === true;
  /** @type {string[]} */
  const errors = [];

  if (isPackaged && !options.resourcesPath) {
    errors.push('RESOURCES_PATH_MISSING: 打包形态必须提供 process.resourcesPath，不猜');
  }
  const runtimeRoot = isPackaged
    ? path.join(options.resourcesPath ?? '', 'runtime')
    : path.resolve(options.repoRoot ?? path.resolve(__dirname, '..', '..', '..'));

  const apiEntry = path.join(
    runtimeRoot,
    isPackaged ? API_ENTRY_REL : DEV_API_ENTRY_REL
  );
  const scriptsRoot = path.join(runtimeRoot, isPackaged ? SCRIPTS_REL : DEV_SCRIPTS_REL);
  const uiDist = path.join(runtimeRoot, isPackaged ? UI_DIST_REL : DEV_UI_DIST_REL);

  // 只报告「运行时真正需要的」两项缺失：界面产物缺失由 main 单独给出可执行的提示。
  if (!fs.existsSync(apiEntry)) errors.push(`API_ENTRY_MISSING: ${apiEntry}`);
  if (!fs.existsSync(scriptsRoot)) errors.push(`SCRIPTS_ROOT_MISSING: ${scriptsRoot}`);

  return { kind: isPackaged ? 'packaged' : 'dev', runtimeRoot, apiEntry, scriptsRoot, uiDist, errors };
}

exports.isInside = isInside;
exports.resolveRuntimePaths = resolveRuntimePaths;
exports.API_ENTRY_REL = API_ENTRY_REL;
exports.UI_DIST_REL = UI_DIST_REL;
exports.DEV_UI_DIST_REL = DEV_UI_DIST_REL;
