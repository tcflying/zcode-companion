/**
 * OFFICIAL-HOST 公共入口。
 *
 * 一句话：让"companion 当宿主"这条路的**纯逻辑**（信封解密 / 出站白名单 / entitled
 * 真实来源推导 / thoughtLevel fail-closed / 子进程崩溃隔离传输层）全部可被单测直接钉死，
 * 而**任何一次真实触网**都必须先经过子宿主进程。
 *
 * 边界（不可协商）：
 *  - **明文零落地**：`CredentialValue.reveal()` 是唯一出口，唯一去向是子宿主内的
 *    官方 port。父子通道上**没有**任何承载凭据的帧。
 *  - **不伪造 entitled**：写 `entitled:true` 的唯一充分条件是官方本地缓存说 available。
 *  - **付费通道永封锁**：`account:` 白名单在取键**之前**判定，命中即拒且不触网。
 *  - **崩溃隔离**：官方 bundle 只在子进程里被 require；它的 `process.exit()` 带不走
 *    API 服务进程。
 *  - **不传 standalone**：本包不导出 `credentialStore` 形状。
 */
export * from './credentials.js';
export * from './headers-port.js';
export * from './entitlement.js';
export * from './host-driver.js';
