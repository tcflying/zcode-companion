/**
 * tap-control.mjs — 回环控制通道。
 *
 * 这是我们**唯一**往桌面那条会话里注入请求的入口，也是把 app-server 应答取回来的
 * 出口。三条硬规则在这里落地：
 *
 *  1. **只绑回环**：`listen(port, '127.0.0.1')`，并在每个连接上再复核一次
 *     `remoteAddress`（`isLoopbackAddress`），非回环立即 destroy，不说一个字。
 *  2. **必须有令牌**：连接建立后**第一帧**必须是 auth 帧，令牌用
 *     `sha256 + timingSafeEqual` 比较定长摘要（不比较长度、不比较明文）。未通过
 *     回一个 `unauthorized`；连错两次直接断开。
 *  3. **凭据不经过这里**：控制端能拿到的只有 `classifyChildFrame` 判定为
 *     `control_response` 的帧，即"命名空间 id + 应答形状 + 在等待表里"。凭据请求帧
 *     （有 method）与凭据应答帧（id 不在命名空间）在到达本模块之前就被排除。
 *
 * 线格式（最终形状，UTF-8 NDJSON，一行一个 JSON 对象，`\n` 结束）：
 *
 *   C→T  {"zccTap":{"v":1,"op":"auth","token":"<ZCC_TAP_TOKEN>"}}          必须为第一帧
 *   T→C  {"zccTap":{"v":1,"op":"hello","protocol":1,"controlPort":8791}}
 *   C→T  {"zccTap":{"v":1,"op":"inject","id":"<关联串>","frame":{<要注入的帧>}}}
 *   T→C  {"zccTap":{"v":1,"op":"inject.ack","id":"<关联串>","requestId":"zcc-tap-…"}}
 *   T→C  {"zccTap":{"v":1,"op":"inject.error","id":"<关联串>","error":{"code":"…","field":"…","detail":"…"}}}
 *   T→C  {"zccTap":{"v":1,"op":"response","requestId":"zcc-tap-…","frame":{<原样应答>}}}
 *   T→C  {"zccTap":{"v":1,"op":"response.error","requestId":"zcc-tap-…","error":{"code":"timeout"}}}
 *   C→T  {"zccTap":{"v":1,"op":"ping"}}
 *   T→C  {"zccTap":{"v":1,"op":"pong"}}
 *   C→T  {"zccTap":{"v":1,"op":"status"}}
 *   T→C  {"zccTap":{"v":1,"op":"status","status":{<不含内容的诊断字段>}}}
 *   C→T  {"zccTap":{"v":1,"op":"close"}}
 *   T→C  {"zccTap":{"v":1,"op":"error","error":{"code":"…"}}}              然后断开
 *
 * 未匹配 id、超时、id 碰撞都是**确定行为**：回一个错误帧、丢等待项，**不重发、
 * 不猜测**。
 *
 * ## 异常隔离（TAPFIX3 / P1）
 *
 * tap 是桌面 spawn app-server 的**中间层**：tap 进程死 = 桌面那条会话一起死。因此控制
 * 通道的**每一条外部输入路径**都必须异常隔离——从 socket `data` 事件进来、经过切行、
 * JSON 解析、鉴权、op 分派、到 `options.inject` 调用的任何一处抛出的异常，都在这里被
 * 截住，变成给**该连接**的结构化错误回执，**绝不逃出事件处理器、绝不导致进程退出、
 * 不影响其它连接、更不影响中继**。
 *
 * 覆盖点（每个都各有测试）：
 *  1. `socket.on('data')` 整体（最外层兜底，含切行与缓冲累积）
 *  2. 单行切分与 `JSON.parse`
 *  3. `socket.on('close')` / `socket.on('error')`
 *  4. 服务端 `connection` 回调（回环复核、连接数闸门本身）
 *  5. 控制端 `auth` 帧的令牌比较
 *  6. `options.inject`（含其内部的通道标识收集——深嵌套帧曾在这里抛 `RangeError`）
 *  7. `options.status` 与所有回帧写出
 *  8. **`net.Server` 自身的 `error` 事件**（TAPN / N1，见 `startControlServer` 末尾的
 *     常驻监听器）
 *
 * 隔离层**不吞掉证据**：每次截住都记一条 `control_internal_error` 诊断（见 P4：只记
 * 连接 id、错误类别名、字节计数，不记帧内容、不记错误消息原文、不记令牌）。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import {
  CONTROL_MAX_CONNECTIONS,
  CONTROL_MAX_LINE_BYTES,
  TAP_ID_PREFIX,
  TAP_PROTOCOL_VERSION,
  isLoopbackAddress,
  isNamespacedId
} from './tap-core.mjs';

/**
 * 注入判定的结果：由入口实现（形状校验 + 白名单判定 + 写子进程 stdin 都发生在入口）。
 *
 * `invalid_frame_shape` 是 B1 新增的判定码：帧的顶层键不在官方
 * `zcodeProtocolRequestSchema`（`zcode.cjs:72` col 137537，`.strict()`）的键集合内。
 * 典型触发者就是 `jsonrpc: "2.0"`——官方 `.strict()` 会因为它把整帧拒掉。
 *
 * `frame_too_deep` 是 TAPFIX3(P1) 新增的判定码：通道标识扫描被
 * `MAX_CHANNEL_SCAN_DEPTH` 截断，那一段我们没看过，因此不能乐观放行。
 *
 * @typedef {{ ok: true, requestId: string }
 *   | { ok: false,
 *       code: 'unparsable_frame' | 'invalid_frame_shape' | 'model_field_missing' | 'blocked_channel' | 'channel_not_allowlisted' | 'bad_id_namespace' | 'frame_too_deep' | 'frame_too_large' | 'duplicate_id' | 'child_unavailable',
 *       field: string | null,
 *       matched: string | null,
 *       detail: string }} InjectVerdict
 */

