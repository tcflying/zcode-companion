/**
 * UI04 联调用 fixture 目录 API（**UI 侧测试替身**，仅测试态）。
 *
 * ⚠️ 这不是 `packages/api` 的服务进程。`packages/api` 目前没有可运行的入口文件
 * （fixture 驱动器还要求构造期传入 `FIXTURE_TEST_TOKEN` symbol），所以这里用一段
 * 零依赖的本机 HTTP 服务复刻**契约与响应头**，供 UI 端到端联调与失败注入演练使用。
 * 真实 `packages/api` 的联调需要协调者裁定后另起入口（见报告 §16）。
 *
 * 硬约束：
 *  - 只监听 127.0.0.1，Host 头不是本机回环:端口 一律 400（防 DNS rebinding）。
 *  - **不输出任何 access-control-* 头**、不处理 OPTIONS：与 packages/api 的 CORS 关闭一致。
 *  - 只实现 `GET /v1/zcc/catalog`；不实现 /v1/chat/completions，**不发任何模型请求**。
 *  - 条目是 fixture 数据：modelId 带 `fixture-` 前缀，UI 侧继续按「未验证 / 测试态」渲染。
 *
 * 用法（PowerShell / Git Bash 均可）：
 *   node apps/ui/tools/fixture-catalog-api.mjs                      # 127.0.0.1:8790，正常目录
 *   node apps/ui/tools/fixture-catalog-api.mjs --port 8790
 *   node apps/ui/tools/fixture-catalog-api.mjs --scenario empty     # models: []（无上游）
 *   node apps/ui/tools/fixture-catalog-api.mjs --scenario status500 # 非 2xx
 *   node apps/ui/tools/fixture-catalog-api.mjs --scenario malformed # 违反契约的正文
 *   node apps/ui/tools/fixture-catalog-api.mjs --scenario slow      # 挂住不返回（演练超时）
 *   node apps/ui/tools/fixture-catalog-api.mjs --revision fixture-rev-2
 *   node apps/ui/tools/fixture-catalog-api.mjs --die-after 1        # 成功响应 1 次后立刻停止监听
 *
 * `--die-after N` 用于一次性演练"先成功、再失败、旧列表保留"：第 N 次目录响应发完后
 * 进程关闭监听端口，后续刷新必然拿到 ECONNREFUSED（api_not_running）。
 *
 * 退出码：0 = 正常退出（Ctrl-C）；1 = 启动失败（端口占用等）。
 */

import http from 'node:http';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const PORT = Number(argOf('port', '8790'));
const SCENARIO = argOf('scenario', 'ok');
const REVISION = argOf('revision', 'fixture-rev-1');
const DIE_AFTER = Number(argOf('die-after', '0')) || 0;
const CATALOG_PATH = '/v1/zcc/catalog';

/** 与 `apps/ui/src/data/modelSource.ts` 的解析层逐字段对齐的 fixture 条目。 */
const FIXTURE_MODELS = [
  {
    modelId: 'fixture-model-a',
    displayName: '目录条目甲（fixture · 非真实模型）',
    provider: 'fixture-provider',
    billingClass: 'subscription',
    contextLength: 200000,
    reasoning: ['high'],
    capabilities: ['工具调用']
  },
  {
    modelId: 'fixture-model-b',
    displayName: '目录条目乙（fixture · 非真实模型）',
    provider: 'fixture-provider',
    billingClass: 'metered_api',
    contextLength: null,
    reasoning: [],
    capabilities: []
  }
];

function isLoopbackHost(hostHeader) {
  const raw = (hostHeader ?? '').trim().toLowerCase();
  const colon = raw.lastIndexOf(':');
  if (colon < 0) return false;
  return raw.slice(0, colon) === '127.0.0.1' && Number(raw.slice(colon + 1)) === PORT;
}

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

let servedCatalog = 0;

const server = http.createServer((req, res) => {
  if (!isLoopbackHost(req.headers.host)) {
    send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'host_not_allowed' }), {
      'x-zcc-status': 'host_not_allowed'
    });
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') {
    // 与 packages/api 一致：不开 CORS，预检一律 405，且不写任何 access-control-* 头。
    send(res, 405, 'application/json; charset=utf-8', JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  if (url.pathname !== CATALOG_PATH) {
    send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not_found', path: url.pathname }));
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, 'application/json; charset=utf-8', JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  const common = {
    'x-zcc-fixture': 'true',
    'x-zcc-status': 'ready',
    'x-zcc-driver': 'zcc-local/fixture',
    'x-zcc-catalog-count': String(FIXTURE_MODELS.length)
  };

  if (SCENARIO === 'status500') {
    send(res, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'upstream_unavailable' }), {
      ...common,
      'x-zcc-status': 'no_quota',
      'x-zcc-detail': encodeURIComponent('联调故障注入：上游缺席，无额度')
    });
    return;
  }
  if (SCENARIO === 'malformed') {
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ revision: REVISION, models: [
      { modelId: 'fixture-model-bad', displayName: '非法类别条目', provider: 'fixture-provider', billingClass: 'freemium', contextLength: 1000, reasoning: [] }
    ] }), common);
    return;
  }
  if (SCENARIO === 'raw-junk') {
    send(res, 200, 'application/json; charset=utf-8', 'not-json <<<catalog truncated', common);
    return;
  }
  if (SCENARIO === 'slow') {
    // 挂住不返回：配合 UI 的 5000ms 超时，演练 timeout 分支。
    return;
  }

  const models = SCENARIO === 'empty' ? [] : FIXTURE_MODELS;
  send(
    res,
    200,
    'application/json; charset=utf-8',
    JSON.stringify({ revision: SCENARIO === 'empty' ? 'none' : REVISION, models }),
    { ...common, 'x-zcc-catalog-count': String(models.length) }
  );

  servedCatalog += 1;
  if (DIE_AFTER > 0 && servedCatalog >= DIE_AFTER) {
    // 发完这一次就撤端口：后续刷新必然 ECONNREFUSED，用于演练"先成功后失败、旧列表保留"。
    setTimeout(() => {
      server.close(() => {
        console.log(`[ui04-fixture-api] --die-after ${DIE_AFTER} 达成，已停止监听 ${PORT}。`);
        process.exit(0);
      });
    }, 50);
  }
});

server.on('error', (err) => {
  console.error(`[ui04-fixture-api] 启动失败：${err.code ?? ''} ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ui04-fixture-api] listening http://127.0.0.1:${PORT}`);
  console.log(`[ui04-fixture-api] scenario=${SCENARIO} revision=${REVISION}`);
  console.log(`[ui04-fixture-api] GET http://127.0.0.1:${PORT}${CATALOG_PATH}`);
  console.log('[ui04-fixture-api] 仅测试态 fixture 数据；无 CORS；只监听回环；不发任何模型请求。');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
