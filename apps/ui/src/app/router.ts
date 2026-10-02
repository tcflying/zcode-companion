import { useEffect, useState } from 'react';

export type RouteKey = 'overview' | 'chat' | 'models' | 'settings' | 'logs';

export interface RouteDef {
  key: RouteKey;
  path: string;
  title: string;
  subtitle: string;
}

export const ROUTES: RouteDef[] = [
  { key: 'overview', path: '/overview', title: '总览', subtitle: '运行时连接、版本指纹、账号权益与本地时钟' },
  { key: 'chat', path: '/chat', title: '会话', subtitle: '对话版式占位 · 本轮不发送任何请求' },
  { key: 'models', path: '/models', title: '模型与套餐', subtitle: '目录结构、计费类别与额度三源（当前证据等级 E0）' },
  { key: 'settings', path: '/settings', title: '设置', subtitle: '本机 API、窗口模式、单实例锁、脱敏与数据目录' },
  { key: 'logs', path: '/logs', title: '日志', subtitle: '本地日志缓冲 · 写入前强制脱敏' }
];

function parseHash(): RouteKey {
  const raw = window.location.hash.replace(/^#/, '');
  const found = ROUTES.find((r) => r.path === raw);
  return found ? found.key : 'overview';
}

export function useHashRoute(): [RouteKey, (key: RouteKey) => void] {
  const [route, setRoute] = useState<RouteKey>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.hash = '#/overview';
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (key: RouteKey) => {
    const target = ROUTES.find((r) => r.key === key);
    if (!target) return;
    window.location.hash = `#${target.path}`;
  };

  return [route, navigate];
}
