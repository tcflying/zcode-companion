import { Chip, PageHeader, Section } from '../components/Chips';
import { FieldList } from '../components/FieldList';
import { StatePanel } from '../components/StatePanel';
import {
  BUILD_TAG,
  CURRENT_EVIDENCE,
  EVIDENCE_SUMMARY,
  RUNTIME_SECTIONS
} from '../data/snapshot';
import { evaluateWindow, formatClock, formatDuration } from '../lib/format';
import { WINDOW_MODE_LABEL } from '../data/snapshot';
import type { AppState } from '../app/useAppState';

export function OverviewPage({ state }: { state: AppState }) {
  const clock = formatClock(state.now);
  const uptime = formatDuration(Date.now() - state.bootedAt);
  const windowVerdict = evaluateWindow(state.now);

  return (
    <div className="page">
      <PageHeader
        title="总览"
        subtitle="运行时连接、版本指纹、账号权益与本地时钟。所有来自未来真实数据的位置一律显示未接入。"
        badges={
          <>
            <Chip tone="pending">运行时 未接入</Chip>
            <Chip tone="warn">证据等级 {CURRENT_EVIDENCE}</Chip>
            <Chip tone="neutral">{BUILD_TAG}</Chip>
          </>
        }
      />

      <div className="grid grid--status">
        <Section title="连接状态" description="app-server 运行时：本轮未启动、未连接、未握手。">
          <StatePanel tone="empty" title="无活动运行时连接">
            未检测到 app-server 进程。界面不会自行启动官方运行时，也不会读取官方配置或数据库。
          </StatePanel>
        </Section>

        <Section title="启动时长与时钟" description="使用本机时钟，未接入服务端校时。">
          <div className="metric-row">
            <div className="metric">
              <div className="metric__label">应用启动时长</div>
              <div className="metric__value">{uptime}</div>
              <div className="metric__unit">hh:mm:ss（本次窗口内）</div>
            </div>
            <div className="metric">
              <div className="metric__label">当前时钟</div>
              <div className="metric__value metric__value--sm">{clock.text}</div>
              <div className="metric__unit">时区固定 Asia/Shanghai</div>
            </div>
            <div className="metric">
              <div className="metric__label">窗口判定</div>
              <div className={`metric__value metric__value--sm metric__value--${windowVerdict.kind}`}>
                {windowVerdict.text}
              </div>
              <div className="metric__unit">窗口模式默认 advisory</div>
            </div>
          </div>
          <div className="hint">
            当前窗口模式：<strong>{WINDOW_MODE_LABEL['advisory']}</strong>。窗口提示只做展示，不独立决定发送权限。
          </div>
        </Section>
      </div>

      {RUNTIME_SECTIONS.map((s) => (
        <Section key={s.id} title={s.title} description={s.description}>
          <FieldList fields={s.fields} />
        </Section>
      ))}

      <Section title="证据等级说明" description="E0–E3 四级；当前一律 E0，因此发送门关闭。">
        <ul className="evidence-list">
          {(Object.keys(EVIDENCE_SUMMARY) as (keyof typeof EVIDENCE_SUMMARY)[]).map((level) => (
            <li key={level} className={`evidence${level === CURRENT_EVIDENCE ? ' evidence--current' : ''}`}>
              <span className="evidence__level">{level}</span>
              <span className="evidence__text">{EVIDENCE_SUMMARY[level]}</span>
              {level === CURRENT_EVIDENCE ? <Chip tone="warn">当前</Chip> : null}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
