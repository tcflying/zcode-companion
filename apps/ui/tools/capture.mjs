/**
 * UI01 截图工具（零依赖）。
 *
 * 用本机已安装的 Chrome + Chrome DevTools Protocol 驱动真实组件树：
 * 打开页面 → 执行真实点击（刷新 / 自检）→ 抓取真实渲染的 PNG。
 * 不做任何图片拼贴、不做设计稿、不调用外部网络（只连 127.0.0.1）。
 *
 * 用法：
 *   node apps/ui/tools/capture.mjs --url http://127.0.0.1:4319 --out review-artifacts/ui01 --only id
 *
 * 参数：
 *   --url     目标地址（必须是本机已启动的静态服务）
 *   --out     输出目录
 *   --only    只拍某一个 shot id
 *
 * 退出码：0 = 全部成功；1 = 有 shot 失败或 CDP 报错。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = arg('url', 'http://127.0.0.1:4319');
const OUT = resolve(arg('out', 'review-artifacts/ui01'));
const ONLY = arg('only', '');

/** @type {Array<{id:string,width:number,height:number,hash:string,route?:string,theme?:string,query?:string,fullPage?:boolean,steps?:Array<{goto?:string,clickText?:string,clickLabel?:string,clickLabelValue?:string,fill?:{selector:string,value:string},waitMs?:number}>,note:string}>} */
const SHOTS = [
  {
    id: '01-overview-light-1280x800',
    width: 1280,
    height: 800,
    hash: '#/overview',
    theme: 'light',
    note: '总览页 light 主题，1280×800 视口'
  },
  {
    id: '02-chat-light-1280x900',
    width: 1280,
    height: 900,
    hash: '#/chat',
    theme: 'light',
    note: '会话页两轮占位气泡 + 输入区（视口首屏）'
  },
  {
    id: '02b-chat-light-full-1280',
    width: 1280,
    height: 900,
    hash: '#/chat',
    theme: 'light',
    fullPage: true,
    note: '会话页整页：E0 发送门告示条 + 禁用的「不可发送（E0）」控件 + 解锁条件说明（U-C1 修复后证据）'
  },
  {
    id: '03-models-light-1280x800',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    note: '模型与套餐页首屏 1280×800（动态刷新模式）'
  },
  {
    id: '16-models-dynamic-mode-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    note: 'UI02 动态刷新模式整页：模式单选（本机 API 通道）+ 刷新来源按钮 + 最近刷新/成功时间/结果/revision/列表变化 + 契约假设 + 额度无可用 + 发送门 E0 关闭'
  },
  {
    id: '17-models-refresh-failed-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [{ clickText: '刷新来源（只读取，不发送）', waitMs: 900 }],
    note: 'UI02 刷新失败态整页（空目录 + transport_not_wired）：红色提示条 + 错误面板（失败原因码/已登记标记/人读标题/发生时间/人读说明/处理建议/本次技术说明/当前列表保留），未回退到空列表或假数据。**注意本次刷新的前一次也是 0 条，非空保留场景见 23。**'
  },
  {
    id: '18-models-manual-mode-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [{ clickLabelValue: 'manual', waitMs: 300 }],
    note: 'UI02 写死固定模式整页：切换到 manual 后的录入表单与未录入空态（无任何真实条目）'
  },
  {
    id: '19-models-manual-entry-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [
      { clickLabelValue: 'manual', waitMs: 250 },
      { fill: { selector: '[data-field="displayName"]', value: '本地自建代理通道（示例条目）' }, waitMs: 60 },
      { fill: { selector: '[data-field="provider"]', value: 'local-proxy' }, waitMs: 60 },
      { fill: { selector: '[data-field="modelId"]', value: 'local-proxy-model-alpha' }, waitMs: 60 },
      { evalSelect: { selector: '[data-field="billingClass"]', value: 'subscription' }, waitMs: 60 },
      { fill: { selector: '[data-field="contextLength"]', value: '128000' }, waitMs: 60 },
      { fill: { selector: '[data-field="reasoning"]', value: 'high' }, waitMs: 60 },
      { fill: { selector: '[data-field="capabilities"]', value: '工具调用, 长上下文' }, waitMs: 60 },
      { fill: { selector: '[data-field="note"]', value: '主上手工录入，用于验证写死模式不获得可发送资格' }, waitMs: 60 },
      { clickText: '录入条目', waitMs: 400 }
    ],
    note: 'UI02 写死固定模式（含手工录入条目）：条目标记「手工录入 · 未由官方验证」+ 可用性「未验证」+ 操作列禁用的「不可发送（E0）」'
  },
  {
    id: '20-models-manual-dark-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'dark',
    fullPage: true,
    steps: [
      { clickLabelValue: 'manual', waitMs: 250 },
      { fill: { selector: '[data-field="displayName"]', value: '本地自建代理通道（示例条目）' }, waitMs: 60 },
      { fill: { selector: '[data-field="provider"]', value: 'local-proxy' }, waitMs: 60 },
      { fill: { selector: '[data-field="modelId"]', value: 'local-proxy-model-alpha' }, waitMs: 60 },
      { evalSelect: { selector: '[data-field="billingClass"]', value: 'subscription' }, waitMs: 60 },
      { fill: { selector: '[data-field="contextLength"]', value: '128000' }, waitMs: 60 },
      { fill: { selector: '[data-field="reasoning"]', value: 'high' }, waitMs: 60 },
      { fill: { selector: '[data-field="capabilities"]', value: '工具调用, 长上下文' }, waitMs: 60 },
      { fill: { selector: '[data-field="note"]', value: '主上手工录入，用于验证写死模式不获得可发送资格' }, waitMs: 60 },
      { clickText: '录入条目', waitMs: 400 }
    ],
    note: 'UI02 写死固定模式 dark 主题整页（含手工录入条目）'
  },
  {
    id: '21-models-manual-1920-full',
    width: 1920,
    height: 1080,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [
      { clickLabelValue: 'manual', waitMs: 250 },
      { fill: { selector: '[data-field="displayName"]', value: '本地自建代理通道（示例条目）' }, waitMs: 60 },
      { fill: { selector: '[data-field="provider"]', value: 'local-proxy' }, waitMs: 60 },
      { fill: { selector: '[data-field="modelId"]', value: 'local-proxy-model-alpha' }, waitMs: 60 },
      { evalSelect: { selector: '[data-field="billingClass"]', value: 'subscription' }, waitMs: 60 },
      { fill: { selector: '[data-field="contextLength"]', value: '128000' }, waitMs: 60 },
      { fill: { selector: '[data-field="reasoning"]', value: 'high' }, waitMs: 60 },
      { fill: { selector: '[data-field="capabilities"]', value: '工具调用, 长上下文' }, waitMs: 60 },
      { fill: { selector: '[data-field="note"]', value: '主上手工录入，用于验证写死模式不获得可发送资格' }, waitMs: 60 },
      { clickText: '录入条目', waitMs: 400 }
    ],
    note: 'UI02 写死固定模式 1920 宽响应式整页（含手工录入条目）'
  },
  {
    id: '22-models-mode-switch-preserved-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [
      { clickLabelValue: 'manual', waitMs: 250 },
      { fill: { selector: '[data-field="displayName"]', value: '本地自建代理通道（示例条目）' }, waitMs: 60 },
      { fill: { selector: '[data-field="provider"]', value: 'local-proxy' }, waitMs: 60 },
      { fill: { selector: '[data-field="modelId"]', value: 'local-proxy-model-alpha' }, waitMs: 60 },
      { clickText: '录入条目', waitMs: 300 },
      { clickLabelValue: 'dynamic', waitMs: 400 }
    ],
    note: 'UI02 模式切换保留已输入内容：录入 1 条后切到动态模式，提示条明确说明"已保留：已手工录入的 1 个条目……未清空任何内容"'
  },
  {
    id: '23-models-refresh-failed-keeps-nonempty-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    query: 'sourceFixture=catalog2_then_conn_fail',
    fullPage: true,
    steps: [
      { clickText: '刷新来源（只读取，不发送）', waitMs: 600 },
      { clickText: '刷新来源（只读取，不发送）', waitMs: 1200 }
    ],
    note:
      'UI02-F1 项1（REV3-UI02-I1 缺口）：**非空**旧列表保留。测试态 fixture（?sourceFixture=catalog2_then_conn_fail，' +
      '零网络、不读真实目录）：第 1 次刷新读回 2 条 fixture 条目，第 2 次刷新失败（connection_failed），' +
      '表格仍是那 2 条（fixture-model-a / fixture-model-b），错误面板叠加显示原因码 + 人读说明 + 处理建议 + ' +
      '"保留刷新前读到的 2 条"。条目的「不可发送（E0）」按钮仍全部 disabled。'
  },
  {
    id: '24-models-refresh-failed-malformed-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    query: 'sourceFixture=catalog2_then_malformed',
    fullPage: true,
    steps: [
      { clickText: '刷新来源（只读取，不发送）', waitMs: 600 },
      { clickText: '刷新来源（只读取，不发送）', waitMs: 1200 }
    ],
    note:
      'UI02-F1 项2 的非 transport 失败态：测试态 fixture 第 2 次刷新返回违反 /v1/zcc/catalog 契约的响应' +
      '（billingClass=freemium 非法 + 缺 capabilities），解析层**整体拒绝**（malformed_payload），' +
      '错误面板逐条列出契约缺陷（enum_invalid @ $.models[0].billingClass / field_missing @ $.models[0].capabilities），' +
      '旧列表 2 条仍保留，没有部分采纳非法条目。'
  },
  {
    id: '25-models-manual-mode-teststate-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    query: 'sourceFixture=catalog2_then_conn_fail',
    fullPage: true,
    steps: [
      { clickText: '刷新来源（只读取，不发送）', waitMs: 700 },
      { clickLabelValue: 'manual', waitMs: 300 },
      { fill: { selector: '[data-field="displayName"]', value: '本地自建代理通道（示例条目）' }, waitMs: 60 },
      { fill: { selector: '[data-field="provider"]', value: 'local-proxy' }, waitMs: 60 },
      { fill: { selector: '[data-field="modelId"]', value: 'local-proxy-model-alpha' }, waitMs: 60 },
      { evalSelect: { selector: '[data-field="billingClass"]', value: 'subscription' }, waitMs: 60 },
      { fill: { selector: '[data-field="contextLength"]', value: '128000' }, waitMs: 60 },
      { fill: { selector: '[data-field="capabilities"]', value: '工具调用' }, waitMs: 60 },
      { clickText: '录入条目', waitMs: 400 }
    ],
    note:
      'UI02-F3 M2（REV5-UI02-M2）：**写死固定模式也渲染同一条黄色「测试态」横条**，措辞准确区分两种模式。' +
      '测试态 fixture（?sourceFixture=catalog2_then_conn_fail，零网络、不读真实目录）：先在动态模式刷新读回 2 条 fixture 条目，' +
      '再切到写死固定模式并手工录入 1 条。横条明写当前表格里是**手工录入条目、不是 fixture 数据**，' +
      '动态模式读到的 fixture 条目仍保留在内存里；表格上方小字同步改为写死模式口径（不再误标「测试态 fixture 数据」）。' +
      '两条测试态措辞里都不再出现字面量 ** 记号（M1）。'
  },
  {
    id: '04-models-light-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    note: '模型与套餐页整页（额度三源 / 目录 / 列结构 / 发送准入）'
  },
  {
    id: '05-settings-light-full-1280',
    width: 1280,
    height: 800,
    hash: '#/settings',
    theme: 'light',
    fullPage: true,
    note: '设置页整页（本机 API / 单实例 / 窗口模式 / 外观 / 脱敏 / 数据目录 / 自检）'
  },
  {
    id: '06-logs-light-1280x800',
    width: 1280,
    height: 800,
    hash: '#/logs',
    theme: 'light',
    note: '日志页启动条目（全部已脱敏写入口）'
  },
  {
    id: '07-models-dark-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'dark',
    fullPage: true,
    note: '模型与套餐页 dark 主题整页'
  },
  {
    id: '08-overview-dark-1280x800',
    width: 1280,
    height: 800,
    hash: '#/overview',
    theme: 'dark',
    note: 'dark 主题 1280×800'
  },
  {
    id: '09-settings-dark-full-1920',
    width: 1920,
    height: 1080,
    hash: '#/settings',
    theme: 'dark',
    fullPage: true,
    note: 'dark 主题 1920 宽响应式整页'
  },
  {
    id: '10-overview-light-full-1920',
    width: 1920,
    height: 1080,
    hash: '#/overview',
    theme: 'light',
    fullPage: true,
    note: 'light 主题 1920 宽响应式整页'
  },
  {
    id: '11-models-manual-filter-no-match',
    width: 1280,
    height: 900,
    hash: '#/models',
    theme: 'light',
    steps: [
      { clickLabelValue: 'manual', waitMs: 250 },
      { fill: { selector: '[data-field="displayName"]', value: '本地自建代理通道（示例条目）' }, waitMs: 60 },
      { fill: { selector: '[data-field="modelId"]', value: 'local-proxy-model-alpha' }, waitMs: 60 },
      { clickText: '录入条目', waitMs: 300 },
      { fill: { selector: 'input[type="search"].input', value: '不存在的模型名' }, waitMs: 300 }
    ],
    note: '模型页空态（筛选无匹配）：写死模式下 1 条录入条目被搜索词过滤为 0 条，占位行与空态面板仍不承载任何真实套餐'
  },
  {
    id: '12-models-filter-metered-api',
    width: 1280,
    height: 900,
    hash: '#/models',
    theme: 'light',
    steps: [
      {
        evalSelect: { selector: 'select.input--select', value: 'metered_api' },
        waitMs: 300
      }
    ],
    note: '模型页计费类别筛选 = metered_api：0 条目，metered_api 不渲染为可点击发送'
  },
  {
    id: '13-logs-redaction-selfcheck',
    width: 1280,
    height: 900,
    hash: '#/logs',
    theme: 'light',
    steps: [{ clickText: '注入自检条目', waitMs: 400 }],
    note: '日志页脱敏自检：注入后凭据样式串已写前替换为 [REDACTED]，并含 ERROR 态样式'
  },
  {
    id: '14-settings-error-state-full-1280',
    width: 1280,
    height: 800,
    hash: '#/settings',
    theme: 'light',
    fullPage: true,
    steps: [{ clickLabel: '时钟异常自检', waitMs: 500 }],
    note: '设置页错误态整页：打开"时钟异常自检"后窗口判定 fail-closed（Invalid Date）'
  },
  /* ---------------- UI04：本机 API 回环联调（需先起 fixture API，见报告 §16） ---------------- */
  {
    id: '26-settings-local-api-toggle-full-1280',
    width: 1280,
    height: 900,
    hash: '#/settings',
    theme: 'light',
    fullPage: true,
    note: 'UI04 设置页「本机 API」分区：连接本机 API 开关（默认关 = 零网络）+ base URL 输入与回环守卫判定 + CSP connect-src 展示'
  },
  {
    id: '27-models-local-api-enabled-refreshed-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [
      { goto: '#/settings' },
      { clickLabel: '连接本机 API（只读目录，不发模型请求）', waitMs: 400 },
      { goto: '#/models' },
      { clickText: '刷新来源（只读取，不发送）', waitMs: 1500 }
    ],
    note: 'UI04 联调成功态：设置页开启本机 API → 模型页刷新 → 目录出现 fixture 条目，条目仍为「来源读回 / 未验证 / 不可发送」测试态样式（前置：fixture API 在 127.0.0.1:8790 监听）'
  },
  {
    id: '28-models-local-api-refresh-failed-keeps-list-full-1280',
    width: 1280,
    height: 800,
    hash: '#/models',
    theme: 'light',
    fullPage: true,
    steps: [
      { goto: '#/settings' },
      { clickLabel: '连接本机 API（只读目录，不发模型请求）', waitMs: 400 },
      { goto: '#/models' },
      { clickText: '刷新来源（只读取，不发送）', waitMs: 1200 },
      { clickText: '刷新来源（只读取，不发送）', waitMs: 1500 }
    ],
    note: 'UI04 联调失败态：第一次刷新成功、第二次失败（api_not_running / connection_failed 面板）+ 刷新前读到的旧列表原样保留。**前置：用 `node apps/ui/tools/fixture-catalog-api.mjs --die-after 1` 启动，否则两次刷新都会成功。**'
  }
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('未找到 Chrome / Edge 可执行文件');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDevToolsPort(userDataDir, child, timeoutMs = 20000) {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`浏览器提前退出，exit=${child.exitCode}`);
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf8').split(/\r?\n/);
      const port = Number(raw[0]);
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(120);
  }
  throw new Error('等待 DevTools 端口超时');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      } else if (msg.method) {
        const arr = this.listeners.get(msg.method);
        if (arr) for (const fn of arr) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 15000) {
    return new Promise((res, rej) => {
      const arr = this.listeners.get(method) ?? [];
      const fn = (params) => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((f) => f !== fn));
        res(params);
      };
      arr.push(fn);
      this.listeners.set(method, arr);
      setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((f) => f !== fn));
        rej(new Error(`等待事件超时: ${method}`));
      }, timeoutMs);
    });
  }
}

