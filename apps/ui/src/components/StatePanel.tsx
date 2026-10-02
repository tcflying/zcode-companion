import type { ReactNode } from 'react';

export type PanelTone = 'empty' | 'loading' | 'error' | 'info';

const TONE_TITLE: Record<PanelTone, string> = {
  empty: '空状态',
  loading: '加载中',
  error: '错误状态',
  info: '提示'
};

export function StatePanel({
  tone,
  title,
  children,
  actions
}: {
  tone: PanelTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`state-panel state-panel--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="state-panel__head">
        <span className="state-panel__tone">{TONE_TITLE[tone]}</span>
        <span className="state-panel__title">{title}</span>
      </div>
      {children ? <div className="state-panel__body">{children}</div> : null}
      {actions ? <div className="state-panel__actions">{actions}</div> : null}
    </div>
  );
}
