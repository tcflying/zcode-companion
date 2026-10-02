import { redact } from './redact';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  source: string;
  message: string;
}

export const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

export const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
};

let seq = 0;

/**
 * 唯一日志写入口。message 在进入调用方状态之前先经过 redact()，
 * 保证界面上不可能出现未脱敏的 apiKey/token/credential 样式字符串。
 */
export function makeLogEntry(level: LogLevel, source: string, message: string, at: number): LogEntry {
  seq += 1;
  return { id: seq, at, level, source: redact(source), message: redact(message) };
}
