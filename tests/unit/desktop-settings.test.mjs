/**
 * I10 设置与首启引导契约（`apps/desktop/lib/settings.cjs`）。
 *
 * provider-free：`HOME` 被显式指向一个临时目录，里面放的是**合成**的 minimax 配置，
 * 不读用户真实凭据、不写真实 settings.json。
 *
 * 本文件钉住的是：
 *  1. **首启引导只认那一个路径。** 同一份配置里有七八家 provider 各自的 `apiKey:`，
 *     拿错一把的后果是「界面显示 A、实际发的是 B 的 key」。
 *  2. **闭集 fail-closed。** 越界的 driver / reasoning / 端口在**保存时**被拒，而不是
 *     悄悄回落到默认值。
 *  3. **坏文件不许被静默覆盖。** 读坏了要退回缺省**并如实报告**，且不覆盖原文件。
 *  4. **明文 key 不出主进程。** `publicSettings()` 的返回里没有任何 key 片段。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mustValue } from '../helpers/desktop-harness.mjs';

const require = createRequire(import.meta.url);
const {
  defaultSettings,
  normalizeSettings,
  readYamlScalarAtPath,
  readMinimaxApiKey,
  seedApiKeyFromMinimax,
  loadSettings,
  saveSettings,
  settingsFilePath,
  publicSettings,
  fingerprintApiKey,
  DRIVER_CLOSED_SET,
  REASONING_CLOSED_SET,
  MINIMAX_KEY_PATH
} = require('../../apps/desktop/lib/settings.cjs');

/** 合成 key：不对应任何真实凭据，也不来自任何环境变量或文件。 */
const SYNTHETIC_KEY = 'zcc_settings_test_synthetic_key_0003';
const OTHER_KEY = 'zcc_other_provider_synthetic_key_99';

let home = '';
let userData = '';

/** 一份**合成**的 minimax 配置，形状照抄真实文件的缩进层级，但值全是构造串。 */
const SYNTHETIC_MINIMAX_YAML = [
  'logLevel: info',
  'provider:',
  '  minimax:',
  '    name: MiniMax',
  '    options:',
  '      apiKey: minimax-should-never-be-picked-up-0001',
  '      baseURL: https://example.invalid/minimax',
  'custom_provider:',
  '  lingma:',
  '    options:',
  `      apiKey: ${OTHER_KEY}`,
  '  ollama-cloud:',
  '    options:',
  `      apiKey: ollama-synthetic-${'x'.repeat(40)}`,
  '  zcc-companion:',
  '    name: ZCode Companion',
  '    kind: openai',
  '    enabled: "true"',
  '    options:',
  `      apiKey: ${SYNTHETIC_KEY}`,
  '      baseURL: http://127.0.0.1:8790/v1',
  '      authMode: bearer',
  'defaultModel: x',
  ''
].join('\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zcc-settings-home-'));
  userData = mkdtempSync(join(tmpdir(), 'zcc-settings-data-'));
  mkdirSync(join(home, '.minimax'), { recursive: true });
  writeFileSync(join(home, '.minimax', 'config.yaml'), SYNTHETIC_MINIMAX_YAML, 'utf8');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

describe('YAML 子集读取：按完整路径取值', () => {
  it('引导路径就是 custom_provider → zcc-companion → options → apiKey', () => {
    expect([...MINIMAX_KEY_PATH]).toEqual(['custom_provider', 'zcc-companion', 'options', 'apiKey']);
  });

  it('缩进感知的路径匹配：同名的别的 provider 一把都不许命中', () => {
    const got = readYamlScalarAtPath(SYNTHETIC_MINIMAX_YAML, MINIMAX_KEY_PATH);
    expect(got).toBe(SYNTHETIC_KEY);
    expect(got).not.toContain('minimax-should-never-be-picked-up');
    expect(got).not.toBe(OTHER_KEY);
  });

  it('只匹配完整路径：少一级、多一级都读不到', () => {
    expect(readYamlScalarAtPath(SYNTHETIC_MINIMAX_YAML, ['custom_provider', 'zcc-companion', 'apiKey'])).toBeNull();
    expect(readYamlScalarAtPath(SYNTHETIC_MINIMAX_YAML, ['custom_provider', 'zcc-companion', 'options'])).toBeNull();
    expect(readYamlScalarAtPath(SYNTHETIC_MINIMAX_YAML, ['custom_provider', 'options', 'apiKey'])).toBeNull();
  });

  it('引号与行尾注释被正确剥掉', () => {
    const yaml = ['custom_provider:', '  zcc-companion:', '    options:', '      apiKey: "zcc_quoted_0004"  # 注释', ''].join('\n');
    expect(readYamlScalarAtPath(yaml, MINIMAX_KEY_PATH)).toBe('zcc_quoted_0004');
  });

  it('块标量 / 锚点 / 别名不算标量：宁可读不到，也不读半截', () => {
    const yaml = ['custom_provider:', '  zcc-companion:', '    options:', '      apiKey: |', '        zcc_block', ''].join('\n');
    expect(readYamlScalarAtPath(yaml, MINIMAX_KEY_PATH)).toBeNull();
  });

  it('列表项不参与路径匹配', () => {
    const yaml = ['custom_provider:', '  - zcc-companion:', '  options:', '      apiKey: nope', ''].join('\n');
    expect(readYamlScalarAtPath(yaml, MINIMAX_KEY_PATH)).toBeNull();
  });
});

