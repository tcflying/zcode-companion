// 把子进程入口打包成**独立可跑的 .mjs**（vite SSR 构建）。
//
// 为什么必须打包而不是直接 `node child.ts`：
//  packages/api/src 内部一律用 `./errors.js` 这种**指向 .ts 源文件**的 specifier
//  （TS ESM 的标准写法）。Node 24 的 type-stripping **不会**把 `./x.js` 重写成 `./x.ts`，
//  直接 node 跑必然 ERR_MODULE_NOT_FOUND。vite 的解析器认这条 .js→.ts 映射，所以走它。
//
// 输出目录由 argv 传入且只落 os.tmpdir()：打包产物属临时物，不进正式源码目录。
// 依赖面已核过：packages/api/src 只 import node: 内置模块 + contracts/errors，
// 所以产物自包含，不需要 node_modules 参与运行。

import fs from 'node:fs';
import path from 'node:path';

import { build } from 'vite';

// TS ESM 的标准写法是 `import ... from './errors.js'`（specifier 写 .js，实际文件是 .ts）。
// vite 当前的解析器（rolldown）**不认**这条映射，直接 UNRESOLVED_IMPORT。
// 这里补一个**只认相对路径 + 只在 .js 确实不存在时才回退**的解析钩子：
//  - 范围窄：绝对路径与包名一律不碰，node: 内置与第三方解析行为完全不变。
//  - 条件严：.js 文件真实存在时直接放行，绝不篡改已经能解析的 specifier。
const tsJsSpecifier = {
  name: 'zcc-ts-js-specifier',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer === undefined || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const absolute = path.resolve(path.dirname(importer), source);
    if (fs.existsSync(absolute)) return null;
    const withoutExt = absolute.slice(0, -'.js'.length);
    for (const ext of ['.ts', '.tsx']) {
      if (fs.existsSync(`${withoutExt}${ext}`)) return `${withoutExt}${ext}`;
    }
    return null;
  }
};

const entry = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3]);

await build({
  root: 'G:/zcode-project/zcode-companion',
  configFile: false,
  logLevel: 'warn',
  plugins: [tsJsSpecifier],
  build: {
    ssr: true,
    target: 'node24',
    outDir,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'crossproc-child.mjs'
    }
  }
});

// vite 会把产物命名成 `crossproc-child.js`。本仓库根 package.json 没有 "type":"module"，
// Node 会按 CJS 解释 `.js`，ESM 产物直接起不来。所以统一改名成 `.mjs`，
// 让扩展名自己声明模块制式——不依赖仓库根的 type 字段。
const emitted = fs
  .readdirSync(outDir)
  .filter((name) => /^crossproc-child\.[cm]?js$/.test(name))
  .map((name) => path.join(outDir, name));
if (emitted.length !== 1) {
  throw new Error(`expected exactly one emitted bundle, got: ${JSON.stringify(emitted)}`);
}
const finalPath = path.join(outDir, 'crossproc-child.mjs');
if (emitted[0] !== finalPath) fs.renameSync(emitted[0], finalPath);

process.stdout.write(`BUNDLE_OK ${finalPath}\n`);