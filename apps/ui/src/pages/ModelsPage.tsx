import { useCallback, useMemo, useRef, useState } from 'react';
import { Chip, PageHeader, Section } from '../components/Chips';
import {
  BILLING_CLASSES,
  BILLING_CLASS_LABEL,
  BILLING_CLASS_RULE,
  BILLING_CLASS_SENDABLE,
  CURRENT_EVIDENCE,
  MODEL_COLUMNS,
  NO_CREDIT_LABEL,
  NO_CREDIT_NOTICE,
  SEND_DISABLED_LABEL,
  SEND_GATE_CLOSED_NOTICE,
  USAGE_SOURCES,
  type BillingClass
} from '../data/snapshot';
import {
  EMPTY_MANUAL_DRAFT,
  MANUAL_ENTRY_BADGE,
  SOURCE_CONTRACT_NOTE,
  SOURCE_ENDPOINT,
  SOURCE_MODE_DESC,
  SOURCE_MODE_LABEL,
  SOURCE_MODES,
  SOURCE_TRANSPORT_DESC,
  SOURCE_TRANSPORT_LABEL,
  SOURCE_TRANSPORTS,
  UNVERIFIED_LABEL,
  activeEntries,
  addManualEntry,
  channelAccepted,
  createInitialSourceState,
  describeRefreshFailure,
  filterEntries,
  fixtureScenarioLabel,
  isFixtureScenario,
  describeDelta,
  removeManualEntry,
  runRefresh,
  sendEligibilityFor,
  switchMode,
  type ManualDraft,
  type ModelEntry,
  type RefreshState,
  type SourceMode,
  type SourceTransport
} from '../data/modelSource';
import { StatePanel } from '../components/StatePanel';
import {
  CSP_CONNECT_SRC,
  LOOPBACK_HOSTNAMES,
  resolveCatalogUrl,
  resolveSourceLoaderForUi
} from '../data/localApiSource';
import type { AppState } from '../app/useAppState';
import { READ_PHASE_LABEL } from '../data/readStatus';

type Filter = 'all' | BillingClass;

const SKELETON_ROWS = 3;

/**
 * 只读取 `?sourceFixture=<场景名>`。这是**截图/离线测试专用的测试态开关**：
 * 不带该参数时来源执行器是 offlineSourceLoader（不发起任何网络请求），
 * 因此这层 gate 不会把任何 fixture 变成正常运行路径。
 */
function readFixtureScenario(): string | null {
  try {
    const raw = new URL(window.location.href).searchParams.get('sourceFixture');
    return raw && isFixtureScenario(raw) ? raw : null;
  } catch {
    return null;
  }
}

