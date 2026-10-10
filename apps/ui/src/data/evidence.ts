/**
 * ZCC-ACCOUNT-EVIDENCE-20261009 · 证据等级的**计算**层（纯函数，零网络、零 React）。
 *
 * 变更前的口径是常量 `CURRENT_EVIDENCE = 'E0'`（`snapshot.ts`）。本模块把
 * "证据等级"从写死的常量改成**按读回状态计算**，并给出可复核的判定理由。
 *
 * ## 计算规则（唯一口径，全部消费点共用本函数）
 *
 * | 读回状态                              | 等级 | reasonCode                |
 * |--------------------------------------|------|---------------------------|
 * | 未读取（默认，尚未发起请求）           | E0   | `catalog_not_read`        |
 * | 读取中                                | E0   | `catalog_loading`         |
 * | 读取失败（带原因码）                  | E0   | 失败原因码原样透传        |
 * | 读回成功但 0 条目                     | E0   | `catalog_empty`           |
 * | 读回成功、0 个 entitled 条目           | E0   | `catalog_no_entitled`     |
 * | 读回成功、≥1 个 entitled 条目          | E1   | `catalog_entitled_present`|
 *
 * E2 / E3 本轮**不可达**：它们分别要求"真实模型请求/终态"与"权威桶/账单前后读数"，
 * 而本产品的发送门结构上关闭（dispatch = 0），因此不存在这两类证据的来源。
 * 与其写一个到不了的分支，本模块直接不产出它们——不可达也是事实。
 *
 * ## 三条不变量
 *  1. **只有目录读回能把等级抬到 E1。** 读失败、空目录、无 entitled 一律 E0。
 *  2. **E1 不解锁发送。** 本产品界面上不存在任何可点击发送入口，`unlocksSend`
 *     恒为 `false`；等级只描述"证据强度"，不描述"可发送"。ChatPage 的发送门
 *     逻辑与本模块无关，也未被改动。
 *  3. **失败不保留旧等级依据。** `phase !== 'loaded'` 时 `summary` 恒为 null，
 *     因此"上一次读到了 entitled"不会冒充当前等级。
 */

import type { AccountCatalogState } from './accountCatalog';
import { EVIDENCE_SUMMARY, type EvidenceLevel } from './snapshot';

export interface EvidenceVerdict {
  readonly level: EvidenceLevel;
  /** 机器可读的原因码：要么是目录侧判定码，要么是读取失败原因码原样透传。 */
  readonly reasonCode: string;
  /** 人读理由：一定包含 revision / 条目数或失败原因码，不留空白。 */
  readonly reason: string;
  /** 恒为 false：证据等级不改变发送门（本产品无任何发送入口）。 */
  readonly unlocksSend: false;
}

/** 本轮可达的等级闭集。E2/E3 无证据来源，不在此列。 */
export const REACHABLE_EVIDENCE_LEVELS: readonly EvidenceLevel[] = ['E0', 'E1'];

/**
 * 唯一的证据等级计算入口。**纯函数**：给定读回状态，输出等级与理由。
 *
 * @param catalog 「账号与权益」的读回状态（见 `accountCatalog.ts`）
 */
export function computeEvidenceLevel(catalog: AccountCatalogState): EvidenceVerdict {
  const deny = (reasonCode: string, reason: string): EvidenceVerdict => ({
    level: 'E0',
    reasonCode,
    reason,
    unlocksSend: false
  });

  switch (catalog.phase) {
    case 'idle':
      return deny('catalog_not_read', '尚未发起只读目录请求，没有目录与资格证据。');
    case 'loading':
      return deny('catalog_loading', '正在只读读取目录；读回完成前不定级，不沿用上一次结果。');
    case 'failed': {
      const code = catalog.failure?.code ?? 'unknown';
      const detail = catalog.failure?.message ?? '未知失败';
      return deny(code, `目录读取失败（${code}）：${detail}`);
    }
    case 'loaded': {
      const summary = catalog.summary;
      // 防御：loaded 却无 summary 时不得升格，退回 E0 并说清原因。
      if (summary === null) {
        return deny('catalog_no_summary', '目录标记为已读回但没有事实内容，按无证据处理。');
      }
      if (summary.total === 0) {
        return deny('catalog_empty', `目录读回成功但 0 条条目（revision ${summary.revision}），无资格证据。`);
      }
      if (summary.entitled === 0) {
        return deny(
          'catalog_no_entitled',
          `目录读回成功（revision ${summary.revision}，${summary.total} 条），但没有目录侧套餐/活动通道条目，资格未成立。`
        );
      }
      return {
        level: 'E1',
        reasonCode: 'catalog_entitled_present',
        reason:
          `目录读回成功（revision ${summary.revision}，${summary.total} 条条目），其中 ${summary.entitled} 条属于` +
          '目录侧套餐/活动通道（billingClass = subscription | promotion）；这是目录口径的资格证据，' +
          '不等同于账号握手已证明，也不改变发送门。',
        unlocksSend: false
      };
    }
    default: {
      // 闭集外相位（理论上不可达）按 E0 处理并说明，绝不猜。
      const raw: unknown = catalog.phase;
      return deny('unknown_phase', `未登记的读回状态 ${JSON.stringify(raw)}，按无证据处理。`);
    }
  }
}

/** 等级 chip 的语气。E1 是"已拿到目录侧资格证据"，用 accent；E0 一律 warn。 */
export function evidenceTone(level: EvidenceLevel): 'warn' | 'accent' {
  return level === 'E1' ? 'accent' : 'warn';
}

/** 等级 chip 的完整文案：`E1 · 目录侧资格证据成立（发送门仍关闭）`。 */
export function evidenceChipLabel(verdict: EvidenceVerdict): string {
  return `${verdict.level} · ${verdict.level === 'E1' ? '目录侧资格证据成立' : '无资格证据'}（发送门仍关闭）`;
}

/** 该等级的一句话定义（复用 `snapshot.EVIDENCE_SUMMARY`，不另立一套说法）。 */
export function evidenceSummaryOf(level: EvidenceLevel): string {
  return EVIDENCE_SUMMARY[level];
}