/**
 * @typedef {Object} ControlServerOptions
 * @property {string} host
 * @property {number} port
 * @property {string} token
 * @property {(frame: Record<string, unknown>, connectionId: number) => InjectVerdict} inject 校验白名单并把帧写进子进程 stdin。返回判定结果。**本模块不假设它绝不抛**：它抛出的任何异常都会被隔离成给该连接的 `inject.error`（见文件头 P1 一节）。
 * @property {(event: string, fields: Readonly<Record<string, unknown>>) => void} diag 不含内容的诊断事件。字段还会被 `sanitizeDiagFields` 再过一遍。
 * @property {() => Readonly<Record<string, unknown>>} status 当前不含内容的运行状态，供 `status` 操作回显。
 */

/**
 * @typedef {Object} ControlServer
 * @property {number} port
 * @property {number} connections
 * @property {(connectionId: number, zccTap: Record<string, unknown>) => void} sendTo 向指定连接回一帧。连接已断开或未认证时静默丢弃。
 * @property {() => void} close 停止接受新连接并断开全部现有连接。幂等。
 * @property {boolean} closed
 * @property {import('node:net').Server} netServer 底层 `net.Server` 实例（只读引用）。暴露它的**唯一**理由是让 N1 的常驻 `error` 监听器可以被单测直接验证：accept 阶段的 `EMFILE` 在测试里无法自然构造，而 Node 的 `EventEmitter` 对**没有监听器的 `error` 事件直接 throw**——不拿到这个对象就证明不了那条监听器在。它只是同进程内的引用，**永远不会离开 tap**（控制通道是 NDJSON 帧，没有序列化控制对象的位置）。
 */

/** @param {unknown} value @returns {Buffer} */
function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : String(value), 'utf8').digest();
}

