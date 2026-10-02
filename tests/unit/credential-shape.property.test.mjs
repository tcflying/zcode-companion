/**
 * 凭据形态判定 · **性质测试**（生成式用例，钉死 BL-3 的两个方向）。
 *
 * ## 这份文件为什么存在
 *
 * 复审量化扫描（`task-HOSTFIX-review.md` §6.2）证明上一版规则
 * `\b(?![0-9a-fA-F]{64}\b)[A-Za-z0-9_-]{32,}\b` **两个方向都错**：
 *
 *  - **漏拦**：`20.12(33) / 24.12(37) / 28.12(41) / 30.12(43) / 31.12(44) / 16.16.16(50) / 10.10.10(32)`
 *    全部 LEAK——它**逐段**判定，点两侧都不足 32 时整条规则形同虚设。
 *    端到端实测：43 字符 key 原样进 `zcc_error.message`。
 *  - **误伤**：`[A-Za-z0-9_-]{32,}` 把 **UUID** 一起吃掉（本仓 `operationId = "chatcmpl-" + randomUUID()`
 *    = 43 字符必中），而 64-hex 指纹被作者单独开了例外——**没想到 UUID**。
 *
 * 固定样例钉不住这类缺陷（仓里那条夹具 `42 段 + . + 4 段` 恰好是走运的那一侧）。
 * 所以这里用**生成式**：随机 key 形态 × 良形集合，两个方向各钉一遍。
 *
 * 判定口径与被测实现**同源**：`looksLikeCredentialValue` 与 `redactCredentialText`
 * 共用 `packages/contracts/src/errors.ts` 里的同一组正则，所以"判得出"必然"脱得掉"；
 * 本文件对**两个函数都**断言，避免"检测得到但脱敏不掉"这类缝。
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { looksLikeCredentialValue, redactCredentialText } from '../../packages/contracts/src/errors.js';

/** 一个"可接受的 token"字符（与实现的 token 字符集一致）。 */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.';

/**
 * 生成一个"高熵随机串"。刻意**可能含点**（`30+1+12` 这类官方包装形态），
 * 也刻意可能整段都不含点（base64url 形态）——两个都要拦。
 *
 * @param {number} minLen 最短长度
 * @param {number} maxLen 最长长度
 * @returns {string}
 */
function randomKeyLike(minLen, maxLen) {
  const len = minLen + Math.floor(Math.random() * (maxLen - minLen + 1));
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return out;
}

/**
 * 官方 coding-plan 的自有包装形态：长段 + 点 + 长段（CREDDECRYPT §2.3）。
 *
 * @param {number} headLen 点前段长度
 * @param {number} tailLen 点后段长度
 * @returns {string}
 */
function randomDottedKey(headLen, tailLen) {
  return multiSegmentKey([headLen, tailLen]);
}

/**
 * 生成「点分多段」高熵串：段与段之间**只**用点分隔，段内不含点。
 *
 * @param {readonly number[]} segmentLens 每一段的长度
 * @returns {string}
 */
function multiSegmentKey(segmentLens) {
  const pick = () => TOKEN_ALPHABET[Math.floor(Math.random() * 61)]; // 索引 0..60 不含末尾的点
  return segmentLens.map((len) => { let s = ''; for (let i = 0; i < len; i += 1) s += pick(); return s; }).join('.');
}

/**
 * 标识符形状（与 `host-driver.ts` 的 `DIAGNOSTIC_IDENTIFIER_SHAPE` **逐字同一条**）。
 * 这里独立写一份是为了让"豁免不是按形状"这条用例能**先确认样本满足形状**——
 * 否则一个不满足形状的随机样本会让那条用例平凡通过。
 */
const DIAGNOSTIC_SHAPE_RE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,64}$/;

/**
 * 良形集合：**必须不误伤**。
 * 每一项都是本产品真会出现在错误文本 / detail / 标识里的东西。
 * @type {ReadonlyArray<readonly [string, () => string]>}
 */