function formatStamp(ts: number | null): string {
  if (ts === null) return '未刷新过';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '时间无效';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}（本机时钟）`;
}

/**
 * 刷新失败面板：**所有**失败原因都渲染「原因码 + 人读说明 + 处理建议」。
 * 文案一律取自 `describeRefreshFailure()`（modelSource.ts 里的单一来源），
 * 未知原因码走通用兜底（显示原始码 + 兜底说明），不空白、不吞掉。
 */
function RefreshFailureDetails({ state }: { state: RefreshState }) {
  const failure = state.failure;
  if (!failure) return null;
  const view = describeRefreshFailure(failure.reason);
  const kept = state.entries;
  return (
    <div className="fail-detail">
      <p className="fail-detail__row">
        <span className="fail-detail__key">失败原因</span>
        <span className="fail-detail__val mono">
          {failure.reason || '（空）'}
          {view.known ? '' : '（未登记原因码，已按通用兜底渲染）'}
        </span>
      </p>
      <p className="fail-detail__row">
        <span className="fail-detail__key">人读标题</span>
        <span className="fail-detail__val">{view.info.title}</span>
      </p>
      <p className="fail-detail__row">
        <span className="fail-detail__key">发生时间</span>
        <span className="fail-detail__val">{formatStamp(state.lastAttemptAt)}</span>
      </p>
      <p className="fail-detail__row">
        <span className="fail-detail__key">人读说明</span>
        <span className="fail-detail__val">{view.info.human}</span>
      </p>
      <p className="fail-detail__row">
        <span className="fail-detail__key">处理建议</span>
        <span className="fail-detail__val">{failure.hint || view.info.remedy}</span>
      </p>
      <p className="fail-detail__row">
        <span className="fail-detail__key">本次技术说明</span>
        <span className="fail-detail__val">{failure.detail}</span>
      </p>
      {failure.defects && failure.defects.length > 0 ? (
        <p className="fail-detail__row">
          <span className="fail-detail__key">契约缺陷</span>
          <span className="fail-detail__val">
            {failure.defects.length} 条（整体拒绝，一条都不采纳）：
            <br />
            {failure.defects.map((d) => (
              <span className="mono" key={`${d.code}@${d.path}`}>
                {d.code} @ {d.path}
                <br />
              </span>
            ))}
          </span>
        </p>
      ) : null}
      <p className="fail-detail__row">
        <span className="fail-detail__key">当前列表</span>
        <span className="fail-detail__val">
          保留刷新前读到的 {kept.length} 条（不清空、不填假数据）
          {kept.length > 0 ? (
            <>
              ，表格里仍是：
              <span className="mono"> {kept.map((e) => e.modelId).join('、')}</span>
            </>
          ) : (
            '（此前没有成功读回过条目，本次失败没有可保留的旧列表）'
          )}
        </span>
      </p>
    </div>
  );
}

export function ModelsPage({ state }: { state: AppState }) {
  const readStatusSummary = ((): string => {
    const s = state.readStatus.snapshot;
    if (s === null) return '未读到证据状态。';
    const d = s.driver;
    return `运行驱动器 ${d.kind} / ${d.status}；E1 阻断 ${s.e1Blocking.length} 项。`
      + '读取只读事实不构成资格：账号、资格时效、实际选模仍未证明，条目仍不可发送。';
  })();
  const [mode, setMode] = useState<SourceMode>('dynamic');
  const [transport, setTransport] = useState<SourceTransport>('local_api');
  const [refresh, setRefresh] = useState<RefreshState>(() => createInitialSourceState().refresh);
  const [manualEntries, setManualEntries] = useState<ModelEntry[]>([]);
  const [draft, setDraft] = useState<ManualDraft>(EMPTY_MANUAL_DRAFT);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [fixtureScenario] = useState<string | null>(() => readFixtureScenario());
  const busy = useRef(false);

  // 来源执行器决策点（UI04）：
  //   1) ?sourceFixture= 命中已登记场景 → 本地 fixture 执行器（测试态，零网络）；
  //   2) 设置页未开启「连接本机 API」（默认）→ offlineSourceLoader（零网络）；
  //   3) 否则 → 回环 fetch 执行器（唯一网络出口，带回环守卫）。
  // 该决策点有对象同一性的单元测试钉住（localApiSource.test.ts / modelSource.test.ts）。
  const sourceLoader = useMemo(
    () =>
      resolveSourceLoaderForUi({
        fixtureScenario,
        localApiEnabled: state.localApiEnabled,
        baseUrl: state.localApiBaseUrl
      }),
    [fixtureScenario, state.localApiEnabled, state.localApiBaseUrl]
  );

  const catalogUrlVerdict = useMemo(
    () => resolveCatalogUrl(state.localApiBaseUrl),
    [state.localApiBaseUrl]
  );

  const sourceState = useMemo(
    () => ({ mode, refresh, manualEntries }),
    [mode, refresh, manualEntries]
  );

  const handleSwitch = useCallback(
    (next: SourceMode) => {
      const r = switchMode({ mode, refresh, manualEntries }, next);
      setMode(r.state.mode);
      setNotice({ tone: r.preserved ? 'warn' : 'ok', text: r.notice });
      state.log('INFO', 'ui.source', `来源模式切换：${r.notice}`);
    },
    [mode, refresh, manualEntries, state]
  );

  const handleRefresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRefresh((r) => ({ ...r, status: 'loading', failure: null }));
    setNotice({
      tone: 'ok',
      text: fixtureScenario
        ? `正在读取来源：测试态 fixture（${fixtureScenarioLabel(fixtureScenario)}），零网络。`
        : state.localApiEnabled
          ? `正在读取来源：${SOURCE_TRANSPORT_LABEL[transport]} → ${catalogUrlVerdict.ok ? catalogUrlVerdict.url : '（被回环守卫拒绝）'}。只读取目录，不发送任何模型请求。`
          : `正在读取来源：${SOURCE_TRANSPORT_LABEL[transport]}（未开启，零网络）。只读取目录，不发送任何模型请求。`
    });
    const next = await runRefresh(
      { ...refresh, transport },
      sourceLoader,
      () => Date.now()
    );
    setRefresh(next);
    busy.current = false;
    if (next.status === 'failed' && next.failure) {
      const view = describeRefreshFailure(next.failure.reason);
      setNotice({
        tone: 'error',
        text: `刷新失败：${view.info.title}（${view.known ? view.code : `未登记原因码 ${view.code}`}）—— ${next.failure.detail}`
      });
      state.log('WARN', 'ui.source', `来源刷新失败（${next.failure.reason}）：${next.failure.detail}`);
      return;
    }
    const delta = next.delta === null ? '' : describeDelta(next.delta);
    setNotice({ tone: 'ok', text: `刷新完成：${delta}。条目可用性仍为「${UNVERIFIED_LABEL}」。` });
    state.log('INFO', 'ui.source', `来源刷新完成：${delta}`);
  }, [refresh, transport, state, sourceLoader, fixtureScenario, state.localApiEnabled, catalogUrlVerdict]);

  const handleAdd = useCallback(() => {
    const r = addManualEntry({ mode, refresh, manualEntries }, draft);
    if (!r.entry) {
      setNotice({ tone: 'error', text: r.notice });
      return;
    }
    setManualEntries(r.state.manualEntries);
    setDraft(EMPTY_MANUAL_DRAFT);
    setNotice({ tone: 'ok', text: r.notice });
    state.log('INFO', 'ui.source', `写死条目已录入：${r.entry.displayName}（${MANUAL_ENTRY_BADGE}，不可发送）`);
  }, [draft, mode, refresh, manualEntries, state]);

  const handleRemove = useCallback(
    (key: string) => {
      const r = removeManualEntry({ mode, refresh, manualEntries }, key);
      setManualEntries(r.manualEntries);
      setNotice({ tone: 'warn', text: '已删除 1 条手工录入条目。删除只影响本机内存中的写死列表。' });
      state.log('INFO', 'ui.source', '写死条目已删除。');
    },
    [mode, refresh, manualEntries, state]
  );

  const active = activeEntries(sourceState);
  const visible = filterEntries(active, query, filter);
  const isManual = mode === 'manual';

  const filterNote = useMemo(() => {
    const base = filter === 'all' ? '当前筛选：全部计费类别' : `当前筛选：${BILLING_CLASS_LABEL[filter]}`;
    return `${base} · 来源模式 ${SOURCE_MODE_LABEL[mode]}`;
  }, [filter, mode]);

  const deltaText = useMemo(() => {
    if (refresh.status !== 'ok' && refresh.status !== 'failed') return null;
    if (refresh.entries.length === 0) return null;
    return refresh.delta === null ? null : describeDelta(refresh.delta);
  }, [refresh]);

  return (
    <div className="page">
      <PageHeader
        title="模型与套餐"
        subtitle="来源有两种模式，由您自己选：动态刷新（点刷新重新读取来源）或写死固定（手工录入）。两种模式都只影响列表来源，不影响发送门。"
        badges={
          <>
            <Chip tone="accent">来源模式 {mode === 'dynamic' ? '动态刷新' : '写死固定'}</Chip>
            <Chip tone="danger">额度 {NO_CREDIT_LABEL}</Chip>
            <Chip tone="warn">证据等级 {CURRENT_EVIDENCE}</Chip>
            <Chip tone="danger">零 dispatch</Chip>
          </>
        }
      />

      <Section
        title="来源模式"
        description="两种模式随时可切换，切换不会清空任何已输入内容：写死条目与上次读到的来源条目都保留，切回即恢复显示。"
        actions={<Chip tone="pending">条目可用性一律「{UNVERIFIED_LABEL}」</Chip>}
      >
        <div className="radio-group" role="radiogroup" aria-label="模型/套餐来源模式">
          {SOURCE_MODES.map((m) => (
            <label key={m} className={`radio${mode === m ? ' radio--on' : ''}`}>
              <input
                type="radio"
                name="source-mode"
                value={m}
                checked={mode === m}
                onChange={() => handleSwitch(m)}
              />
              <span className="radio__text">
                <span className="radio__title">{SOURCE_MODE_LABEL[m]}</span>
                <span className="radio__desc">{SOURCE_MODE_DESC[m]}</span>
              </span>
              <Chip tone={mode === m ? 'accent' : 'neutral'}>
                {mode === m ? '当前生效' : '可切换'}
              </Chip>
            </label>
          ))}
        </div>

        {notice ? (
          <div
            className={`notice notice--${notice.tone === 'error' ? 'danger' : notice.tone === 'warn' ? 'warn' : 'ok'}`}
            role="status"
          >
            <span className="notice__tag">提示</span>
            <span className="notice__text">{notice.text}</span>
          </div>
        ) : null}

        {isManual && fixtureScenario ? (
          <div className="notice notice--warn" role="status">
            <span className="notice__tag">测试态</span>
            <span className="notice__text">
              本页仍处于 URL 参数 <span className="mono">?sourceFixture={fixtureScenario}</span>{' '}
              切到本地 fixture 的测试态（{fixtureScenarioLabel(fixtureScenario)}）。这是离线测试 / 截图取证用的测试态，
              <strong>不发起任何网络请求、不读任何真实目录</strong>。当前是「写死固定」模式，表格里显示的是
              <strong>你手工录入的条目，不是 fixture 数据</strong>；动态模式刷新读到的 fixture 条目仍保留在本机内存里，切回动态模式即可看到，同样不获得任何可发送资格。不带该参数时来源通道一律按 <span className="mono">transport_not_wired</span> 失败。
            </span>
          </div>
        ) : null}

        {isManual ? (
          <div className="manual-form">
            <div className="manual-form__head">
              <h3 className="manual-form__title">手工录入一条模型</h3>
              <Chip tone="danger">{MANUAL_ENTRY_BADGE}</Chip>
            </div>
            <div className="manual-grid">
              <label className="manual-grid__cell">
                <span className="toolbar__label">显示名 *</span>
                <input
                  className="input"
                  data-field="displayName"
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                />
              </label>
              <label className="manual-grid__cell">
                <span className="toolbar__label">provider</span>
                <input
                  className="input"
                  data-field="provider"
                  value={draft.provider}
                  placeholder="留空显示 unknown"
                  onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
                />
              </label>
              <label className="manual-grid__cell">
                <span className="toolbar__label">modelId *</span>
                <input
                  className="input"
                  data-field="modelId"
                  value={draft.modelId}
                  onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                />
              </label>
              <label className="manual-grid__cell">
                <span className="toolbar__label">计费类别</span>
                <select
                  className="input input--select"
                  data-field="billingClass"
                  value={draft.billingClass}
                  onChange={(e) => setDraft({ ...draft, billingClass: e.target.value as BillingClass })}
                >
                  {BILLING_CLASSES.map((b) => (
                    <option key={b} value={b}>
                      {BILLING_CLASS_LABEL[b]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="manual-grid__cell">
                <span className="toolbar__label">上下文长度（token）</span>
                <input
                  className="input"
                  data-field="contextLength"
                  value={draft.contextLength}
                  placeholder="留空 = 来源未提供"
                  onChange={(e) => setDraft({ ...draft, contextLength: e.target.value })}
                />
              </label>
              <label className="manual-grid__cell">
                <span className="toolbar__label">推理档位</span>
                <input
                  className="input"
                  data-field="reasoning"
                  value={draft.reasoning}
                  placeholder="留空 = 来源未提供"
                  onChange={(e) => setDraft({ ...draft, reasoning: e.target.value })}
                />
              </label>
              <label className="manual-grid__cell manual-grid__cell--wide">
                <span className="toolbar__label">能力标签（逗号分隔）</span>
                <input
                  className="input"
                  data-field="capabilities"
                  value={draft.capabilities}
                  onChange={(e) => setDraft({ ...draft, capabilities: e.target.value })}
                />
              </label>
              <label className="manual-grid__cell manual-grid__cell--wide">
                <span className="toolbar__label">备注（选填）</span>
                <input
                  className="input"
                  data-field="note"
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </div>
            <div className="manual-form__actions">
              <button type="button" className="btn btn--primary" onClick={handleAdd}>
                录入条目
              </button>
              <span className="manual-form__count">
                已录入 {manualEntries.length} 条 · 全部标记「{MANUAL_ENTRY_BADGE}」· 全部
                「{UNVERIFIED_LABEL}」
              </span>
            </div>
          </div>
        ) : (
          <div className="source-refresh">
            <div className="toolbar">
              <label className="toolbar__field">
                <span className="toolbar__label">来源通道</span>
                <select
                  className="input input--select"
                  data-field="transport"
                  value={transport}
                  onChange={(e) => {
                    const t = e.target.value as SourceTransport;
                    setTransport(t);
                    setNotice({ tone: 'ok', text: `来源通道已切换为「${SOURCE_TRANSPORT_LABEL[t]}」。` });
                  }}
                >
                  {SOURCE_TRANSPORTS.map((t) => (
                    <option key={t} value={t}>
                      {SOURCE_TRANSPORT_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleRefresh()}
                disabled={refresh.status === 'loading'}
              >
                刷新来源（只读取，不发送）
              </button>
            </div>
            <p className="source-refresh__desc">{SOURCE_TRANSPORT_DESC[transport]}</p>
            <div className="notice notice--info" role="status">
              <span className="notice__tag">网络边界</span>
              <span className="notice__text">
                {fixtureScenario ? (
                  <>
                    当前处于测试态：来源执行器被 URL 参数{' '}
                    <span className="mono">?sourceFixture={fixtureScenario}</span> 切到本地 fixture，
                    <strong>不发起任何网络请求</strong>。
                  </>
                ) : transport === 'local_config_file' ? (
                  <>
                    当前选择本地配置文件来源：文件读取尚未接线，<strong>本次不请求本机 API，零网络</strong>。
                    刷新按 <span className="mono">transport_not_wired</span> 失败并保留已有列表。
                  </>
                ) : state.localApiEnabled ? (
                  <>
                    已开启「连接本机 API」：刷新会真实请求{' '}
                    <span className="mono">
                      {catalogUrlVerdict.ok ? catalogUrlVerdict.url : '（base URL 被回环守卫拒绝）'}
                    </span>
                    ，只读取目录、<strong>不发送任何模型请求</strong>。回环守卫只放行{' '}
                    {LOOPBACK_HOSTNAMES.join(' / ')} 或同源；浏览器 CSP{' '}
                    <span className="mono">connect-src {CSP_CONNECT_SRC}</span>，其他来源一律被拒。
                  </>
                ) : (
                  <>
                    <strong>未开启「连接本机 API」：本页完全零网络</strong>。刷新按{' '}
                    <span className="mono">transport_not_wired</span> 失败并显示原因，不回退到空列表或假数据。
                    需要联调时到「设置 → 本机 API」打开开关（base URL 留空 = 同源）。
                  </>
                )}
              </span>
            </div>
            {fixtureScenario ? (
              <div className="notice notice--warn" role="status">
                <span className="notice__tag">测试态</span>
                <span className="notice__text">
                  来源执行器被 URL 参数 <span className="mono">?sourceFixture={fixtureScenario}</span>{' '}
                  切到本地 fixture（{fixtureScenarioLabel(fixtureScenario)}）。这是离线测试 / 截图取证用的测试态，
                  <strong>不发起任何网络请求、不读任何真实目录</strong>；下面的条目全部是 fixture 数据（modelId 一律带{' '}
                  <span className="mono">fixture-</span> 前缀），不是真实模型，也不获得任何可发送资格。不带该参数时来源通道一律按{' '}
                  <span className="mono">transport_not_wired</span> 失败。
                </span>
              </div>
            ) : null}
            <dl className="source-facts">
              <div>
                <dt>最近一次刷新</dt>
                <dd>{formatStamp(refresh.lastAttemptAt)}</dd>
              </div>
              <div>
                <dt>最近一次成功</dt>
                <dd>{formatStamp(refresh.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt>结果</dt>
                <dd>
                  {refresh.status === 'idle'
                    ? '尚未刷新'
                    : refresh.status === 'loading'
                      ? '读取中'
                      : refresh.status === 'ok'
                        ? '成功'
                        : '失败'}
                  （点击刷新 {refresh.attemptCount} 次）
                </dd>
              </div>
              <div>
                <dt>来源 revision</dt>
                <dd>{refresh.revision}</dd>
              </div>
              <div>
                <dt>当前列表条目</dt>
                <dd>{refresh.entries.length}</dd>
              </div>
              <div>
                <dt>列表变化</dt>
                <dd>{deltaText ?? '尚无成功读回记录'}</dd>
              </div>
            </dl>
            <div className="notice notice--info">
              <span className="notice__tag">契约</span>
              <span className="notice__text">{SOURCE_CONTRACT_NOTE}</span>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="额度 / 桶读数"
        description="三个来源必须分栏：单位不同、采集方不同、不能互相替代，也不能合并成一个“余额”。"
        actions={<Chip tone="danger">{NO_CREDIT_LABEL}</Chip>}
      >
        <div className="usage-grid">
          {USAGE_SOURCES.map((u) => (
            <article className="usage-card" key={u.id}>
              <header className="usage-card__head">
                <h3 className="usage-card__title">{u.title}</h3>
                <Chip tone="danger">{NO_CREDIT_LABEL}</Chip>
              </header>
              <div className="usage-card__row">
                <span className="usage-card__key">单位</span>
                <span className="usage-card__val">{u.unit}</span>
              </div>
              <div className="usage-card__row">
                <span className="usage-card__key">来源</span>
                <span className="usage-card__val">{u.source}</span>
              </div>
              <div className="usage-card__row">
                <span className="usage-card__key">读数</span>
                <span className="usage-card__val usage-card__val--pending">{NO_CREDIT_LABEL}</span>
              </div>
              <p className="usage-card__note">{u.note}</p>
            </article>
          ))}
        </div>
        <div className="notice notice--warn">
          <span className="notice__tag">额度</span>
          <span className="notice__text">{NO_CREDIT_NOTICE}</span>
        </div>
        <div className="notice notice--danger" role="status">
          <span className="notice__tag">{CURRENT_EVIDENCE}</span>
          <span className="notice__text">{SEND_GATE_CLOSED_NOTICE}</span>
        </div>
        {/* ZCC-GUI-EVIDENCE-20261008-A：读取只读事实**不构成资格**，发送门不变。 */}
        <div className="notice" role="status">
          <span className="notice__tag">读取态</span>
          <span className="notice__text">
            {READ_PHASE_LABEL[state.readStatus.phase]}。
            {state.readStatus.snapshot === null
              ? '未读到证据状态，所有可用性一律显示未验证。'
              : readStatusSummary}
          </span>
        </div>
      </Section>

      <Section
        title="模型 / 套餐目录"
        description={`目录 revision ${refresh.lastSuccessAt === null ? 'unknown' : refresh.revision} · 账号 epoch unknown · 配置 revision unknown · 最近同步 ${refresh.lastSuccessAt === null ? 'unknown' : formatStamp(refresh.lastSuccessAt)} · 当前展示条目 ${visible.length}（来源模式：${SOURCE_MODE_LABEL[mode]}）`}
        actions={
          <div className="toolbar">
            <label className="toolbar__field">
              <span className="toolbar__label">搜索</span>
              <input
                type="search"
                className="input"
                value={query}
                placeholder="按显示名 / provider / modelId 过滤"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="toolbar__field">
              <span className="toolbar__label">计费类别</span>
              <select
                className="input input--select"
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
              >
                <option value="all">全部</option>
                {BILLING_CLASSES.map((b) => (
                  <option key={b} value={b}>
                    {BILLING_CLASS_LABEL[b]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      >
        <div className="table-toolbar-note">
          {filterNote} · 搜索词「{query || '（空）'}」· 来源条目 {active.length} 条
          {isManual ? `（全部为${MANUAL_ENTRY_BADGE}）` : ''}
          {fixtureScenario
            ? isManual
              ? `（测试态：本页来源执行器已被 ?sourceFixture=${fixtureScenario} 切到本地 fixture；当前为写死固定模式，表格里是手工录入条目，不是 fixture 数据）`
              : `（测试态 fixture 数据，非真实模型 · 端点 ${SOURCE_ENDPOINT}）`
            : ''}
        </div>

        <div className="table-wrap" role="region" aria-label="模型与套餐列表" tabIndex={0}>
          <table className="table table--models">
            <thead>
              <tr>
                {MODEL_COLUMNS.map((c) => (
                  <th key={c.key} scope="col" style={{ width: c.width }}>
                    <span className="th__title">{c.title}</span>
                    {c.unit !== '—' ? <span className="th__unit">{c.unit}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {refresh.status === 'loading' && !isManual ? (
                Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                  <tr className="table__row table__row--skeleton" key={`sk-${i}`}>
                    {MODEL_COLUMNS.map((c) => (
                      <td key={c.key}>
                        <span className="skeleton" aria-hidden="true" />
                        <span className="sr-only">加载中</span>
                      </td>
                    ))}
                  </tr>
                ))
              ) : visible.length > 0 ? (
                visible.map((e) => {
                  const gate = sendEligibilityFor(e);
                  return (
                    <tr className="table__row" key={e.key}>
                      <td>
                        <span className="ph-name">
                          <span className="ph-name__text">{e.displayName}</span>
                          <Chip tone={e.origin === 'manual' ? 'warn' : 'unknown'}>
                            {e.origin === 'manual' ? '手工录入' : '来源读回'}
                          </Chip>
                        </span>
                        <span className="row-note">{e.note}</span>
                      </td>
                      <td>
                        <Chip tone={e.provider === 'unknown' ? 'unknown' : 'neutral'}>{e.provider}</Chip>
                      </td>
                      <td className="mono">{e.modelId}</td>
                      <td>
                        <Chip tone={channelAccepted(e.billingClass) ? 'neutral' : 'danger'}>
                          {BILLING_CLASS_LABEL[e.billingClass]}
                        </Chip>
                      </td>
                      <td>{e.contextLength ?? '未接入'}</td>
                      <td>{e.reasoning.length > 0 ? e.reasoning.join('、') : '未接入'}</td>
                      <td>{e.capabilities.length > 0 ? e.capabilities.join('、') : '未接入'}</td>
                      <td>
                        <Chip tone="pending">{UNVERIFIED_LABEL}</Chip>
                        <span className="row-note">{NO_CREDIT_LABEL}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--tiny"
                          disabled
                          title={gate.reason}
                          aria-label={gate.label}
                        >
                          {gate.label}
                        </button>
                        {isManual ? (
                          <button
                            type="button"
                            className="btn btn--tiny"
                            onClick={() => handleRemove(e.key)}
                            title="删除这条手工录入条目（只影响本机内存）"
                          >
                            删除
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              ) : (
                Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                  <tr className="table__row table__row--placeholder" key={`ph-${i}`}>
                    {MODEL_COLUMNS.map((c, idx) => (
                      <td key={c.key}>
                        {idx === 0 ? (
                          <span className="ph-name">
                            <Chip tone="pending">占位行</Chip>
                            <span className="ph-name__text">未接入（无真实条目）</span>
                          </span>
                        ) : c.key === 'action' ? (
                          <button type="button" className="btn btn--tiny" disabled>
                            {SEND_DISABLED_LABEL}
                          </button>
                        ) : (
                          <Chip tone={c.emptyCell === 'unknown' ? 'unknown' : 'pending'}>{c.emptyCell}</Chip>
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {isManual ? (
          <StatePanel
            tone={manualEntries.length === 0 ? 'empty' : 'info'}
            title={
              manualEntries.length === 0
                ? '写死列表为空：0 条手工录入条目'
                : `已录入 ${manualEntries.length} 条，全部为${MANUAL_ENTRY_BADGE}`
            }
          >
            <p className="panel-p">
              手工录入的条目只存在本机内存中，刷新页面即消失。本产品不校验、不背书写死条目的真实性：显示名、provider、
              modelId、计费类别、上下文长度、推理档位与能力标签都由您填，界面一律把可用性标为「{UNVERIFIED_LABEL}」，
              并且永远不会因此出现可点击的发送控件。
            </p>
            <p className="panel-p">
              当前额度：{NO_CREDIT_LABEL}。计费类别为 subscription / promotion 的写死条目只是通道级合法，
              仍需 E1 及以上资格证据才可能发送；metered_api 与 unknown 永不准入。
            </p>
          </StatePanel>
        ) : refresh.status === 'loading' ? (
          <StatePanel tone="loading" title="正在读取来源">
            刷新只读取来源目录，不发起任何模型请求，也不发送任何内容。稍后自动显示结果。
          </StatePanel>
        ) : refresh.status === 'failed' && refresh.failure ? (
          <StatePanel
            tone="error"
            title={`刷新失败：${describeRefreshFailure(refresh.failure.reason).info.title}`}
          >
            <RefreshFailureDetails state={refresh} />
          </StatePanel>
        ) : refresh.status === 'ok' && refresh.entries.length > 0 ? (
          <StatePanel tone="info" title="来源读取成功">
            已读取 {refresh.entries.length} 个条目。{deltaText}
          </StatePanel>
        ) : (
          <StatePanel
            tone="empty"
            title={refresh.status === 'ok' ? '来源当前返回 0 个条目' : '尚未刷新来源'}
            actions={
              <button type="button" className="btn" onClick={() => void handleRefresh()}>
                刷新来源（只读取，不发送）
              </button>
            }
          >
            动态模式下这一页展示的是来源读到的条目，不是本产品内置的数据。空列表不是故障：
            读不到就显示读不到，不会回退到任何看起来像真实套餐的样例数据。
          </StatePanel>
        )}
      </Section>

      <Section
        title="列结构与未接入时的显示"
        description="这张表定义列的语义、类型、单位与取值域，是接通目录后可直接复用的字段契约。"
      >
        <div className="table-wrap" role="region" aria-label="列结构说明" tabIndex={0}>
          <table className="table table--spec">
            <thead>
              <tr>
                <th scope="col">列</th>
                <th scope="col">类型 / 单位</th>
                <th scope="col">取值域</th>
                <th scope="col">未接入时显示</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_COLUMNS.map((c) => (
                <tr className="table__row" key={c.key}>
                  <th scope="row" className="table__rowhead">
                    {c.title}
                  </th>
                  <td>{c.key}</td>
                  <td className="table__domain">{c.domain}</td>
                  <td>
                    <Chip tone={c.emptyCell === 'unknown' ? 'unknown' : 'pending'}>{c.emptyCell}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="发送准入"
        description="同一份政策同时约束界面、API 与原生适配器；界面只显示结论，不独立决定。"
      >
        <ul className="rule-list">
          {BILLING_CLASSES.map((b) => (
            <li className="rule" key={b}>
              <span className="rule__class">{b}</span>
              <span className="rule__label">{BILLING_CLASS_LABEL[b]}</span>
              <span className="rule__text">{BILLING_CLASS_RULE[b]}</span>
              <Chip tone={BILLING_CLASS_SENDABLE[b] ? 'neutral' : 'danger'}>
                {BILLING_CLASS_SENDABLE[b] ? '可发送（仍需 E1+ 资格）' : '不渲染为可发送'}
              </Chip>
            </li>
          ))}
        </ul>
        <div className="notice notice--info">
          <span className="notice__tag">UI 约束</span>
          <span className="notice__text">
            通道级准入口径（929 §2）：subscription 与 promotion 是合法订阅通道（promotion 为官方活动优惠，非按量计费），
            metered_api 与 unknown 永不准入，任何状态下都不会出现可点击的发送控件。通道合法不等于当前可发送：当前额度
            {NO_CREDIT_LABEL}，证据等级 {CURRENT_EVIDENCE}，发送门关闭——无论您选择动态刷新还是写死固定模式。
          </span>
        </div>
      </Section>
    </div>
  );
}
