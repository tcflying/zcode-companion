import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactValue } from './redact';

describe('redact', () => {
  it('拦截 apiKey= 键值样式', () => {
    expect(redact('apiKey=sk-live-abcdef0123456789')).toBe(`apiKey=${REDACTED}`);
  });

  it('拦截带引号的键值样式并保留引号结构', () => {
    expect(redact('"access_token": "abc123XYZ_token"')).toBe(`"access_token": "${REDACTED}"`);
  });

  it('拦截 Authorization: Bearer 样式', () => {
    expect(redact('Authorization: Bearer eyJhbGciOi.demo-token-value')).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
  });

  it('拦截 JWT 三段式', () => {
    expect(redact('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEyMw.dBjftJeZ4CVPmB92K27uhbUJU1p1r')).toBe(
      `token=${REDACTED}`
    );
  });

  it('拦截 credential / password / secret 键名', () => {
    expect(redact('credential: hunter2secret')).toBe(`credential: ${REDACTED}`);
    expect(redact('password = "p@ssw0rd!"')).toBe(`password = "${REDACTED}"`);
    expect(redact('client_secret=abc')).toBe(`client_secret=${REDACTED}`);
  });

  it('拦截无键名上下文的独立长串', () => {
    expect(redact('裸串 A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6 只出现一次')).toBe(
      `裸串 ${REDACTED} 只出现一次`
    );
  });

  it('保留 64 位十六进制 SHA-256 指纹（属证据，不属凭据）', () => {
    const sha = '172d6f333e61642ce3882250949fafe8180f75b5b8e5552244ca2c59ca05d14e';
    expect(redact(`sha256=${sha}`)).toBe(`sha256=${sha}`);
    expect(redact(`SHA-256 指纹 ${sha} 已记录`)).toBe(`SHA-256 指纹 ${sha} 已记录`);
  });

  it('不把"未接入"等界面占位文案误脱敏', () => {
    expect(redact('apiKey: 未接入')).toBe('apiKey: 未接入');
    expect(redact('token=unknown')).toBe('token=unknown');
  });

  it('保留非凭据中文正文', () => {
    const line = '运行时尚未接入，未发送任何请求（dispatch = 0）';
    expect(redact(line)).toBe(line);
  });

  it('幂等：二次脱敏结果不变', () => {
    const once = redact('apiKey=sk-live-abcdef0123456789');
    expect(redact(once)).toBe(once);
  });

  it('不修改入参', () => {
    const input = 'apiKey=sk-live-abcdef0123456789';
    redact(input);
    expect(input).toBe('apiKey=sk-live-abcdef0123456789');
  });

  it('一次调用内同时命中多种样式', () => {
    const out = redact(
      '连接 app-server 失败：Authorization: Bearer eyJhbGciOi.demo-token-value, apiKey=sk-live-abcdef0123456789'
    );
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).not.toContain('sk-live');
    expect(out).toContain(REDACTED);
  });
});

describe('redactValue', () => {
  it('对对象做 JSON 序列化后脱敏', () => {
    const out = redactValue({ apiKey: 'sk-live-abcdef0123456789', note: '未接入' });
    expect(out).not.toContain('sk-live');
    expect(out).toContain('未接入');
  });

  it('null / undefined 归一为"未接入"', () => {
    expect(redactValue(null)).toBe('未接入');
    expect(redactValue(undefined)).toBe('未接入');
  });
});