/**
 * 定长摘要比较：两个不同长度的输入也不会让比较耗时随长度变化。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * 只取错误的**类别名**，绝不取 `message` 或 `stack`（P4）。
 *
 * `message` 可能包含调用方回显的内容（注入帧里的字段值、路径、甚至控制令牌被拼进去的
 * 串），`stack` 里有绝对安装路径。诊断通道两者都不接受。类别名是我们自己抛的
 * `RangeError` / `TypeError` 之类，形如 `^[A-Za-z][A-Za-z0-9_]{0,31}$`；不符合的一律
 * 归一化成 `UnknownError`，**不给任何外部可控字符串留位置**。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorClassName(error) {
  let name = '';
  try {
    if (typeof error === 'object' && error !== null) {
      const ctor = /** @type {{ constructor?: { name?: unknown } }} */ (error).constructor;
      if (ctor !== undefined && ctor !== null && typeof ctor.name === 'string') name = ctor.name;
    }
  } catch {
    name = '';
  }
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(name) ? name : 'UnknownError';
}

/**
 * 只取操作系统/Node 系统错误的**短码**（`EMFILE` / `ENFILE` / `EADDRINUSE` …），
 * 绝不取 `message`（P4 与 `errorClassName` 同一条纪律）。
 *
 * 为什么还要**归一化**：`code` 键在 `DIAG_FIELD_ALLOWLIST` 里，而白名单只做
 * 长度 ≤ 64 的检查——一个外部可控串只要够短就能落盘。系统错误的 `code` 在实践中是
 * Node 自己的一组固定常量，但既然能白拿一道窄闸，就不要依赖"实践中"。
 *
 * 形状 `^[A-Z][A-Z0-9_]{0,31}$` 之外的一律归一化成 `'EUNKNOWN'`，与
 * `errorClassName` 的处理方式对称。
 *
 * @param {unknown} error
 * @returns {string}
 */
function systemErrorCode(error) {
  let code = '';
  try {
    if (typeof error === 'object' && error !== null) {
      const raw = /** @type {{ code?: unknown }} */ (error).code;
      if (typeof raw === 'string') code = raw;
    }
  } catch {
    code = '';
  }
  return /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : 'EUNKNOWN';
}

/**
 * 打开控制通道。
 *
 * @param {ControlServerOptions} options
 * @returns {Promise<ControlServer>}
 */