const BENIGN_SHAPES = [
  ['64-hex 证据指纹', () => randomBytes(32).toString('hex')],
  ['64-hex 全大写证据指纹', () => randomBytes(32).toString('hex').toUpperCase()],
  ['裸 UUID', () => randomUUID()],
  ['大写 UUID', () => randomUUID().toUpperCase()],
  ['chatcmpl- 前缀 UUID（本仓 operationId 形态）', () => `chatcmpl-${randomUUID()}`],
  ['多段标签前缀 UUID（session-drive 的 zcc-host-<operationId> 形态）', () => `zcc-host-chatcmpl-${randomUUID()}`],
  ['urn:uuid:', () => `urn:uuid:${randomUUID()}`],
  ['语义版本号', () => `${1 + Math.floor(Math.random() * 9)}.${Math.floor(Math.random() * 30)}.${Math.floor(Math.random() * 30)}`],
  ['长预发布语义版本号', () => `2.1.0-alpha.${Math.floor(Math.random() * 9)}+build.20260101120000`],
  ['ISO 时间戳', () => `2026-10-0${1 + Math.floor(Math.random() * 9)}T12:34:5${Math.floor(Math.random() * 9)}.789Z`],
  ['ISO 时间戳带时区偏移', () => `2026-10-0${1 + Math.floor(Math.random() * 9)}T12:34:56+08:00`],
  ['日期', () => `2026-10-0${1 + Math.floor(Math.random() * 9)}`],
  ['IPv4', () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`],
  ['Windows 路径段', () => 'C:\\Users\\someone\\.zcode\\cli\\db\\db.sqlite'],
  ['错误码短语', () => 'upstream rejected request, status 401'],
  ['会话 id 形态', () => 'stub-session-0001']
];

/**
 * 复审点名的**曾经漏拦**的那些长度/分段组合，逐个钉死。
 *
 * 标签沿用复审的写法：`20.12(33)` = 两段 20 与 12，中间一个点，总长 33；
 * `10.10.10(32)` = 三段各 10，总长 32。**每一段的字符数都 < 32**，
 * 所以上一版那条逐段判定的规则**必然**全部漏拦。
 * @type {ReadonlyArray<readonly [string, readonly number[]]>}
 */
const REVIEW_LEAK_SHAPES = [
  ['20.12(33)', [20, 12]],
  ['24.12(37)', [24, 12]],
  ['28.12(41)', [28, 12]],
  ['30.12(43)', [30, 12]],
  ['31.12(44)', [31, 12]],
  ['16.16.16(50)', [16, 16, 16]],
  ['10.10.10(32)', [10, 10, 10]]
];

describe('凭据形态 · 性质测试（BL-3：两个方向同时钉死）', () => {
  it('随机高熵长串（32–64 字符，可能带点）**必被判成凭据**且**必被脱敏掉**', () => {
    const samples = 400;
    for (let i = 0; i < samples; i += 1) {
      const key = randomKeyLike(32, 64);
      expect(looksLikeCredentialValue(key), `应判成凭据: ${key}`).toBe(true);
      const redacted = redactCredentialText(`upstream 401 apiKey=${key} status=403`);
      expect(redacted, `应脱敏: ${key}`).not.toContain(key);
      expect(redacted).toContain('upstream 401');
      expect(redacted).toContain('status=403');
    }
  });

  it('复审点名的 7 种「点两侧都不足 32」形态**全部拦得住**（上一版全部 LEAK）', () => {
    for (const [label, segmentLens] of REVIEW_LEAK_SHAPES) {
      const total = segmentLens.reduce((a, b) => a + b, 0) + segmentLens.length - 1;
      for (let i = 0; i < 20; i += 1) {
        const key = multiSegmentKey(segmentLens);
        expect(key.length, `${label} 样本长度对不上`).toBe(total);
        expect(looksLikeCredentialValue(key), `${label} 应判成凭据: ${key}`).toBe(true);
        const redacted = redactCredentialText(`apiKey=${key}`);
        expect(redacted, `${label} 应脱敏: ${key}`).not.toContain(key);
      }
    }
  });

  it('纯数字点分长串（≥32 字符）也拦得住——不是"字母才危险"', () => {
    for (let i = 0; i < 40; i += 1) {
      const groups = 3 + Math.floor(Math.random() * 3);
      let key = '';
      for (let g = 0; g < groups; g += 1) {
        if (g > 0) key += '.';
        const digits = 8 + Math.floor(Math.random() * 8);
        for (let d = 0; d < digits; d += 1) key += String(Math.floor(Math.random() * 10));
      }
      if (key.length < 32) continue;
      // 良形豁免只放 UUID / 语义版本号 / 64-hex；纯数字点分长串不在其中。
      expect(looksLikeCredentialValue(key), `应判成凭据: ${key}`).toBe(true);
      expect(redactCredentialText(`key=${key}`)).not.toContain(key);
    }
  });

  it('良形集合（UUID / ISO / 语义版本号 / 64-hex 指纹 / 路径 / 短语）**一个都不误伤**', () => {
    for (const [label, make] of BENIGN_SHAPES) {
      for (let i = 0; i < 25; i += 1) {
        const value = make();
        expect(looksLikeCredentialValue(value), `${label} 被误判成凭据: ${value}`).toBe(false);
        // 反向：`redactCredentialText` 也不会动它（口径同源，必须一致）。
        expect(redactCredentialText(value), `${label} 被误脱敏: ${value}`).toBe(value);
        // 放在句子里也必须原样保留。
        const inSentence = `SESSION_FAILED: value ${value} rejected`;
        expect(redactCredentialText(inSentence), `${label} 在句子里被改动`).toBe(inSentence);
      }
    }
  });

  it('阈值以下的长串不误伤（31 字符是刻意留在下面的）', () => {
    for (let i = 0; i < 40; i += 1) {
      const value = randomKeyLike(20, 31);
      expect(looksLikeCredentialValue(value), `31 字符以下被误判: ${value}`).toBe(false);
    }
  });

  it('64-hex 指纹的既有契约不倒退（逐位随机，≥64 位一律豁免）', () => {
    // 既有契约：a 64-hex fingerprint is evidence, not a credential。
    expect(looksLikeCredentialValue('a'.repeat(64))).toBe(false);
    expect(looksLikeCredentialValue('A'.repeat(64))).toBe(false);
    for (let i = 0; i < 40; i += 1) {
      const fingerprint = randomBytes(32).toString('hex');
      expect(looksLikeCredentialValue(fingerprint), `64-hex 指纹被误判: ${fingerprint}`).toBe(false);
    }
    // 但 63 位 hex 不是指纹，仍按凭据处理（豁免只对"恰好 64"）。
    const almost = randomBytes(32).toString('hex').slice(0, 63);
    expect(looksLikeCredentialValue(almost), `63-hex 被豁免: ${almost}`).toBe(true);
  });

  /**
   * HOSTFIX5 的**两个方向**同时钉：白名单里的官方符号名不再被误吞，
   * 而**同样形状**的随机高熵串仍然必被脱敏。
   *
   * 背景：2026-10-01 09:34 的实弹响应里，子宿主的 detail 是
   * `BUNDLE_EXPORTS_INCOMPLETE: 官方 bundle 缺少 createZCodeApp, [redacted], runZCodeProtocolAgent`
   * ——被 `[redacted]` 吃掉的是 `startProcessProviderRegistryRuntime`（33 字符），
   * **它不是凭据，是我们自己写的一个官方符号名**。
   *
   * **为什么是白名单而不是"标识符形状一律豁免"**：凭据形态是 `[A-Za-z0-9_.-]` 的极大连续段、
   * 长度 ≥32；一个 33 字符的 base62 随机串**必然**满足 `[A-Za-z_$][A-Za-z0-9_$.]{0,64}`
   * （以字母开头、长度 ≤65、字符全在类里）。所以"按形状豁免"等于"33 字符以上的凭据一律放行"，
   * 直接推翻 BL-3 的不漏拦性质。下面第二条用例就是为了钉住这一点。
   */
  it('已知错误码的消息里，白名单里的官方标识符**不被长 token 规则误吞**（HOSTFIX5 实弹）', async () => {
    const { sanitizeChildDetail, isKnownDiagnosticIdentifier, DIAGNOSTIC_IDENTIFIER_SHAPE, KNOWN_DIAGNOSTIC_IDENTIFIERS } =
      await import('../../packages/official-host/src/host-driver.js');
    // 逐字复原实弹那条消息（失败码换成 HOSTFIX5 之后真实存在的那个）。
    const detail = 'SESSION_FAILED: 官方 bundle 缺少 createZCodeApp, startProcessProviderRegistryRuntime, runZCodeProtocolAgent（不降级到"部分宿主"）';
    const clean = sanitizeChildDetail(detail);
    for (const name of ['createZCodeApp', 'startProcessProviderRegistryRuntime', 'runZCodeProtocolAgent']) {
      expect(clean, `官方符号名被误吞: ${name}`).toContain(name);
      expect(clean).not.toContain('[redacted]');
    }
    // 句子其余部分一字不动（可运维性没有被牺牲）。
    expect(clean).toContain('官方 bundle 缺少');
    expect(clean).toContain('不降级到');
    // 闭集本身：每个成员都逐字满足标识符形状，且被判定为"已知诊断标识符"。
    expect(KNOWN_DIAGNOSTIC_IDENTIFIERS.size).toBeGreaterThanOrEqual(6);
    for (const name of KNOWN_DIAGNOSTIC_IDENTIFIERS) {
      expect(DIAGNOSTIC_IDENTIFIER_SHAPE.test(name), `${name} 不满足标识符形状`).toBe(true);
      expect(isKnownDiagnosticIdentifier(name), `${name} 不被认作已知诊断标识符`).toBe(true);
    }
    // 而**不在**闭集里的东西一律不认（含一个形状完全相同的随机高熵串）。
    expect(isKnownDiagnosticIdentifier('Kx7pQm2Zr9TvB4nL8wYcH1dJfS6gA0eU3iO5uXqZ')).toBe(false);
    expect(isKnownDiagnosticIdentifier('totallyMadeUpSymbolName')).toBe(false);
    expect(isKnownDiagnosticIdentifier('has space')).toBe(false);
  });

  it('**豁免是白名单不是形状**：同样形状的随机高熵串仍然必被脱敏（不漏拦方向不倒退）', async () => {
    const { sanitizeChildDetail } = await import('../../packages/official-host/src/host-driver.js');
    // 标识符形状的字符集：**没有 `-`**（这正是它与"长随机 token"字符集 `[A-Za-z0-9_.-]`
    // 的关键差别，也是为什么上一种随机样本里 1/3 带 `-` 的那些不满足形状）。
    const IDENT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.';
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let checked = 0;
    while (checked < 80) {
      let key = LETTERS[Math.floor(Math.random() * LETTERS.length)] ?? 'a';
      const len = 32 + Math.floor(Math.random() * 33);
      for (let i = 1; i < len; i += 1) key += IDENT_ALPHABET[Math.floor(Math.random() * IDENT_ALPHABET.length)] ?? 'a';
      // 先确认它**确实**满足标识符形状，且**确实**被判成凭据（否则这条用例什么都没证明）。
      if (!DIAGNOSTIC_SHAPE_RE.test(key) || !looksLikeCredentialValue(key)) continue;
      checked += 1;
      // 即使放在一条**带错误码**的消息里（正是有豁免的那条路），也必须照脱。
      const clean = sanitizeChildDetail(`SESSION_FAILED: 官方 app-server 缺少 ${key}`);
      expect(clean, `标识符形状的随机高熵串被放行: ${key}`).not.toContain(key);
    }
    expect(checked, '一条都没采到有效样本').toBe(80);
  });

  it('**没有错误码前缀的自由文本不享受豁免**（来源不可控，一律按不可信处理）', async () => {
    const { sanitizeChildDetail } = await import('../../packages/official-host/src/host-driver.js');
    const clean = sanitizeChildDetail('some free text mentioning startProcessProviderRegistryRuntime here');
    expect(clean).not.toContain('startProcessProviderRegistryRuntime');
    expect(clean).toContain('[redacted]');
  });

  it('端到端：43 字符（30+1+12）key 经 sanitizeChildDetail 后不再出现（BL-3 复审点名的泄漏形态）', async () => {
    const { sanitizeChildDetail } = await import('../../packages/official-host/src/host-driver.js');
    for (let i = 0; i < 60; i += 1) {
      const key = randomDottedKey(30, 12);
      expect(key.length, '本用例的样本必须真的是 43 字符').toBe(43);
      const detail = `SESSION_FAILED: upstream 401 apiKey=${key} status=403`;
      const clean = sanitizeChildDetail(detail);
      expect(clean, `43 字符 key 原样到达: ${key}`).not.toContain(key);
      // 句子其余部分保留，可运维。
      expect(clean).toContain('upstream 401');
      expect(clean).toContain('status=403');
    }
  });
});
