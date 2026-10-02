import { useMemo, useState } from 'react';
import { Chip, PageHeader, Section } from '../components/Chips';
import { StatePanel } from '../components/StatePanel';
import { LOG_LEVELS, LOG_LEVEL_LABEL, type LogLevel } from '../lib/logger';
import { formatStamp } from '../lib/format';
import type { AppState } from '../app/useAppState';

const REDACTION_SAMPLE =
  '脱敏自检：写入前替换 apiKey=sk-selfcheck-0000abcd 与 Authorization: Bearer eyJhbGciOi.selfcheck.token 样式串';

/** 该字符串只是脱敏规则自检用的构造样本，不对应任何真实凭据，也不来自任何环境变量或文件。 */
const SELF_CHECK_RAW =
  '脱敏自检样本（构造串，非真实凭据）：apiKey=sk-selfcheck-0000abcd, Authorization: Bearer eyJhbGciOi.selfcheck.token, credential: "plain-secret-value"';

export function LogsPage({ state }: { state: AppState }) {
  const [level, setLevel] = useState<'all' | LogLevel>('all');
  const [source, setSource] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'info' | 'problem'>('all');

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
            <Chip tone="pending">持久化 未接入</Chip>
            <Chip tone="ok">脱敏 写前强制</Chip>
            <Chip tone="neutral">缓冲 {state.logs.length} / 200</Chip>
          </>
        }
      />

      <Section
        title="本地日志"
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
    </div>
  );
}
