import type { ReactNode } from 'react';

export type ChipTone = 'pending' | 'unknown' | 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

export function Chip({
  tone = 'neutral',
  children,
  title
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Section({
  title,
  description,
  actions,
  children
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <header className="section__head">
        <div className="section__titles">
          <h2 className="section__title">{title}</h2>
          {description ? <p className="section__desc">{description}</p> : null}
        </div>
        {actions ? <div className="section__actions">{actions}</div> : null}
      </header>
      <div className="section__body">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  badges
}: {
  title: string;
  subtitle: string;
  badges?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        <p className="page-header__subtitle">{subtitle}</p>
      </div>
      {badges ? <div className="page-header__badges">{badges}</div> : null}
    </header>
  );
}

export function Toggle({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange?: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' toggle--on' : ''}${disabled ? ' toggle--disabled' : ''}`}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    >
      <span className="toggle__track">
        <span className="toggle__knob" />
      </span>
      <span className="toggle__state">{checked ? '开' : '关'}</span>
    </button>
  );
}
