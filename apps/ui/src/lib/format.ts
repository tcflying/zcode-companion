export function formatClock(ms: number): { text: string; invalid: boolean } {
  if (!Number.isFinite(ms)) return { text: 'Invalid Date', invalid: true };
  const d = new Date(ms);
  const shanghai = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(d);
  return { text: `${shanghai.replace(/\//g, '-')}（Asia/Shanghai）`, invalid: false };
}

export function formatStamp(ms: number): string {
  if (!Number.isFinite(ms)) return 'Invalid Date';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未接入';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export type WindowVerdict =
  | { kind: 'in-window'; text: string }
  | { kind: 'out-window'; text: string }
  | { kind: 'invalid'; text: string };

/** 23:00 含、09:00 不含，时区固定 Asia/Shanghai。时钟无效 → fail-closed。 */
export function evaluateWindow(ms: number): WindowVerdict {
  if (!Number.isFinite(ms)) {
    return { kind: 'invalid', text: '本地时钟无效（Invalid Date）→ 按 fail-closed 处理：窗口判定不可用' };
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(ms));
  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minuteRaw = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const hour = Number(hourRaw === '24' ? '0' : hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { kind: 'invalid', text: '本地时钟解析失败 → 按 fail-closed 处理' };
  }
  const inWindow = hour >= 23 || hour < 9;
  const hm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return inWindow
    ? { kind: 'in-window', text: `${hm} 位于正常窗口内（23:00 含 / 09:00 不含）` }
    : { kind: 'out-window', text: `${hm} 位于正常窗口外` };
}
