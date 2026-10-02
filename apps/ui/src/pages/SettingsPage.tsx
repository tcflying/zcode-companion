import { useState } from 'react';
import { Chip, PageHeader, Section, Toggle } from '../components/Chips';
import { StatePanel } from '../components/StatePanel';
import { SETTINGS_SPEC, WINDOW_MODES, WINDOW_MODE_LABEL, WINDOW_RULE, type WindowMode } from '../data/snapshot';
import { THEME_LABEL, THEME_PREFS, type ThemePref } from '../app/theme';
import {
  CSP_CONNECT_SRC,
  LOOPBACK_API_BASE_URL,
  LOOPBACK_HOSTNAMES,
  LOCAL_API_NOTICE,
  resolveCatalogUrl
} from '../data/localApiSource';
import { evaluateWindow } from '../lib/format';
import type { AppState } from '../app/useAppState';
import type { useTheme } from '../app/theme';

export function SettingsPage({
  state,
  theme
}: {
  state: AppState;
  theme: ReturnType<typeof useTheme>;
}) {
  const [windowMode, setWindowMode] = useState<WindowMode>('advisory');
  const [redactDiagnostics, setRedactDiagnostics] = useState(false);
  const [saved, setSaved] = useState(false);

  const verdict = evaluateWindow(state.now);
  const baseUrlVerdict = resolveCatalogUrl(state.localApiBaseUrl);

  const onSave = () => {
    setSaved(true);
    state.log(
      'INFO',
      'ui.settings',
      `设置已保存到本地界面状态：windowMode=${windowMode}，脱敏诊断=${redactDiagnostics ? 'on' : 'off'}。未写入任何系统级配置。`
    );
    window.setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="page">
      <PageHeader
        title="设置"
        subtitle="本机 API、窗口模式、单实例锁、脱敏诊断与数据目录。未实现项一律显式禁用并标注原因。"
        badges={
          <>
            <Chip tone="pending">未写入系统配置</Chip>
            <Chip tone="neutral">窗口模式 {windowMode}</Chip>
          </>
        }
      />

      <div className="grid grid--two">
        <Section
          title="本机 API"
          description="UI04 起可在设置页显式开启「连接本机 API」：动态刷新只读 companion 自己的回环目录端点。默认关闭 = 完全零网络。"
        >
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__label">连接本机 API（UI04）</div>
              <div className="setting-row__desc">
                关闭（默认）时「模型与套餐」的动态刷新按 <span className="mono">transport_not_wired</span>{' '}
                失败，完全零网络。打开后只向本机回环发起 <span className="mono">GET /v1/zcc/catalog</span>：
                只读取目录，不发送任何模型请求，条目仍恒为「未验证」且不可发送。
              </div>
            </div>
            <Toggle
              checked={state.localApiEnabled}
              label="连接本机 API（只读目录，不发模型请求）"
              onChange={state.setLocalApiEnabled}
            />
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__label">本机 API base URL</div>
              <div className="setting-row__desc">
                留空 = 同源（由 UI 自己的 dev/preview 服务器反代到回环端口，浏览器只发同源请求）。
                也可直接填回环 origin。回环守卫只放行 {LOOPBACK_HOSTNAMES.join(' / ')}，
                其他来源在发起请求前就被拒。
              </div>
            </div>
          </div>
          <div className="toolbar">
            <label className="toolbar__field">
              <span className="toolbar__label">base URL</span>
              <input
                className="input"
                data-field="local-api-base-url"
                value={state.localApiBaseUrl}
                placeholder="留空 = 同源"
                onChange={(e) => state.setLocalApiBaseUrl(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => state.setLocalApiBaseUrl(LOOPBACK_API_BASE_URL)}
            >
              填入 {LOOPBACK_API_BASE_URL}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => state.setLocalApiBaseUrl('')}
            >
              填入 同源（空）
            </button>
          </div>

          <div className="setting-facts setting-facts--stack">
            <div>
              <span>回环守卫判定</span>
              {baseUrlVerdict.ok ? (
                <Chip tone="ok">允许 → {baseUrlVerdict.url}</Chip>
              ) : (
                <Chip tone="danger">拒绝（不会发起任何请求）</Chip>
              )}
            </div>
            {!baseUrlVerdict.ok ? <p className="hint">{baseUrlVerdict.reason}</p> : null}
            <div>
              <span>API 监听地址</span>
              <span className="mono">{LOOPBACK_API_BASE_URL}（API01 裁定端口 8790）</span>
            </div>
            <div>
              <span>本机 token</span>
              <Chip tone="pending">不显示、不由界面持有</Chip>
            </div>
            <div>
              <span>浏览器 CSP connect-src</span>
              <span className="mono">{CSP_CONNECT_SRC}</span>
            </div>
            <div>
              <span>Host / Origin 门</span>
              <Chip tone="ok">同源反代去 Origin；回环直连需 API 侧裁定</Chip>
            </div>
          </div>
          <StatePanel tone="info" title="UI04 网络边界">
            {LOCAL_API_NOTICE}
          </StatePanel>
        </Section>

        <Section title="单实例锁" description="锁域为本应用私有 data 目录的 canonical 身份。">
          <div className="setting-facts setting-facts--stack">
            <div>
              <span>锁状态</span>
              <Chip tone="pending">{SETTINGS_SPEC.singleInstance.status}</Chip>
            </div>
            <div>
              <span>锁文件</span>
              <Chip tone="pending">{SETTINGS_SPEC.singleInstance.lockFile}</Chip>
            </div>
            <div>
              <span>私有 IPC 域</span>
              <Chip tone="pending">{SETTINGS_SPEC.singleInstance.ipcDomain}</Chip>
            </div>
          </div>
          <p className="hint">{SETTINGS_SPEC.singleInstance.reason}。</p>
        </Section>
      </div>

      <Section title="窗口模式" description={WINDOW_RULE}>
        <div className="radio-group" role="radiogroup" aria-label="窗口模式">
          {WINDOW_MODES.map((m) => (
            <label key={m} className={`radio${windowMode === m ? ' radio--on' : ''}`}>
              <input
                type="radio"
                name="window-mode"
                value={m}
                checked={windowMode === m}
                onChange={() => setWindowMode(m)}
              />
              <span className="radio__text">
                <span className="radio__title">{WINDOW_MODE_LABEL[m]}</span>
                <span className="radio__desc">
                  {m === 'enforce'
                    ? '正常窗口外直接拒发，dispatch = 0。'
                    : m === 'advisory'
                      ? '正常窗口外提示可能扣套餐；这是默认模式，也是已有的用户授权。'
                      : '不展示窗口优化提示，但安全校验不关闭。'}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="setting-facts setting-facts--stack">
          <div>
            <span>当前窗口判定</span>
            {verdict.kind === 'invalid' ? (
              <Chip tone="danger">时钟无效 · fail-closed</Chip>
            ) : verdict.kind === 'in-window' ? (
              <Chip tone="ok">窗口内</Chip>
            ) : (
              <Chip tone="warn">窗口外</Chip>
            )}
          </div>
          <div>
            <span>判定依据</span>
            <span className="mono">{verdict.text}</span>
          </div>
        </div>

        <StatePanel tone={verdict.kind === 'invalid' ? 'error' : 'info'} title={verdict.kind === 'invalid' ? '错误状态：时钟无效' : '窗口判定为纯展示'}>
          {verdict.kind === 'invalid'
            ? '本地时钟返回 Invalid Date。enforce / advisory / off 三态都检查合法时钟，非法时钟一律 fail-closed，不放行也不猜测。'
            : '窗口提示只影响提示文案与 enforce 下的拒发，不影响费用资格校验；资格校验始终独立且优先。'}
        </StatePanel>
      </Section>

      <div className="grid grid--two">
        <Section title="外观" description="light / dark / system 三态；system 跟随操作系统并在系统切换时即时响应。">
          <div className="radio-group" role="radiogroup" aria-label="主题">
            {THEME_PREFS.map((p: ThemePref) => (
              <label key={p} className={`radio radio--compact${theme.pref === p ? ' radio--on' : ''}`}>
                <input
                  type="radio"
                  name="theme"
                  value={p}
                  checked={theme.pref === p}
                  onChange={() => theme.setPref(p)}
                />
                <span className="radio__text">
                  <span className="radio__title">{THEME_LABEL[p]}</span>
                  {p === 'system' ? (
                    <span className="radio__desc">当前系统偏好：{theme.systemDark ? 'dark' : 'light'}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <div className="setting-facts">
            <div>
              <span>生效主题</span>
              <Chip tone="accent">{theme.resolved}</Chip>
            </div>
            <div>
              <span>来源</span>
              <Chip tone="neutral">
                {theme.source === 'url' ? 'URL 覆盖（?theme=）' : theme.source === 'storage' ? '本地偏好' : '默认值'}
              </Chip>
            </div>
          </div>
        </Section>

        <Section title="隐私与脱敏" description="写入前脱敏始终开启，不可关闭。">
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__label">脱敏诊断</div>
              <div className="setting-row__desc">
                打开后日志附加工具侧脱敏诊断字段。凭据值在任何情况下都不会写入日志。
              </div>
            </div>
            <Toggle
              checked={redactDiagnostics}
              label="脱敏诊断"
              onChange={(next) => {
                setRedactDiagnostics(next);
                state.log('INFO', 'ui.settings', `脱敏诊断开关：${next ? '开' : '关'}（凭据值仍不会写入日志）。`);
              }}
            />
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__label">崩溃与使用上报</div>
              <div className="setting-row__desc">本产品不上报任何数据；开关永久禁用。</div>
            </div>
            <Toggle checked={false} disabled label="崩溃与使用上报（不支持）" />
          </div>
          <p className="hint">
            脱敏规则在日志写入口生效：apiKey / token / credential / password / Authorization: Bearer / JWT / sk- 前缀样式字符串
            一律替换为 [REDACTED]，SHA-256 指纹等证据值保留。
          </p>
        </Section>
      </div>

      <Section title="数据目录" description="只显示路径，不读取目录内容，不显示任何凭据。">
        <div className="setting-facts setting-facts--stack">
          <div>
            <span>应用数据目录</span>
            <span className="mono">{SETTINGS_SPEC.dataDir.path}</span>
          </div>
          <div>
            <span>journal 目录</span>
            <Chip tone="pending">{SETTINGS_SPEC.dataDir.journal}</Chip>
          </div>
          <div>
            <span>凭据</span>
            <Chip tone="ok">{SETTINGS_SPEC.dataDir.secrets}</Chip>
          </div>
        </div>
        <p className="hint">{SETTINGS_SPEC.dataDir.reason}；该路径是设计位，本轮未创建、未验证。</p>
      </Section>

      <Section
        title="界面自检"
        description="以下开关只改变本地界面状态，用于确认空 / 加载 / 错误三态与 fail-closed 分支可见；不接入任何服务。"
        actions={
          <button type="button" className="btn btn--primary" onClick={onSave}>
            保存界面设置
          </button>
        }
      >
        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__label">时钟异常自检</div>
            <div className="setting-row__desc">
              打开后本地时钟返回 Invalid Date，用于演示窗口判定的 fail-closed 错误态。不影响任何真实服务。
            </div>
          </div>
          <Toggle
            checked={state.clockBroken}
            label="时钟异常自检"
            onChange={(next) => {
              state.setClockBroken(next);
              state.log(
                next ? 'WARN' : 'INFO',
                'ui.selfcheck',
                next ? '时钟异常自检：已启用（仅本地界面状态）。' : '时钟异常自检：已关闭，本机时钟恢复。'
              );
            }}
          />
        </div>
        {saved ? (
          <div className="notice notice--ok" role="status">
            <span className="notice__tag">已保存</span>
            <span className="notice__text">已写入本地界面状态（内存），未改动系统配置与官方配置。</span>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