describe('首启引导：读 ~/.minimax/config.yaml', () => {
  it('读得到就带回那一把 key，并如实报出来源', () => {
    const result = readMinimaxApiKey(home);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBe(SYNTHETIC_KEY);
      expect(result.source).toContain('.minimax');
    }
  });

  it('文件不存在：如实说读不到，不猜也不生成弱 key', () => {
    const empty = mkdtempSync(join(tmpdir(), 'zcc-settings-empty-'));
    try {
      const result = readMinimaxApiKey(empty);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('失败');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('文件在但没有那个键：理由指名路径，不是一句「读不到」', () => {
    writeFileSync(join(home, '.minimax', 'config.yaml'), 'logLevel: info\n', 'utf8');
    const result = readMinimaxApiKey(home);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('custom_provider.zcc-companion.options.apiKey');
  });

  it('空串 / 全空白 key 一律拒绝带回', () => {
    const yaml = ['custom_provider:', '  zcc-companion:', '    options:', '      apiKey: ""', ''].join('\n');
    writeFileSync(join(home, '.minimax', 'config.yaml'), yaml, 'utf8');
    expect(readMinimaxApiKey(home).ok).toBe(false);
  });

  it('已有 key 时不触发引导（用户自己的设置优先于外部文件）', () => {
    const current = { ...defaultSettings(), apiKey: OTHER_KEY };
    const result = seedApiKeyFromMinimax(current, home);
    expect(result.seeded).toBe(false);
    expect(result.settings.apiKey).toBe(OTHER_KEY);
  });

  it('空 key 时触发引导，并把来源如实带出来', () => {
    const result = seedApiKeyFromMinimax(defaultSettings(), home);
    expect(result.seeded).toBe(true);
    expect(result.settings.apiKey).toBe(SYNTHETIC_KEY);
    expect(result.source).toContain('.minimax');
    expect(result.reason).toBeNull();
  });
});

describe('设置校验：闭集 fail-closed', () => {
  const current = { ...defaultSettings(), apiKey: SYNTHETIC_KEY };

  it('缺省值就是文档里那四个', () => {
    expect(defaultSettings()).toEqual({ apiKey: '', apiPort: 8790, driver: 'official-host', reasoning: 'low' });
  });

  it('合法输入原样通过', () => {
    const result = mustValue(normalizeSettings({ apiPort: 8791, driver: 'none', reasoning: 'high' }, current.apiKey));
    expect(result.value).toEqual({ apiKey: SYNTHETIC_KEY, apiPort: 8791, driver: 'none', reasoning: 'high' });
  });

  it('apiKey 留空 = 保持原值（界面回提交的是掩码，不是明文）', () => {
    for (const emptyish of [{}, { apiKey: '' }, { apiKey: '   ' }, { apiKey: undefined }]) {
      const result = mustValue(normalizeSettings(emptyish, current.apiKey));
      expect(result.value.apiKey).toBe(SYNTHETIC_KEY);
    }
  });

  it('提交一个全新的非空串才真的换 key', () => {
    const result = mustValue(normalizeSettings({ apiKey: 'zcc_a_brand_new_key_0005' }, current.apiKey));
    expect(result.value.apiKey).toBe('zcc_a_brand_new_key_0005');
  });

  it('没有既有 key 又提交空 → 拒：本产品不生成默认弱 key', () => {
    const result = normalizeSettings({ apiPort: 8790, driver: 'none', reasoning: 'low' }, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('不生成默认弱 key');
  });

  it('driver 越界 → 拒并列出闭集', () => {
    const result = normalizeSettings({ driver: 'fixture' }, current.apiKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('driver');
      expect(result.reason).toContain(DRIVER_CLOSED_SET.join(' | '));
    }
    // `fixture` 永远不会出现在闭集里：它是假模型产出，配置无法启用。
    expect(DRIVER_CLOSED_SET).not.toContain('fixture');
  });

  it('reasoning 越界 → 拒并列出闭集', () => {
    const result = normalizeSettings({ reasoning: 'medium' }, current.apiKey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(REASONING_CLOSED_SET.join(' | '));
  });

  it('端口越界 / 非整数 / 非数字 → 拒', () => {
    for (const port of [0, -1, 65536, 1.5, '8790', null, NaN]) {
      const result = normalizeSettings({ apiPort: port }, current.apiKey);
      expect(result.ok, `端口 ${String(port)} 应当被拒`).toBe(false);
      if (!result.ok) expect(result.reason).toContain('apiPort');
    }
  });

  it('key 里带换行 → 拒写入', () => {
    const result = normalizeSettings({ apiKey: 'zcc_a\nzcc_b' }, current.apiKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('换行 key 应当被拒');
    expect(result.reason).toContain('换行');
  });
});

describe('设置持久化', () => {
  it('写在 userData/settings.json；字段就是那四个', () => {
    const file = settingsFilePath(userData);
    expect(file.endsWith('settings.json')).toBe(true);
    saveSettings(file, { apiKey: SYNTHETIC_KEY, apiPort: 8791, driver: 'none', reasoning: 'low' });
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(parsed).sort()).toEqual(['apiKey', 'apiPort', 'driver', 'reasoning']);
    expect(parsed.apiPort).toBe(8791);
    // 不留半份 JSON：临时文件已被改名消费。
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('读回等价', () => {
    const file = settingsFilePath(userData);
    const written = { apiKey: SYNTHETIC_KEY, apiPort: 8792, driver: 'local-official', reasoning: 'max' };
    saveSettings(file, written);
    const { settings, problems } = loadSettings(file);
    expect(problems).toEqual([]);
    expect(settings).toEqual(written);
  });

  it('文件不存在 = 正常首启：退回缺省且没有任何 problem', () => {
    const { settings, problems } = loadSettings(join(userData, 'nope.json'));
    expect(problems).toEqual([]);
    expect(settings).toEqual(defaultSettings());
  });

  it('文件损坏：退回缺省、如实报告，并且不覆盖原文件', () => {
    const file = join(userData, 'settings.json');
    writeFileSync(file, '{ not json', 'utf8');
    const { settings, problems } = loadSettings(file);
    expect(settings).toEqual(defaultSettings());
    expect(problems.join(' ')).toContain('SETTINGS_FILE_UNREADABLE');
    // 关键：坏文件必须原样留着，让人能手工修，而不是被一次「读」悄悄抹掉。
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('坏字段逐个丢弃并逐条报告，好字段照常生效', () => {
    const file = join(userData, 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({ apiKey: SYNTHETIC_KEY, apiPort: 0, driver: 'evil', reasoning: 'medium' }),
      'utf8'
    );
    const { settings, problems } = loadSettings(file);
    expect(settings).toEqual({ apiKey: SYNTHETIC_KEY, apiPort: 8790, driver: 'official-host', reasoning: 'low' });
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('apiPort');
    expect(problems.join(' ')).toContain('driver');
    expect(problems.join(' ')).toContain('reasoning');
  });

  it('顶层不是对象 → 退回缺省并报告', () => {
    const file = join(userData, 'settings.json');
    writeFileSync(file, '[1,2,3]', 'utf8');
    expect(loadSettings(file).problems.join(' ')).toContain('SETTINGS_FILE_SHAPE');
  });
});

describe('明文 key 不出主进程', () => {
  it('publicSettings 的整个序列化结果里没有 key 的任何片段', () => {
    const settings = { ...defaultSettings(), apiKey: SYNTHETIC_KEY, apiPort: 8791 };
    const view = publicSettings(settings);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SYNTHETIC_KEY);
    expect(serialized).not.toContain(SYNTHETIC_KEY.slice(0, 12));
    expect(serialized).not.toContain(SYNTHETIC_KEY.slice(-8));
    // 掩码是常量，不含 key 任何字符。
    expect(view.apiKeyMasked).toBe('••••••••');
    expect(view.apiKeySet).toBe(true);
    expect(view.apiKeyFingerprint).toMatch(/^zcc-fp:[0-9a-f]{12}$/);
  });

  it('返回对象里根本没有 apiKey 这个字段（类型层与运行层同一条防线）', () => {
    const view = publicSettings({ ...defaultSettings(), apiKey: SYNTHETIC_KEY });
    expect(Object.keys(view)).not.toContain('apiKey');
  });

  it('指纹形状与 packages/api 的 zcc-fp:<sha256 前 12 位> 约定一致', () => {
    expect(fingerprintApiKey(SYNTHETIC_KEY)).toMatch(/^zcc-fp:[0-9a-f]{12}$/);
  });

  it('同一把 key 指纹稳定、换一把就变', () => {
    expect(fingerprintApiKey(SYNTHETIC_KEY)).toBe(fingerprintApiKey(SYNTHETIC_KEY));
    expect(fingerprintApiKey(SYNTHETIC_KEY)).not.toBe(fingerprintApiKey(OTHER_KEY));
  });

  it('没配 key 时：apiKeySet=false、掩码空串、指纹 null', () => {
    const view = publicSettings(defaultSettings());
    expect(view).toMatchObject({ apiKeySet: false, apiKeyMasked: '', apiKeyFingerprint: null });
  });
});
