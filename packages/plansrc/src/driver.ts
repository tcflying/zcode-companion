/**
 * PLANSRC local-official 驱动器 —— 第三种驱动状态（真实本地数据，零发送）。
 *
 * 四条硬事实：
 *  1. **它只提供目录，不提供模型产出。** `stream()` 调用即抛 `upstream_unavailable`：
 *     本包不发模型请求，所以它根本没有能产出的上游。任何"能返回内容"的实现都会是造假。
 *  2. **`status` 必须是 `not_attached`，因此 `model_is_real` 为 false。**
 *     `deriveModelIsReal()` 是唯一口径：`status === 'ready' && !fixture && models.length > 0`。
 *     目录条目是**真实的**（来自官方安装树），但"这个驱动器能给你真实模型输出"是不成立的。
 *     把 status 报成 `ready` 会让 `/v1/chat/completions` 走进 `driver.stream()`，
 *     也会让 `model_is_real` 变成 true —— 那是在声称一件本包做不到的事。
 *     保守方向（false）永远是对的方向。
 *  3. **`models` 保持空数组。** `/v1/models` 是给外部 IDE 用的；把不能服务的模型列出去
 *     会让 IDE 配置成功却在第一次请求时失败。目录走 `/v1/zcc/catalog`，各司其职。
 *  4. **默认不启用。** 本模块导出的只是构造函数，`ApiServerConfig.driver` 缺省仍是
 *     `createUnavailableDriver()`。要启用必须由宿主显式构造并传入——
 *     这就是"显式配置启用，默认仍无驱动"的实现方式。
 */
import { ApiError } from '../../api/src/errors.js';
import type { ChatDriver, DriverCatalog, DriverEvent, DriverRequest } from '../../api/src/chat.js';

/** 驱动器名。`x-zcc-driver` 响应头与 `zcc.driver` 字段会带上它。 */
export const LOCAL_OFFICIAL_DRIVER_NAME = 'local-official';

export interface CreateLocalOfficialDriverOptions {
  /** 三个已读源（本包不需要它们的内容，只需要"读过了、来源可追"这个事实）。 */
  readonly sources: unknown;
  /** 已映射好的目录。 */
  readonly catalog: DriverCatalog;
  /** 人可读的来源说明，进 `x-zcc-detail`。只写路径与条目数，不写任何凭据。 */
  readonly sourceDetail?: string;
}

/**
 * 构造 local-official 驱动器。
 *
 * @param options 已读源 + 目录
 * @returns `ChatDriver`：`not_attached` / 非 fixture / 空 models / 真实目录 / stream 抛错
 */
export function createLocalOfficialDriver(options: CreateLocalOfficialDriverOptions): ChatDriver {
  const entryCount = options.catalog.models.length;
  const detail =
    options.sourceDetail ??
    `目录来自本机官方本地文件（${entryCount} 个条目，revision ${options.catalog.revision}）：只读、零发送、零模型产出通道`;
  return {
    name: LOCAL_OFFICIAL_DRIVER_NAME,
    status: 'not_attached',
    statusDetail: `${detail}；尚无模型产出通道，不会返回任何模型内容、token 或 usage`,
    models: [],
    fixture: false,
    // 目录型驱动器：它连模型产出通道都没有，谈不上强制执行上限。报 `false`（保守方向），
    // 让披露只可能更诚实。见 `ChatDriver.enforcesMaxTokens`。
    enforcesMaxTokens: false,
    catalog: options.catalog,
    async *stream(request: DriverRequest): AsyncGenerator<DriverEvent> {
      void request;
      throw new ApiError(
        'upstream_unavailable',
        'local-official 驱动器只提供目录：它不发模型请求，因此没有任何模型产出可返回',
        { driver: LOCAL_OFFICIAL_DRIVER_NAME, catalog_only: true, catalog_revision: options.catalog.revision }
      );
    }
  };
}