export async function startControlServer(options) {
  /** @type {Map<number, import('node:net').Socket>} */
  const live = new Map();
  let nextConnectionId = 1;
  let closed = false;
  // 实际绑定的端口。`--control-port 0`（系统分配）时与请求值不同，
  // hello 回执必须报**实际**端口，否则控制端无从知道往哪儿连。
  let boundPort = options.port;

  /**
   * 诊断写入的**唯一**出口，且**绝不抛**。
   *
   * 为什么不直接用 `options.diag`：隔离层（P1）自己也要记诊断。如果写诊断本身抛错，
   * 异常会在 catch 处理器里二次逃逸——正好把我们最需要的那条记录变成杀死进程的凶手。
   * 与 `zcode-stdio-tap.mjs` 的 `createDiagWriter`（"诊断写不出去就不写，绝不让它把
   * 中继带崩"）同一条纪律。
   *
   * @param {string} event
   * @param {Readonly<Record<string, unknown>>} [fields]
   */
  const diag = (event, fields = {}) => {
    try {
      options.diag(event, fields);
    } catch {
      // 诊断不可用不是控制通道的故障，更不是让进程退出的理由。
    }
  };

  /**
   * @param {number} connectionId
   * @param {Record<string, unknown>} zccTap
   */
  const sendTo = (connectionId, zccTap) => {
    const socket = live.get(connectionId);
    if (socket === undefined || socket.destroyed) return;
    // `writableEnded` 也要看：已经 `end()` 过的 socket 再 `write()` 会发
    // `ERR_STREAM_WRITE_AFTER_END`，而可写流默认 `autoDestroy`，那个 error 会**销毁**
    // 这条 socket——**连同还没 flush 出去的那一帧错误回执一起丢掉**。超界断连时控制端
    // 可能还在往里灌几百 KB（测试里就是 2 MiB+），若不挡，`fail()` 之后的每个 chunk
    // 都会再触发一次 `fail()`，于是"结构化错误回执"会在高负载下偶发丢失。
    if (socket.writableEnded) return;
    let line;
    try {
      line = `${JSON.stringify({ zccTap })}\n`;
    } catch {
      return;
    }
    if (socket.writableLength > CONTROL_MAX_LINE_BYTES) {
      // 控制端读得慢：不允许 socket 缓冲无界增长，直接断开并计数。
      diag('control_write_overflow', { controlConnections: live.size, connectionId });
      socket.destroy();
      return;
    }
    try {
      socket.write(line);
    } catch {
      // 写一条**自己构造的**诊断帧都失败 = 这条连接已经没救了，丢掉它。
      // 绝不让回帧失败升级成进程退出。
      diag('control_write_failed', { result: 'error', connectionId, bytes: line.length });
      socket.destroy();
    }
  };

  const server = createServer({ allowHalfOpen: false }, (socket) => {
    // 服务端 `connection` 回调本身也在隔离范围内：回环复核、连接数闸门、诊断写入
    // 任何一处抛错都不能让异常逃进 net 的事件发射。
    try {
      if (closed) {
        socket.destroy();
        return;
      }
      if (!isLoopbackAddress(socket.remoteAddress ?? undefined)) {
        // 绑定已经是回环，这里是第二道闸：即便有连接进来也必须是本机。
        diag('control_rejected', { result: 'non_loopback' });
        socket.destroy();
        return;
      }
      if (live.size >= CONTROL_MAX_CONNECTIONS) {
        diag('control_rejected', { result: 'too_many_connections', controlConnections: live.size });
        socket.destroy();
        return;
      }
    } catch {
      diag('control_rejected', { result: 'internal_error' });
      socket.destroy();
      return;
    }
    const connectionId = nextConnectionId;
    nextConnectionId += 1;
    live.set(connectionId, socket);
    diag('control_open', { controlConnections: live.size, controlPort: options.port, connectionId });

    /** @type {Buffer} */
    let buffered = Buffer.alloc(0);
    let authenticated = false;
    let authAttempts = 0;
    /**
     * 这条连接是否已进入终止态（发过终止错误帧、`socket.end()` 已调用）。
     *
     * 为什么需要：超界断连时控制端往往**还在往这条流里灌数据**（上限 2 MiB，测试里
     * 一次就灌 2 MiB+）。没有这个标志，`socket.on('data')` 会对后续每一个 chunk 重跑
     * `consumeChunk`，而 `buffered` 里那份超界数据从未被清掉，于是 `fail()` 被反复调用：
     * 一条 `control_error` 诊断被重复记成千上万次，且每一次都在**已经 `end()` 的 socket
     * 上再 `write()`**（见 `sendTo` 里 `writableEnded` 的说明——那会连带丢掉第一次的
     * 错误回执）。置位之后这条连接彻底不再处理输入。
     */
    let terminated = false;

    /** @param {Record<string, unknown>} zccTap */
    const send = (zccTap) => sendTo(connectionId, zccTap);

    /** @param {string} code @param {string} detail */
    const fail = (code, detail) => {
      // 先置终止标志**再**回帧：回帧之后紧跟的 `end()` 会让对端开始看到 FIN，这段
      // 期间到达的任何数据都不再处理（否则同一条 `fail` 会被重复触发）。
      terminated = true;
      send({ v: TAP_PROTOCOL_VERSION, op: 'error', error: { code, detail } });
      diag('control_error', { code, result: 'error', controlConnections: live.size, connectionId });
      socket.end();
    };

    /**
     * 隔离层的落点：把一个已经被截住的异常变成**给该连接**的结构化回执。
     *
     * 只回固定文案（`internal_error`），**不回 `error.message`**（P4）——message 可能
     * 含调用方回显的内容。诊断侧只记 `errorClassName(error)`、连接 id、字节数。
     *
     * @param {unknown} error
     * @param {{ op?: 'error' | 'inject.error', id?: string | null, bytes?: number }} [shape]
     */
    const isolate = (error, shape) => {
      const id = shape?.id ?? null;
      diag('control_internal_error', {
        result: 'error',
        code: errorClassName(error),
        connectionId,
        controlConnections: live.size,
        ...(shape?.bytes === undefined ? {} : { bytes: shape.bytes })
      });
      if (shape !== undefined && shape.op === 'inject.error') {
        send({
          v: TAP_PROTOCOL_VERSION,
          op: 'inject.error',
          id,
          error: { code: 'internal_error', field: null, detail: '控制帧处理失败' }
        });
        return;
      }
      send({
        v: TAP_PROTOCOL_VERSION,
        op: 'error',
        error: { code: 'internal_error', detail: '控制帧处理失败' }
      });
    };

    /** @param {unknown} raw */
    const onEnvelope = (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        fail('invalid_frame', '不是合法的 zccTap 帧');
        return;
      }
      const zccTap = /** @type {Record<string, unknown>} */ (raw)['zccTap'];
      if (typeof zccTap !== 'object' || zccTap === null || Array.isArray(zccTap)) {
        fail('invalid_frame', '缺少 zccTap 包装对象');
        return;
      }
      const envelope = /** @type {Record<string, unknown>} */ (zccTap);
      if (envelope['v'] !== TAP_PROTOCOL_VERSION) {
        fail('protocol_version_mismatch', `只接受 v=${TAP_PROTOCOL_VERSION}`);
        return;
      }
      const op = envelope['op'];
      if (typeof op !== 'string') {
        fail('invalid_frame', 'op 必须是字符串');
        return;
      }

      if (op === 'auth') {
        authAttempts += 1;
        const token = envelope['token'];
        // 令牌比较也在隔离范围内：它读的是 `options.token`，而那可能来自一个我们没
        // 预料到形状的来源。比较失败按"令牌无效"处理——**不回显任何比较细节**。
        let ok = false;
        try {
          ok = typeof token === 'string' && constantTimeEquals(token, options.token);
        } catch (error) {
          diag('control_internal_error', {
            result: 'error',
            code: errorClassName(error),
            connectionId,
            phase: 'auth'
          });
          ok = false;
        }
        if (!ok) {
          diag('control_auth_failed', { result: 'error', controlConnections: live.size, connectionId });
          send({ v: TAP_PROTOCOL_VERSION, op: 'error', error: { code: 'unauthorized', detail: '令牌无效' } });
          if (authAttempts >= 2) socket.destroy();
          return;
        }
        authenticated = true;
        send({ v: TAP_PROTOCOL_VERSION, op: 'hello', protocol: TAP_PROTOCOL_VERSION, controlPort: boundPort });
        return;
      }

      if (!authenticated) {
        fail('unauthorized', '第一帧必须是 auth');
        return;
      }

      if (op === 'ping') {
        send({ v: TAP_PROTOCOL_VERSION, op: 'pong' });
        return;
      }
      if (op === 'status') {
        /** @type {Readonly<Record<string, unknown>>} */
        let snapshot;
        try {
          snapshot = options.status();
        } catch (error) {
          // status 拿不到就明说拿不到，绝不让它把进程带走。
          isolate(error);
          return;
        }
        send({ v: TAP_PROTOCOL_VERSION, op: 'status', status: { ...snapshot } });
        return;
      }
      if (op === 'close') {
        socket.end();
        return;
      }
      if (op === 'inject') {
        const correlation = envelope['id'];
        const corrId = typeof correlation === 'string' ? correlation : null;
        const frame = envelope['frame'];
        if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
          send({
            v: TAP_PROTOCOL_VERSION,
            op: 'inject.error',
            id: corrId,
            error: { code: 'unparsable_frame', field: null, detail: 'frame 必须是 JSON 对象' }
          });
          return;
        }
        const record = /** @type {Record<string, unknown>} */ (frame);
        if (!isNamespacedId(record['id'])) {
          // id 命名空间不匹配 = 确定行为：报错，不重发、不猜测。
          send({
            v: TAP_PROTOCOL_VERSION,
            op: 'inject.error',
            id: corrId,
            error: {
              code: 'bad_id_namespace',
              field: 'frame.id',
              detail: `注入请求的 id 必须是 ${TAP_ID_PREFIX} 前缀的字符串`
            }
          });
          return;
        }
        // **这里是 TAPFIX3(P1) 的核心。** `options.inject` 内部会做通道标识收集
        // （`collectChannelTokens` 递归）。一条嵌套上万层的帧曾让那个递归抛
        // `RangeError`，异常直接逃出 `socket.on('data')` → 进程退出 → 桌面会话一起死。
        // 现在无论它抛出什么，都变成一条带关联 id 的 `inject.error`，**连接保持可用**。
        /** @type {import('./tap-control.mjs').InjectVerdict} */
        let verdict;
        try {
          verdict = options.inject(record, connectionId);
        } catch (error) {
          isolate(error, { op: 'inject.error', id: corrId });
          return;
        }
        if (verdict === null || typeof verdict !== 'object' || typeof verdict.ok !== 'boolean') {
          // 入口返回了非判定值：同样是"这条帧没法处理"，不是"重启 tap"。
          isolate(new TypeError('inject returned a non-verdict'), { op: 'inject.error', id: corrId });
          return;
        }
        if (!verdict.ok) {
          diag('inject_rejected', { code: verdict.code, result: 'error', connectionId });
          send({
            v: TAP_PROTOCOL_VERSION,
            op: 'inject.error',
            id: corrId,
            error: { code: verdict.code, field: verdict.field, detail: verdict.detail }
          });
          return;
        }
        diag('inject_accepted', { code: 'inject', result: 'ok', connectionId });
        send({ v: TAP_PROTOCOL_VERSION, op: 'inject.ack', id: corrId, requestId: verdict.requestId });
        return;
      }
      fail('unknown_op', `未知操作 ${op}`);
    };

    /**
     * 单帧的完整处理路径：切行 → JSON.parse → 分派。**任何一处抛出都在这里落回**，
     * 并且**该连接继续可用**（后续帧照常服务）。
     *
     * 之所以逐帧隔离而不是整个 `data` 事件一刀切：一块 chunk 里可能有多帧，一条坏帧
     * 不该让同一 chunk 里后面的好帧一起陪葬。
     *
     * @param {Buffer} chunk
     * @returns {boolean} 连接是否已进入终止态（调用方据此停止处理后续行）
     */
    const consumeChunk = (chunk) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      for (;;) {
        const nl = buffered.indexOf(0x0a);
        if (nl < 0) break;
        // **行长上限在这里就生效（TAPFIX3 / P2）。** 检查放在切走之前：超界行
        // **不切走、不解析**，直接回 `frame_too_large` 并断连。放在切行循环之后
        // 是无效的——完整的大行在那之前就已经被消费掉了，上限对"一行到底"的帧形同虚设。
        // 判据是 `nl + 1`（含行终止符），与 `MAX_INJECT_LINE_BYTES` 的计数口径一致。
        if (nl + 1 > CONTROL_MAX_LINE_BYTES) {
          fail('frame_too_large', `控制帧超过 ${CONTROL_MAX_LINE_BYTES} 字节上限`);
          return true;
        }
        const line = buffered.subarray(0, nl).toString('utf8');
        buffered = buffered.subarray(nl + 1);
        if (line.trim().length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail('invalid_json', '不是合法 JSON');
          return true;
        }
        try {
          onEnvelope(parsed);
        } catch (error) {
          // 分派层漏掉的东西在这一层兜住（`onEnvelope` 内部已各自隔离，这里是双保险）。
          isolate(error, { bytes: line.length });
        }
        if (socket.destroyed || socket.writableEnded) return true;
      }
      // **累积阶段**的守卫：还没见到行终止符的尾段已经超界，就不必再攒了。
      // `+ 1` 是那条尚未到达的行终止符——与上面完整行的判据保持同一条界线，
      // 于是"先分块到达"和"一次到达"得到完全相同的结论。
      if (buffered.length + 1 > CONTROL_MAX_LINE_BYTES) {
        fail('frame_too_large', `控制帧超过 ${CONTROL_MAX_LINE_BYTES} 字节上限`);
        return true;
      }
      return false;
    };

    // 隔离覆盖点 1：`data` 事件的最外层兜底。`consumeChunk` 内部已经逐层隔离，
    // 这里防的是连 `Buffer.concat` / `subarray` 都可能抛出的情况（例如 chunk 不是
    // Buffer）。**这一层也绝不 rethrow**——tap 死了桌面会话就死了。
    socket.on('data', (chunk) => {
      // 已终止的连接不再处理任何输入。**这不是优化，是正确性**：超界断连时对端还在
      // 继续灌数据，而 `buffered` 里那份超界内容从未被清掉，继续跑 `consumeChunk`
      // 会把同一条 `fail()` 重复触发成千上万次（诊断刷屏 + 在已 `end()` 的 socket 上
      // 反复 write，第一次那条错误回执会被连带丢掉）。
      if (terminated) return;
      try {
        consumeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      } catch (error) {
        isolate(error);
      }
    });

    // 隔离覆盖点 3：socket 自身的 `close` / `error` 事件回调。这些回调跑在 net 的
    // 事件发射里，抛出去就是 uncaughtException → 进程退出 → 桌面会话一起死。
    const drop = () => {
      try {
        if (!live.delete(connectionId)) return;
        diag('control_close', { result: 'closed', controlConnections: live.size, connectionId });
      } catch (error) {
        diag('control_internal_error', {
          result: 'error',
          code: errorClassName(error),
          connectionId,
          phase: 'close'
        });
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('end', () => {
      try {
        // `allowHalfOpen:false` 下 Node 会自动 end 回程；这里只是确保半关闭的连接
        // 不会把 `live` 里的条目留成僵尸。
        if (!socket.destroyed) socket.end();
      } catch (error) {
        diag('control_internal_error', {
          result: 'error',
          code: errorClassName(error),
          connectionId,
          phase: 'end'
        });
      }
    });
  });

  // **TAPN / N1：`net.Server` 的 `error` 监听器必须是常驻的，且它自己绝不抛。**
  //
  // Node 的 `EventEmitter` 对**没有监听器的 `error` 事件直接 throw**。而 `net.Server`
  // 在 listen 成功**之后**仍然可能发 `error`——典型是 accept 阶段句柄耗尽的 `EMFILE` /
  // `ENFILE`（Windows 上高并发或句柄紧张时确实会发生）。那一刻若服务器上一个 `error`
  // 监听器都没有，异常一路冒到 `uncaughtException` → tap 进程死 → **桌面那条
  // app-server 会话一起死**。
  //
  // 下一段那个 `server.once('error', reject)` 只负责"listen 失败要 reject 出去"，
  // 成功之后会被 `removeListener` 摘掉——**摘掉的是它，不是下面这个**。这条常驻的
  // 因此在整个生命周期里都挂着，且自身只做一件事：记一条不含内容的诊断。
  //
  // 触发条件是操作系统资源耗尽而不是任何一条控制帧能构造出来的（复审 §2.3 认定它
  // 非阻塞），但既然要重启桌面了就没有理由留着。
  server.on('error', (error) => {
    diag('control_server_error', {
      result: 'error',
      code: systemErrorCode(error),
      controlConnections: live.size
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve(undefined);
    });
  });

  return {
    port: boundPort,
    get connections() {
      return live.size;
    },
    get closed() {
      return closed;
    },
    netServer: server,
    sendTo,
    close() {
      if (closed) return;
      closed = true;
      // 顺序：先停止接受新连接 → 再断开现有连接。
      // 每一步都隔离：关停路径同样不能让异常逃出去。
      try {
        server.close();
      } catch (error) {
        diag('control_internal_error', { result: 'error', code: errorClassName(error), phase: 'close_server' });
      }
      for (const socket of live.values()) {
        try {
          socket.destroy();
        } catch {
          // 已经断了。
        }
      }
      live.clear();
    }
  };
}
