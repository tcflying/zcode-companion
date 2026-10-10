/**
 * ZCC-ACCOUNT-EVIDENCE-20261009 · 总览页：标签页分组 + 「账号与权益」接真实只读目录。
 *
 * 变更要点（均为重组与接线，**没有删功能、没有改口径**）：
 *  1. 顶部按三组分组切标签：「运行时」「账号与权益」「证据说明」；
 *     页面标题与徽章行留在标签区**外**，始终可见。
 *  2. 「账号与权益」不再全是"未接入"：挂载时经 `useAccountCatalog`
 *     同源只读 `GET /v1/zcc/catalog`（零模型请求），展示真实 revision /
 *     条目总数 / 目录侧套餐通道条目数 / provider×billingClass 分布。
 *  3. 证据等级改为**计算值**（`computeEvidenceLevel`），页头徽章、账号卡、
 *     等级说明三处共用同一个 verdict，不存在两套说法。
 *
 * 未变的边界：
 *  - **权威桶读数**没有真实数据源，保持 `NO_CREDIT_LABEL`（未观测），不假填。
 *  - **ChatPage 的发送门逻辑没动**（本轮不碰会话页）；证据等级只描述证据强度，
 *    `unlocksSend` 恒为 false。
 */

import { useState } from 'react';
import { Chip, PageHeader, Section } from '../components/Chips';
import { FieldList } from '../components/FieldList';
import { StatePanel } from '../components/StatePanel';
import { ProxyStatusCard } from '../components/ProxyStatusCard';
import {
  BUILD_TAG,
  BILLING_CLASS_LABEL,
  EVIDENCE_SUMMARY,
  NO_CREDIT_LABEL,
  RUNTIME_SECTIONS,
  WINDOW_MODE_LABEL
} from '../data/snapshot';
import {
  ACCOUNT_CATALOG_PHASE_LABEL,
  countByBillingClass,
  providersOf,
  type AccountCatalogState
} from '../data/accountCatalog';
import { computeEvidenceLevel, evidenceChipLabel, evidenceTone } from '../data/evidence';
import { evaluateWindow, formatClock, formatDuration } from '../lib/format';
import type { AppState } from '../app/useAppState';
import type { DesktopState } from '../app/useDesktopState';
import type { AccountCatalogHandle } from '../app/useAccountCatalog';
import {
  describeBlockingGaps,
  READ_PHASE_LABEL,
  USAGE_WARNING_LABEL,
  type ReadStatusSourceKind
} from '../data/readStatus';

const SOURCE_KIND_LABEL: Record<ReadStatusSourceKind, string> = {
  'local-official-files': '本机官方文件（readPlanSources）',
  unknown: '未观测'
};

/**
 * E1 的完整定义（`snapshot.EVIDENCE_SUMMARY.E1`）要求「官方登录、目录、套餐资格、
 * 实际选模」四项读回成立。本轮**只满足其中「目录读回」一项**：账号握手未证明、
 * entitlement 回执只到目录口径、实际选模未观测。
 *
 * 因此当判定为 E1 时必须显式标注"部分满足"，否则用户会把上面那行 E1 原文
 * 连同"当前"徽章一起读成"四项全部成立"——那是本产品没有的事实。
 * 定义原文本身不动（它是 929 §11.4 的登记口径），只补当前态的达成度说明。
 */
const PARTIAL_EVIDENCE_NOTE =
  '目录侧部分满足：E1 完整定义需要「官方登录 / 目录 / 套餐资格 / 实际选模」四项读回成立，' +
  '本轮仅「目录读回」成立；官方登录、套餐资格回执与实际选模均未证明，故不构成完整 E1。';

type OverviewTab = 'runtime' | 'account' | 'evidence';

const OVERVIEW_TABS: ReadonlyArray<{ key: OverviewTab; label: string; hint: string }> = [
  { key: 'runtime', label: '运行时', hint: '本机反代 · 连接状态 · 时钟 · 版本' },
  { key: 'account', label: '账号与权益', hint: '只读目录读回 · 套餐资格 · 证据等级' },
  { key: 'evidence', label: '证据说明', hint: '证据读取状态 · E0–E3 定义与缺口' }
];

