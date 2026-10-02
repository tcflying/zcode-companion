import { useEffect } from 'react';
import { ROUTES, useHashRoute, type RouteKey } from './router';
import { useTheme } from './theme';
import { useAppState } from './useAppState';
import { Chip } from '../components/Chips';
import { OverviewPage } from '../pages/OverviewPage';
import { ChatPage } from '../pages/ChatPage';
import { ModelsPage } from '../pages/ModelsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { LogsPage } from '../pages/LogsPage';
import { CURRENT_EVIDENCE, PRODUCT_DISCLAIMER, PRODUCT_NAME } from '../data/snapshot';

export function App() {
  const [route, navigate] = useHashRoute();
  const theme = useTheme();
  const state = useAppState();

  useEffect(() => {
    const def = ROUTES.find((r) => r.key === route);
    document.title = def ? `${def.title} · ${PRODUCT_NAME}（${PRODUCT_DISCLAIMER}）` : PRODUCT_NAME;
  }, [route]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__name">{PRODUCT_NAME}</div>
          <div className="brand__disclaimer">{PRODUCT_DISCLAIMER}</div>
        </div>

        <nav className="nav" aria-label="主导航">
          {ROUTES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`nav__item${route === r.key ? ' nav__item--active' : ''}`}
              aria-current={route === r.key ? 'page' : undefined}
              onClick={() => navigate(r.key)}
            >
              <span className="nav__index">{String(ROUTES.indexOf(r) + 1).padStart(2, '0')}</span>
              <span className="nav__label">{r.title}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar__foot">
          <div className="sidebar__foot-row">
            <span className="sidebar__foot-label">运行时</span>
            <Chip tone="pending">未接入</Chip>
          </div>
          <div className="sidebar__foot-row">
            <span className="sidebar__foot-label">证据等级</span>
            <Chip tone="warn">{CURRENT_EVIDENCE} · 不可发送</Chip>
          </div>
          <div className="sidebar__foot-row">
            <span className="sidebar__foot-label">主题</span>
            <span className="sidebar__foot-value">{theme.resolved}（{theme.pref}）</span>
          </div>
          <p className="sidebar__note">
            本构建只呈现界面形态。目录、额度、计费、账号与运行时数据源均未接入，界面不填充任何占位假数据。
          </p>
        </div>
      </aside>

      <main className="content" id="main-content">
        {route === 'overview' ? <OverviewPage state={state} /> : null}
        {route === 'chat' ? <ChatPage state={state} /> : null}
        {route === 'models' ? <ModelsPage state={state} /> : null}
        {route === 'settings' ? <SettingsPage state={state} theme={theme} /> : null}
        {route === 'logs' ? <LogsPage state={state} /> : null}
      </main>
    </div>
  );
}

export type { RouteKey };