/** 轮询页面就绪：readyState complete 且界面壳已挂载。避免依赖 Page.loadEventFired（同文档 hash 切换不触发该事件）。 */
async function waitForAppReady(cdp, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          if (document.readyState !== 'complete') return false;
          const shell = document.querySelector('.app-shell');
          if (!shell) return false;
          const target = window.location.hash;
          const active = document.querySelector('.nav__item--active');
          return Boolean(active) && (target === '' || active.getAttribute('aria-current') === 'page');
        })()`,
        returnByValue: true
      });
      if (r.result && r.result.value === true) return true;
    } catch {
      /* 导航切换瞬间执行上下文可能失效，继续轮询 */
    }
    await sleep(150);
  }
  throw new Error('等待界面壳就绪超时');
}

/** Runtime.evaluate 对 JS 异常不抛 CDP 错误，只回 exceptionDetails；这里显式转成失败。 */
async function evaluateOrThrow(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面内异常: ${(d.exception && d.exception.description) || d.text}`);
  }
  return r.result ? r.result.value : undefined;
}

async function main() {
  const chrome = findChrome();
  const userDataDir = join(tmpdir(), `zc-companion-ui01-capture-${process.pid}`);
  mkdirSync(OUT, { recursive: true });

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-sandbox',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stderr.on('data', () => {});

  const results = [];
  try {
    const port = await waitForDevToolsPort(userDataDir, child);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到可用的 page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const shot of SHOTS) {
      if (ONLY && shot.id !== ONLY) continue;
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: shot.width,
          height: shot.height,
          deviceScaleFactor: 1,
          mobile: false
        });
        const loaded = waitForAppReady(cdp, 20000);
        const extraQuery = shot.query ? `&${shot.query}` : '';
        await cdp.send('Page.navigate', {
          url: `${BASE}/?theme=${shot.theme ?? 'light'}${extraQuery}${shot.hash}`
        });
        await loaded;
        await sleep(400);

        for (const step of shot.steps ?? []) {
          if (step.goto) {
            // SPA hash 切换：等导航事件后再等界面壳就绪，避免拍到上一页
            const back = waitForAppReady(cdp, 20000);
            await cdp.send('Page.navigate', { url: `${BASE}/?theme=${shot.theme ?? 'light'}${step.goto}` });
            await back;
            await sleep(250);
          }
          if (step.clickText || step.clickLabel) {
            const selectorExpr = step.clickLabel
              ? `b.getAttribute('aria-label') === ${JSON.stringify(step.clickLabel)}`
              : `b.textContent.includes(${JSON.stringify(step.clickText)})`;
            await evaluateOrThrow(cdp, `(() => {
              const btn = [...document.querySelectorAll('button')].find(b => ${selectorExpr});
              if (!btn) throw new Error('找不到按钮: ' + ${JSON.stringify(step.clickLabel ?? step.clickText)});
              if (btn.disabled) throw new Error('按钮被禁用: ' + ${JSON.stringify(step.clickLabel ?? step.clickText)});
              btn.click();
              return true;
            })()`);
          }
          if (step.evalSelect) {
            await evaluateOrThrow(cdp, `(() => {
              const el = document.querySelector(${JSON.stringify(step.evalSelect.selector)});
              if (!el) throw new Error('找不到下拉框');
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
              setter.call(el, ${JSON.stringify(step.evalSelect.value)});
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return el.value;
            })()`);
          }
          if (step.clickLabelValue) {
            // 真实点击单选框（走 React 的 onChange），不直接改状态
            await evaluateOrThrow(cdp, `(() => {
              const el = document.querySelector('input[type="radio"][value="' + ${JSON.stringify(step.clickLabelValue)} + '"]');
              if (!el) throw new Error('找不到单选框: ' + ${JSON.stringify(step.clickLabelValue)});
              el.click();
              return el.value;
            })()`);
          }
          if (step.fill) {
            // 真实逐字符输入 + input 事件，React 受控组件才能收到值
            await evaluateOrThrow(cdp, `(() => {
              const el = document.querySelector(${JSON.stringify(step.fill.selector)});
              if (!el) throw new Error('找不到输入框: ' + ${JSON.stringify(step.fill.selector)});
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(el, '');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              for (const ch of ${JSON.stringify(step.fill.value)}) {
                setter.call(el, el.value + ch);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              return el.value;
            })()`);
          }
          if (step.waitMs) await sleep(step.waitMs);
        }

        let captureHeight = shot.height;
        if (shot.fullPage) {
          // 滚动容器是 .content 而不是 document，需量取容器高度后放大视口，整页才不会被裁。
          const contentHeight = await evaluateOrThrow(
            cdp,
            `(() => {
              const c = document.querySelector('.content');
              return c ? Math.ceil(c.scrollHeight) : 0;
            })()`
          );
          const wanted = Math.max(shot.height, Number(contentHeight) + 8);
          captureHeight = Math.min(wanted, 6000);
          if (captureHeight !== shot.height) {
            await cdp.send('Emulation.setDeviceMetricsOverride', {
              width: shot.width,
              height: captureHeight,
              deviceScaleFactor: 1,
              mobile: false
            });
            await sleep(350);
          }
        }
        const params = {
          format: 'png',
          captureBeyondViewport: false,
          fromSurface: true,
          clip: { x: 0, y: 0, width: shot.width, height: captureHeight, scale: 1 }
        };
        const shotResult = await cdp.send('Page.captureScreenshot', params);
        const file = join(OUT, `${shot.id}.png`);
        writeFileSync(file, Buffer.from(shotResult.data, 'base64'));
        results.push({
          id: shot.id,
          file,
          ok: true,
          note: shot.note,
          size: `${shot.width}x${captureHeight}`,
          bytes: readFileSync(file).length
        });
        console.log(`[OK]   ${shot.id}.png  ${shot.width}x${captureHeight}  ${shot.note}`);
      } catch (err) {
        results.push({ id: shot.id, ok: false, error: String(err && err.message ? err.message : err) });
        console.error(`[FAIL] ${shot.id}: ${results[results.length - 1].error}`);
      }
    }

    writeFileSync(join(OUT, 'capture-manifest.json'), JSON.stringify({ base: BASE, chrome, results }, null, 2));
    ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响产物 */
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 张，失败 ${failed} 张，输出目录 ${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('capture 失败:', err);
  process.exit(1);
});
