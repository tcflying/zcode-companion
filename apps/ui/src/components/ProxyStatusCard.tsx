/**
 * I10 反代状态卡：桌面程序把它管的那条 OpenAI 兼容 API 的真实状态摊开给人看。
 *
 * 纪律：
 *  - **`external` 一律禁用启动/停止**，并在卡面写明「只观察、不接管」。这条不是 UI 装饰：
 *    它对应主进程侧「绝不向不是自己 spawn 的进程发信号」那条硬边界，按钮禁用是它的
 *    机器可读形式。
 *  - 状态、PID、端口、最近错误**逐条来自主进程快照**，界面不自己推断、不乐观显示。
 *  - 任何一次操作之后都重新拉一次快照，而不是就地改本地状态：主进程才是唯一事实源。
 */

import { useState } from 'react';
import { Chip } from './Chips';
import { StatePanel } from './StatePanel';
import type { DesktopState } from '../app/useDesktopState';
import { restartProxy, startProxy, stopProxy } from '../data/desktopBridge';
import { STATE_LABEL, STATE_TONE } from '../data/desktopLabels';

export function ProxyStatusCard({ desktop }: { desktop: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { snapshot } = desktop;

  const external = snapshot.state === 'external';
  const busyish = busy || snapshot.state === 'starting';

  const run = async (label: string, action: () => Promise<{ ok: boolean; code: string }>) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setNotice(
        result.ok
          ? `${label}：已完成（${result.code}）`
          : `${label}：被拒绝（${result.code}）${result.code === 'EXTERNAL_NOT_OWNED' ? '——该进程不是本程序启动的，界面不接管' : ''}`
      );
    } catch (err) {
      setNotice(`${label}：异常（${err instanceof Error ? err.message : String(err)}）`);
    } finally {
      setBusy(false);
      desktop.refresh();
      desktop.refreshLogs();
    }
  };

  return (
    <section className="section">
      <header className="section__head">
        <div className="section__titles">
          <h2 className="section__title">本机反代</h2>
          <p className="section__desc">
            桌面程序主进程拉起的 OpenAI 兼容 API 子进程。启动 / 停止 / 重启都在这里完成，不弹任何独立控制台窗口。
          </p>
        </div>
        <div className="section__actions">
          <button
            type="button"
            className="btn"
            data-action="proxy-start"
            // `external` 下**不**禁用启动：管理器会重新探一次端口，外部进程还在就继续
            // 只观察，端口空出来了就接管。把这���堵死，用户就只能重启应用自救。
            // 停止/重启仍禁用——那个进程不是我们起的，绝不能对它发信号。
            disabled={!desktop.available || busyish || snapshot.state === 'running'}
            onClick={() => void run('启动', startProxy)}
          >
            启动
          </button>
          <button
            type="button"
            className="btn"
            data-action="proxy-stop"
            disabled={!desktop.available || external || busyish || snapshot.state !== 'running'}
            onClick={() => void run('停止', stopProxy)}
          >
            停止
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-action="proxy-restart"
            disabled={!desktop.available || external || busyish}
            onClick={() => void run('重启', restartProxy)}
          >
            重启
          </button>
        </div>
      </header>
      <div className="section__body">
        {!desktop.available ? (
          <StatePanel tone="info" title="桌面壳未接入">
            当前界面不是由 ZCode Companion 桌面程序加载的（浏览器或 vite dev 直开），因此没有可管理的反代子进程。
            请用桌面程序启动，或在仓库里执行 <span className="mono">cd apps/desktop &amp;&amp; npm start</span>。
          </StatePanel>
        ) : (
          <>
            <div className="setting-facts setting-facts--stack">
              <div>
                <span>状态</span>
                <Chip tone={STATE_TONE[snapshot.state]}>{STATE_LABEL[snapshot.state]}</Chip>
              </div>
              <div>
                <span>监听</span>
                <span className="mono">
                  {snapshot.port === null ? '—' : `http://127.0.0.1:${snapshot.port}`}
                </span>
              </div>
              <div>
                <span>子进程 PID</span>
                <span className="mono">{snapshot.pid === null ? '—（不是本程序拉起的进程）' : String(snapshot.pid)}</span>
              </div>
              <div>
                <span>是否自有</span>
                <Chip tone={snapshot.owned ? 'ok' : 'neutral'}>{snapshot.owned ? '本程序 spawn' : '非本程序 spawn'}</Chip>
              </div>
              {snapshot.portChangePending ? (
                <div>
                  <span>待重启端口</span>
                  <span className="mono">
                    {snapshot.configuredPort === null ? '—' : `http://127.0.0.1:${snapshot.configuredPort}`}
                    （当前反代仍监听 {String(snapshot.port)}，点「重启」后才切换）
                  </span>
                </div>
              ) : null}
            </div>

            {external ? (
              <StatePanel tone="info" title="外部实例：只观察，不接管">
                启动前在 127.0.0.1:{snapshot.port} 上已探到一个在服务的 API
                （<span className="mono">GET /v1/models</span> 返回 401 或 200 都算在服务）。
                本程序**不会**终止它——那不是本程序 spawn 的进程，所以「停止 / 重启」是结构性禁用的。
                「启动」仍可点：它会**重新探一次端口**，外部进程还在就继续只观察；
                你在别处停掉那份、端口空出来之后，再点一次「启动」即可由本程序接管。
              </StatePanel>
            ) : null}

            {snapshot.lastError !== null ? (
              <StatePanel tone="error" title="最近一次错误">
                {snapshot.lastError}
              </StatePanel>
            ) : null}

            {notice !== null ? (
              <div className="notice notice--ok" role="status">
                <span className="notice__tag">操作结果</span>
                <span className="notice__text">{notice}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