/** 账号/权益读取态的对外契约：App 传入自己持有的同一份状态，两处不会各读一次。 */
export interface OverviewPageProps {
  state: AppState;
  desktop: DesktopState;
  /** 由 App 持有的「账号与权益」读取态（App 也用它渲染侧栏证据等级 chip）。 */
  account: AccountCatalogHandle;
  /** 初始选中的标签（默认「运行时」）。仅供测试直接渲染指定标签内容用。 */
  initialTab?: OverviewTab;
}

export function OverviewPage({ state, desktop, account, initialTab = 'runtime' }: OverviewPageProps) {
  const [tab, setTab] = useState<OverviewTab>(initialTab);
  const clock = formatClock(state.now);
  const uptime = formatDuration(Date.now() - state.bootedAt);
  const windowVerdict = evaluateWindow(state.now);
  const verdict = computeEvidenceLevel(account);
  const summary = account.summary;

  return (
    <div className="page page--overview">
      <PageHeader
        title="总览"
        subtitle="历史驱动与资格事实、当前未观测边界、本地时钟。历史读回不等于当前账号握手或发送资格。"
        badges={
          <>
            <Chip tone="pending">当前官方进程 未观测</Chip>
            <Chip tone={evidenceTone(verdict.level)} title={verdict.reason}>
              {evidenceChipLabel(verdict)}
            </Chip>
            <Chip tone="neutral">{BUILD_TAG}</Chip>
          </>
        }
      />

      <div className="tabbar" role="tablist" aria-label="总览分组">
        {OVERVIEW_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`overview-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`overview-panel-${t.key}`}
            title={t.hint}
            className={`btn btn--tiny tabbar__btn${tab === t.key ? ' btn--tiny-on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'runtime' ? (
        <div className="tabbar__panel" role="tabpanel" id="overview-panel-runtime" aria-labelledby="overview-tab-runtime">
          <ProxyStatusCard desktop={desktop} />

          <div className="grid grid--status">
            <Section title="连接状态" description="历史驱动状态与当前进程/账号握手分开显示。">
              <StatePanel tone="empty" title={state.readStatus.snapshot ? "历史驱动事实已读回" : "历史驱动事实尚未读回"}>
                {state.readStatus.snapshot ? `历史驱动 ${state.readStatus.snapshot.driver.kind}/${state.readStatus.snapshot.driver.status}；` : "请开启本机 API 并手动只读刷新；"}
                当前官方进程、监听与心跳未观测，账号握手未证明。driver.ready 不是当前账号握手证明。
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

          {RUNTIME_SECTIONS.filter((s) => s.id === 'runtime').map((s) => (
            <Section key={s.id} title={s.title} description={s.description}>
              <FieldList fields={s.fields.map((field) => {
                const snapshot = state.readStatus.snapshot;
                if (field.label === '运行时状态') return { ...field, value: { kind: 'text' as const, value: snapshot ? '历史驱动 ' + snapshot.driver.kind + '/' + snapshot.driver.status : '历史驱动尚未读回' }, note: '当前进程与账号握手未观测' };
                return field;
              })} />
            </Section>
          ))}
        </div>
      ) : null}

      {tab === 'account' ? (
        <div className="tabbar__panel" role="tabpanel" id="overview-panel-account" aria-labelledby="overview-tab-account">
          <Section
            title="账号与权益"
            description="只读 GET /v1/zcc/catalog（同源，零模型请求、不带凭据；桌面壳由主进程注入 Bearer，不出回环）。读回的是目录事实：目录条目出现某个计费类别，不等于账号已确认有资格。"
            actions={
              <>
                <Chip tone={account.phase === 'loaded' ? 'accent' : account.phase === 'failed' ? 'danger' : 'neutral'}>
                  {ACCOUNT_CATALOG_PHASE_LABEL[account.phase]}
                </Chip>
                <button
                  type="button"
                  className="btn btn--tiny"
                  disabled={account.phase === 'loading'}
                  title="只读重读一次目录（不发送任何模型请求）"
                  onClick={() => { void account.refresh(); }}
                >
                  {account.phase === 'loading' ? '读取中…' : '只读刷新'}
                </button>
              </>
            }
          >
            <dl className="source-facts">
              <div>
                <dt>目录 revision</dt>
                <dd>{summary?.revision ?? (account.phase === 'loading' ? '读取中' : '未接入')}</dd>
              </div>
              <div>
                <dt>目录条目总数</dt>
                <dd>{summary === null ? '未接入' : `${summary.total} 条`}</dd>
              </div>
              <div>
                <dt>目录侧套餐/活动通道条目</dt>
                <dd>{summary === null ? '未接入' : `${summary.entitled} 条`}</dd>
              </div>
              <div>
                <dt>provider 数</dt>
                <dd>{summary === null ? '未接入' : `${providersOf(summary).length} 个`}</dd>
              </div>
              <div>
                <dt>权威桶读数</dt>
                <dd>{NO_CREDIT_LABEL}（无真实数据源，不假填）</dd>
              </div>
              <div>
                <dt>读回时刻</dt>
                <dd>{account.loadedAt === null ? '未读回' : new Date(account.loadedAt).toLocaleString()}</dd>
              </div>
            </dl>

            <div className="row-note">
              「目录侧套餐/活动通道条目」= 本轮目录读回里 <span className="mono">billingClass ∈ {'{subscription, promotion}'}</span> 的条目数。
              它是**目录口径**的资格证据：目录里出现了走套餐通道的条目，**不等于**当前账号对这些套餐有资格
              （账号握手、选模、权威桶在本轮仍未观测）。条目恒为未验证、不可发送。
            </div>

            {account.phase === 'idle' ? (
              <div className="notice" role="status">
                <span className="notice__tag">未接入</span>
                <span className="notice__text">
                  尚未读回目录（还没有读到任何条目）。点上方「只读刷新」重读一次；读不到时会在这里显示失败原因码，不填任何占位数据。
                </span>
              </div>
            ) : null}

            {account.failure !== null ? (
              <div className="notice notice--danger" role="status">
                <span className="notice__tag">读取失败</span>
                <span className="notice__text">
                  {account.failure.code}：{account.failure.message}
                  （失败不保留旧目录，旧条目不得冒充当前）
                </span>
              </div>
            ) : null}

            <div className="notice notice--info" role="status">
              <span className="notice__tag">当前等级</span>
              <span className="notice__text">
                <strong>{verdict.level}</strong>（{verdict.reasonCode}）——{verdict.reason}
              </span>
            </div>
          </Section>

          {RUNTIME_SECTIONS.filter((s) => s.id === 'account').map((s) => (
            <Section key={s.id} title={s.title} description={s.description}>
              <FieldList fields={s.fields.map((field) => {
                if (field.label === '账号状态') return { ...field, value: { kind: 'text' as const, value: accountStateLabel(account) }, note: verdict.reason };
                if (field.label === '套餐资格') return { ...field, value: { kind: 'text' as const, value: entitlementLabel(account) }, note: '目录侧口径：billingClass = subscription | promotion 的条目数；不是账号资格回执' };
                if (field.label === '可用 provider') return { ...field, value: { kind: 'text' as const, value: providerLabel(account) }, note: '来自本轮读回的目录条目，不代表账号可用' };
                if (field.label === '活动优惠') return { ...field, value: { kind: 'text' as const, value: promotionLabel(account) }, note: 'promotion 计费类别的目录条目数；活动时间与资格未观测' };
                if (field.label === '证据等级') return { ...field, value: { kind: 'text' as const, value: verdict.level }, note: EVIDENCE_SUMMARY[verdict.level] };
                return field;
              })} />
            </Section>
          ))}

          <Section
            title="provider × 计费类别分布"
            description="逐条来自本轮目录读回；服务端未返回的维度不补、不猜。"
          >
            {account.phase === 'loading' ? (
              <StatePanel tone="loading" title="读取中">正在只读读取目录；读回完成前不显示任何条目，也不用上一次结果顶替。</StatePanel>
            ) : summary === null ? (
              <StatePanel tone="empty" title="未接入">没有读回任何目录条目，下面不列任何 provider/计费类别。</StatePanel>
            ) : summary.buckets.length === 0 ? (
              <StatePanel tone="empty" title="目录为空">目录读回成功但 0 条条目（revision {summary.revision}）。空目录是事实，不补占位条目。</StatePanel>
            ) : (
              <ul className="rule-list rule-list--tight">
                {summary.buckets.map((b) => (
                  <li className="rule" key={`${b.provider}/${b.billingClass}`}>
                    <span className="rule__class">{b.provider}</span>
                    <span className="rule__label">{BILLING_CLASS_LABEL[b.billingClass]}</span>
                    <span className="rule__text">×{b.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div className="tabbar__panel" role="tabpanel" id="overview-panel-evidence" aria-labelledby="overview-tab-evidence">
          {/* 版本与指纹是证据链的第一环：先说清"我运行的是哪一份产物"，再谈等级。 */}
          {RUNTIME_SECTIONS.filter((s) => s.id === 'version').map((s) => (
            <Section key={s.id} title={s.title} description={s.description}>
              <FieldList fields={s.fields} />
            </Section>
          ))}
          {/* ZCC-GUI-EVIDENCE-20261008-A：真实读取态。默认 idle=零网络，需手动点刷新。 */}
          <Section
            title="证据读取状态（只读）"
            description="只读 GET /v1/zcc/readstatus。默认不发请求；需开启「连接本机 API」后手动刷新。读到的是历史读取事实，不是当前资格——服务端明示 validityWindowKnown=false，本层据此仍不定级。"
          >
            <div className="row-actions">
              <button
                type="button"
                className="btn btn--tiny"
                onClick={() => { void state.refreshReadStatus(); }}
                disabled={state.readStatus.phase === 'loading' || !state.localApiEnabled}
                title={state.localApiEnabled ? '手动只读刷新一次证据状态' : '需先在设置页开启「连接本机 API」'}
              >
                {state.readStatus.phase === 'loading' ? '读取中…' : '只读刷新'}
              </button>
              <Chip tone={state.readStatus.phase === 'loaded' ? 'accent' : state.readStatus.phase === 'failed' ? 'danger' : 'neutral'}>
                {READ_PHASE_LABEL[state.readStatus.phase]}
              </Chip>
            </div>

            {state.readStatus.failure !== null ? (
              <div className="notice notice--danger" role="status">
                <span className="notice__tag">读取失败</span>
                <span className="notice__text">
                  {state.readStatus.failure.code}：{state.readStatus.failure.message}
                  （失败不保留旧事实，避免拿上一次的结果冒充当前）
                </span>
              </div>
            ) : null}

            {state.readStatus.snapshot !== null ? (
              <>
                <ul className="evidence-list">
                  <li className="evidence">
                    <span className="evidence__level">驱动</span>
                    <span className="evidence__text">
                      运行驱动器 {state.readStatus.snapshot.driver.kind} · 状态 {state.readStatus.snapshot.driver.status} ·
                      目录 {state.readStatus.snapshot.driver.catalogCount ?? '未观测'} 条 / 可服务 {state.readStatus.snapshot.driver.servableCount ?? '未观测'} 条
                    </span>
                  </li>
                  <li className="evidence">
                    <span className="evidence__level">来源</span>
                    <span className="evidence__text">
                      数据来源 {SOURCE_KIND_LABEL[state.readStatus.snapshot.catalog.sourceKind]}（与上面的运行驱动器是两层不同的事）·
                      revision {state.readStatus.snapshot.catalog.revision ?? '未观测'} ·
                      源条目 {state.readStatus.snapshot.catalog.entryCount ?? '未观测'} ·
                      读回于 {state.readStatus.snapshot.catalog.readAt === null ? '未知' : new Date(state.readStatus.snapshot.catalog.readAt).toLocaleString()}
                    </span>
                  </li>
                  <li className="evidence">
                    <span className="evidence__level">资格</span>
                    <span className="evidence__text">
                      {state.readStatus.snapshot.entitlement === null
                        ? '未读到资格证据'
                        : `资格源 ${state.readStatus.snapshot.entitlement.present ? '存在' : '缺失'} · 计数 ${state.readStatus.snapshot.entitlement.itemCount} 条（可用/不可用/未知 ${state.readStatus.snapshot.entitlement.availableCount}/${state.readStatus.snapshot.entitlement.unavailableCount}/${state.readStatus.snapshot.entitlement.unknownCount}）`}
                    </span>
                  </li>
                  <li className="evidence">
                    <span className="evidence__level">选模</span>
                    <span className="evidence__text">
                      {state.readStatus.snapshot.selection === null
                        ? '未读到选模证据'
                        : `选模源 ${state.readStatus.snapshot.selection.present ? '存在' : '缺失'} · 有效选模 ${state.readStatus.snapshot.selection.selectedCount} 条`}
                    </span>
                  </li>
                </ul>
                <div className="notice notice--danger" role="status">
                  <span className="notice__tag">E1 阻断缺口</span>
                  <span className="notice__text">
                    {describeBlockingGaps(state.readStatus.snapshot).join('、')}
                  </span>
                </div>
                <div className="notice" role="status">
                  <span className="notice__tag">仅影响 E3</span>
                  <span className="notice__text">
                    {state.readStatus.snapshot.usageWarnings.map((w) => USAGE_WARNING_LABEL[w]).join('、')}
                  </span>
                </div>
              </>
            ) : null}
          </Section>

          <Section title="证据等级说明" description={`E0–E3 四级。当前按读回状态计算为 ${verdict.level}；发送门是否解锁与等级无关（本产品不存在可点击发送入口）。`}>
            <ul className="evidence-list rule-list--tight">
              {(Object.keys(EVIDENCE_SUMMARY) as (keyof typeof EVIDENCE_SUMMARY)[]).map((level) => (
                <li key={level} className={`evidence${level === verdict.level ? ' evidence--current' : ''}`}>
                  <span className="evidence__level">{level}</span>
                  <span className="evidence__text">{EVIDENCE_SUMMARY[level]}</span>
                  {level === verdict.level ? (
                    <Chip tone={evidenceTone(verdict.level)} title={level === 'E1' ? PARTIAL_EVIDENCE_NOTE : undefined}>
                      {level === 'E1' ? '当前 · 部分满足' : '当前'}
                    </Chip>
                  ) : null}
                </li>
              ))}
            </ul>
            {verdict.level === 'E1' ? (
              <div className="notice notice--warn" role="status">
                <span className="notice__tag">部分满足</span>
                <span className="notice__text">{PARTIAL_EVIDENCE_NOTE}</span>
              </div>
            ) : null}
            <div className="hint">
              当前判定：<strong>{verdict.level}</strong>（{verdict.reasonCode}）——{verdict.reason}
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 「账号与权益」各字段的真实取值（全部由读取态推导，无任何占位假数据）
 * ------------------------------------------------------------------ */

function accountStateLabel(catalog: AccountCatalogState): string {
  switch (catalog.phase) {
    case 'idle':
      return '未接入：尚未只读读取目录';
    case 'loading':
      return '读取中：目录读回完成前不定论';
    case 'failed':
      return `未接入：目录读取失败（${catalog.failure?.code ?? 'unknown'}）`;
    case 'loaded': {
      const s = catalog.summary;
      if (s === null || s.total === 0) return '未接入：目录为空，无账号事实';
      if (s.entitled === 0) return '未接入：目录里没有套餐/活动通道条目';
      return `已接入（目录侧）：${s.entitled} 条套餐/活动通道条目；账号握手仍未证明`;
    }
    default:
      return '未接入';
  }
}

function entitlementLabel(catalog: AccountCatalogState): string {
  const s = catalog.summary;
  if (s === null) return '未接入';
  return `目录侧套餐/活动通道条目 ${s.entitled} 条 / 目录条目共 ${s.total} 条（revision ${s.revision}）`;
}

function providerLabel(catalog: AccountCatalogState): string {
  const list = providersOf(catalog.summary);
  return list.length === 0 ? '未接入' : `${list.length} 个：${list.join('、')}`;
}

function promotionLabel(catalog: AccountCatalogState): string {
  const s = catalog.summary;
  if (s === null) return '未接入';
  const n = countByBillingClass(s, 'promotion');
  return n === 0 ? '目录里没有 promotion 条目（活动时间与资格未观测）' : `目录侧 promotion 条目 ${n} 条`;
}