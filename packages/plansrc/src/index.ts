/**
 * PLANSRC 公共入口。
 *
 * 一句话：把三个**只读**的官方本地文件（provider 目录 / 当前选择 / 资格缓存）
 * 变成既有 `/v1/zcc/catalog` 契约能直接吃的目录，外加一份独立的 `planStatus`
 * 与一份供 I06 定级的 `e1Evidence`。
 *
 * 边界（再次逐条声明，因为这些都是不可协商的红线）：
 *  - **零发送**：没有 fetch / http / child_process / 官方进程 / 数据库。
 *  - **只读**：三个源文件只被 `readFileSync` 打开读取，从不写、从不删、绝不 rename。
 *  - **凭据值永不进内存输出**：擦除发生在 `JSON.parse` 之前（见 reader.ts）。
 *  - **不扩契约**：catalog 条目形状一字未动；`planStatus` 走独立结构，
 *    本包**不实现**任何新端点（是否扩契约由协调者裁定，见报告）。
 *
 * 典型接法（显式启用；不接就是默认无驱动）：
 * ```ts
 * const { driver, catalog, plans, evidence } = loadLocalOfficialDriver();
 * const server = createApiServer({ enabled: true, apiKeys: [k], driver });
 * ```
 */
import type { ChatDriver, DriverCatalog } from '../../api/src/chat.js';
import { readPlanSources, resolvePlanSourcePaths, type ReadPlanSourcesOptions, type PlanSources, type ResolvedPlanSourcePaths } from './reader.js';
import { buildE1Evidence, buildPlanStatuses, mapBuiltinToCatalog, type E1Evidence, type PlanStatus } from './mapper.js';
import { createLocalOfficialDriver } from './driver.js';

export * from './reader.js';
export * from './mapper.js';
export * from './driver.js';

export interface LoadedLocalOfficial {
  readonly sources: PlanSources;
  readonly paths: ResolvedPlanSourcePaths;
  readonly catalog: DriverCatalog;
  readonly plans: readonly PlanStatus[];
  readonly evidence: E1Evidence;
  readonly driver: ChatDriver;
}

/**
 * 一步读三文件 → 目录 + planStatus + 证据 + 驱动器。
 *
 * 任一源文件缺失 / 不可读 / 非 UTF-8 / 非法 JSON / 形状不对都会抛
 * `PlanSourceError`（明确错误码，指名文件），**不会**用占位数据补齐。
 *
 * @param options 路径覆盖 / `allowMissing` / 时钟
 * @returns 四件套
 */
export function loadLocalOfficialDriver(options: ReadPlanSourcesOptions = {}): LoadedLocalOfficial {
  const sources = readPlanSources(options);
  const catalog = mapBuiltinToCatalog(sources.builtin);
  const plans = buildPlanStatuses({ sources, catalog });
  const evidence = buildE1Evidence(sources, catalog, plans);
  const driver = createLocalOfficialDriver({
    sources,
    catalog,
    sourceDetail: `目录来自本机官方本地文件（${catalog.models.length} 个条目，revision ${catalog.revision}）：只读、零发送`
  });
  return { sources, paths: resolvePlanSourcePaths(options.paths ?? {}), catalog, plans, evidence, driver };
}
