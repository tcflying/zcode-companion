import { useMemo, useState } from 'react';
import { Chip, PageHeader, Section } from '../components/Chips';
import { StatePanel } from '../components/StatePanel';
import { LOG_LEVELS, LOG_LEVEL_LABEL, type LogLevel } from '../lib/logger';
import { formatStamp } from '../lib/format';
import { STREAM_LABEL } from '../data/desktopLabels';
import { exportLogs, type LogExportResult } from '../data/desktopBridge';
import type { AppState } from '../app/useAppState';
import type { DesktopState } from '../app/useDesktopState';

const REDACTION_SAMPLE =
  '脱敏自检：写入前替换 apiKey=sk-selfcheck-0000abcd 与 Authorization: Bearer eyJhbGciOi.selfcheck.token 样式串';

/** 该字符串只是脱敏规则自检用的构造样本，不对应任何真实凭据，也不来自任何环境变量或文件。 */
const SELF_CHECK_RAW =
  '脱敏自检样本（构造串，非真实凭据）：apiKey=sk-selfcheck-0000abcd, Authorization: Bearer eyJhbGciOi.selfcheck.token, credential: "plain-secret-value"';

export function LogsPage({ state, desktop }: { state: AppState; desktop: DesktopState }) {
  const [level, setLevel] = useState<'all' | LogLevel>('all');
  const [source, setSource] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'info' | 'problem'>('all');
  // 导出（RA-09）。preview 只读不落盘；save 由用户在系统对话框里选本地目标。
  // 程序**不会**自动上传任何文件，这里也不提供任何上传入口。
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<LogExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const runExport = async (mode: 'preview' | 'save') => {
    setExporting(true);
    setExportError(null);
    try {
      const result = await exportLogs({ mode });
      if (result.ok) {
        setExportResult(result);
        return;
      }
      // 取消是**正常结局**，不当作错误弹给用户；其他失败码如实显示。
      setExportResult(null);
      if (result.code === 'CANCELLED') {
        setExportError(null);
        return;
      }
      setExportError(`${result.code}：${result.reason}`);
    } finally {
      setExporting(false);
    }
  };

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const l of state.logs) set.add(l.source);
    return Array.from(set).sort();
  }, [state.logs]);

  const visible = useMemo(() => {
    return state.logs.filter((l) => {
      if (level !== 'all' && l.level !== level) return false;
      if (source && !l.source.includes(source)) return false;
      if (filterMode === 'info' && (l.level === 'WARN' || l.level === 'ERROR')) return false;
      if (filterMode === 'problem' && l.level !== 'WARN' && l.level !== 'ERROR') return false;
      return true;
    });
  }, [state.logs, level, source, filterMode]);

  const runSelfCheck = () => {
    state.log('INFO', 'ui.selfcheck.redact', REDACTION_SAMPLE);
    state.log('WARN', 'ui.selfcheck.redact', SELF_CHECK_RAW);
    state.log('ERROR', 'ui.selfcheck.error', '错误态自检：这是一条本地构造的 ERROR 条目，用于确认错误样式可区分；不对应任何真实故障。');
  };

  return (
    <div className="page">
      <PageHeader
        title="日志"
        subtitle="本地日志缓冲。消息在写入界面状态之前统一经过脱敏，界面不可能出现凭据值。"
        badges={
          <>
            <Chip tone="pending">界面缓冲 {state.logs.length} / 200</Chip>
            <Chip tone="ok">脱敏 写前强制</Chip>
            <Chip tone="neutral">子进程尾 {desktop.logs.length} 行</Chip>
          </>
        }
      />

      <Section
        title="反代子进程输出"
        description="桌面主进程把子进程的 stdout / stderr 收进环形缓冲并实时推送。写入前逐行脱敏：注册过的凭据串、Bearer 令牌、key=value 形态一律替换为 [REDACTED]。"
        actions={
          <button type="button" className="btn" onClick={desktop.refreshLogs} disabled={!desktop.available}>
            拉取最新
          </button>
        }
      >
        {!desktop.available ? (
          <StatePanel tone="info" title="桌面壳未接入">
            没有子进程可跟随。只有从桌面程序启动时，这里才会有内容。
          </StatePanel>
        ) : desktop.logs.length === 0 ? (
          <StatePanel tone="empty" title="空状态：还没有子进程输出">
            反代子进程启动后，它的每一行 stdout / stderr 都会实时出现在这里。
          </StatePanel>
        ) : (
          <div className="table-wrap" role="region" aria-label="反代子进程输出" tabIndex={0}>
            <table className="table table--logs">
              <thead>
                <tr>
                  <th scope="col" className="th--time">
                    时间
                  </th>
                  <th scope="col" className="th--level">
                    来源流
                  </th>
                  <th scope="col">输出</th>
                </tr>
              </thead>
              <tbody>
                {desktop.logs.map((line) => (
                  <tr className={`table__row table__row--${line.stream === 'stderr' ? 'warn' : 'debug'}`} key={line.seq}>
                    <td className="mono th--time">{formatStamp(line.at)}</td>
                    <td>
                      <Chip tone={line.stream === 'stderr' ? 'warn' : 'neutral'}>{STREAM_LABEL[line.stream]}</Chip>
                    </td>
                    <td className="log-msg">{line.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="界面本地日志"
        description="级别 / 时间 / 来源 / 来源说明见下表。缓冲区仅存在于内存，关闭界面即清空。"
        actions={
          <div className="toolbar">
            <label className="toolbar__field">
              <span className="toolbar__label">级别</span>
              <select
                className="input input--select"
                value={level}
                onChange={(e) => setLevel(e.target.value as 'all' | LogLevel)}
              >
                <option value="all">全部</option>
                {LOG_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {LOG_LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar__field">
              <span className="toolbar__label">来源</span>
              <input
                type="search"
                className="input"
                value={source}
                placeholder="按来源过滤"
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <div className="toolbar__seg" role="group" aria-label="快捷筛选">
              <button
                type="button"
                className={`btn btn--tiny${filterMode === 'all' ? ' btn--tiny-on' : ''}`}
                onClick={() => setFilterMode('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={`btn btn--tiny${filterMode === 'info' ? ' btn--tiny-on' : ''}`}
                onClick={() => setFilterMode('info')}
              >
                仅 INFO/DEBUG
              </button>
              <button
                type="button"
                className={`btn btn--tiny${filterMode === 'problem' ? ' btn--tiny-on' : ''}`}
                onClick={() => setFilterMode('problem')}
              >
                仅 WARN/ERROR
              </button>
            </div>
            <button type="button" className="btn" onClick={runSelfCheck}>
              注入自检条目
            </button>
            <button type="button" className="btn" onClick={state.clearLogs}>
              清空缓冲
            </button>
          </div>
        }
      >
        {visible.length === 0 ? (
          <StatePanel
            tone="empty"
            title={state.logs.length === 0 ? '空状态：缓冲中还没有日志' : '筛选结果为空'}
            actions={
              <button type="button" className="btn" onClick={runSelfCheck}>
                注入自检条目
              </button>
            }
          >
            {state.logs.length === 0
              ? '当前筛选下没有任何日志条目。'
              : `缓冲中有 ${state.logs.length} 条，但没有一条符合当前筛选条件（级别 ${level} / 来源「${source || '全部'}」/ 快捷 ${filterMode}）。`}
          </StatePanel>
        ) : (
          <div className="table-wrap" role="region" aria-label="本地日志" tabIndex={0}>
            <table className="table table--logs">
              <thead>
                <tr>
                  <th scope="col" className="th--time">
                    时间
                  </th>
                  <th scope="col" className="th--level">
                    级别
                  </th>
                  <th scope="col" className="th--source">
                    来源
                  </th>
                  <th scope="col">消息</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr className={`table__row table__row--${l.level.toLowerCase()}`} key={l.id}>
                    <td className="mono th--time">{formatStamp(l.at)}</td>
                    <td>
                      <Chip tone={l.level === 'ERROR' ? 'danger' : l.level === 'WARN' ? 'warn' : 'neutral'}>
                        {LOG_LEVEL_LABEL[l.level]}
                      </Chip>
                    </td>
                    <td className="mono th--source">{l.source}</td>
                    <td className="log-msg">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-toolbar-note">
          来源列表：{sources.length ? sources.join('、') : '（空）'} · 匹配 {visible.length} / {state.logs.length} 条
        </div>
      </Section>

      <Section title="脱敏规则" description="写入口 src/lib/logger.ts 的 makeLogEntry() 对 source 与 message 强制执行 redact()。">
        <ul className="rule-list rule-list--tight">
          <li className="rule">
            <span className="rule__class">键值</span>
            <span className="rule__text mono">apiKey / access_token / refresh_token / id_token / token / credential / password / secret / client_secret / authorization / private_key 后接 : 或 =</span>
          </li>
          <li className="rule">
            <span className="rule__class">前缀</span>
            <span className="rule__text mono">sk- / pk- / rk- / ak- 开头的密钥样式串</span>
          </li>
          <li className="rule">
            <span className="rule__class">令牌</span>
            <span className="rule__text mono">Authorization: Bearer &lt;token&gt; 与 JWT 三段式</span>
          </li>
          <li className="rule">
            <span className="rule__class">裸串</span>
            <span className="rule__text mono">无键名上下文的 32 位以上 base64/hex 串</span>
          </li>
          <li className="rule">
            <span className="rule__class">保留</span>
            <span className="rule__text">64 位十六进制 SHA-256 指纹属于证据，不按凭据处理</span>
          </li>
        </ul>
        <p className="hint">
          证明方式：apps/ui/src/lib/redact.test.ts（14 个用例，含幂等性与不修改入参），运行命令
          <span className="mono"> node node_modules/vitest/vitest.mjs run --config apps/ui/vitest.config.ts</span>。
        </p>
      </Section>

      <Section
        title="脱敏导出"
        description="把上面这份本地日志缓冲导出成一份脱敏文本。先预览再保存；保存位置由你在系统对话框里自选，本程序不会自动上传到任何地方。导出时在写入前再脱敏一次（已登记机密串 + 凭据形状），并受字节上限约束。"
        actions={
          <div className="toolbar">
            <button type="button" className="btn" onClick={() => void runExport('preview')} disabled={!desktop.available || exporting}>
              生成预览
            </button>
            <button type="button" className="btn" onClick={() => void runExport('save')} disabled={!desktop.available || exporting}>
              保存到…
            </button>
            {exporting ? <span className="toolbar__label">导出中…</span> : null}
          </div>
        }
      >
        {!desktop.available ? (
          <StatePanel tone="info" title="桌面壳未接入，当前环境不支持导出">
            导出需要桌面主进程参与（脱敏与字节上限都在主进程侧执行）。浏览器里打开时本功能显式不可用，不做任何假装成功的降级。
          </StatePanel>
        ) : (
          <>
            {exportError !== null ? (
              <StatePanel tone="error" title="导出未完成">
                {exportError}
              </StatePanel>
            ) : null}
            {exportResult !== null ? (
              <>
                <ul className="rule-list rule-list--tight">
                  <li className="rule">
                    <span className="rule__class">字节</span>
                    <span className="rule__text mono">{exportResult.bytes} B（上限 {exportResult.maxBytes} B）</span>
                  </li>
                  <li className="rule">
                    <span className="rule__class">SHA-256</span>
                    <span className="rule__text mono">{exportResult.sha256}</span>
                  </li>
                  <li className="rule">
                    <span className="rule__class">行</span>
                    <span className="rule__text mono">
                      共 {exportResult.totalLines} · 导出 {exportResult.includedLines} · 丢弃 {exportResult.droppedLines}
                      {exportResult.truncated ? '（因字节上限截断，文件内已留标记行）' : ''}
                    </span>
                  </li>
                  <li className="rule">
                    <span className="rule__class">白名单</span>
                    <span className="rule__text mono">
                      非白名单字段丢弃 {exportResult.droppedFields} · 取值不合文法丢弃 {exportResult.droppedInvalid} · 脱敏 {exportResult.redactedLines} 行
                    </span>
                  </li>
                  {exportResult.path !== undefined ? (
                    <li className="rule">
                      <span className="rule__class">已保存</span>
                      <span className="rule__text mono">{exportResult.path}</span>
                    </li>
                  ) : null}
                </ul>
                {exportResult.preview !== undefined ? (
                  <div className="table-wrap" role="region" aria-label="导出预览" tabIndex={0}>
                    <pre className="log-msg">{exportResult.preview}</pre>
                  </div>
                ) : null}
              </>
            ) : (
              <StatePanel tone="empty" title="尚未生成导出">
                点「生成预览」先看内容与统计，确认无误再「保存到…」。
              </StatePanel>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
