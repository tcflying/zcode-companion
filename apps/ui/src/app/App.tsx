import { useEffect } from 'react';
import { ROUTES, useHashRoute, type RouteKey } from './router';
import { useTheme } from './theme';
import { useAppState } from './useAppState';
import { useDesktopState } from './useDesktopState';
import { Chip } from '../components/Chips';
import { OverviewPage } from '../pages/OverviewPage';
import { ChatPage } from '../pages/ChatPage';
import { ModelsPage } from '../pages/ModelsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { LogsPage } from '../pages/LogsPage';
import { CURRENT_EVIDENCE, PRODUCT_DISCLAIMER, PRODUCT_NAME } from '../data/snapshot';
import { STATE_LABEL, STATE_TONE } from '../data/desktopLabels';

export function App() {
  const [route, navigate] = useHashRoute();
  const theme = useTheme();
  const state = useAppState();
  const desktop = useDesktopState();
  const { snapshot } = desktop;

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
            <span className="sidebar__foot-label">本机反代</span>
            {desktop.available ? (
              <Chip tone={STATE_TONE[snapshot.state]}>{STATE_LABEL[snapshot.state]}</Chip>
            ) : (
              <Chip tone="pending">桌面壳未接入</Chip>
            )}
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
            模型目录的计费类别与资格证据仍未接入，界面不填充任何占位假数据。本机反代只负责把请求转给官方宿主，
            不改变这些证据等级。
          </p>
        </div>
      </aside>

      <main className="content" id="main-content">
        {route === 'overview' ? <OverviewPage state={state} desktop={desktop} /> : null}
        {route === 'chat' ? <ChatPage state={state} /> : null}
        {route === 'models' ? <ModelsPage state={state} /> : null}
        {route === 'settings' ? <SettingsPage state={state} theme={theme} desktop={desktop} /> : null}
        {route === 'logs' ? <LogsPage state={state} desktop={desktop} /> : null}
      </main>
    </div>
  );
}

export type { RouteKey };
