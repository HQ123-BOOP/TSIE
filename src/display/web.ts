/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * virtio-gpu 画面的浏览器前端：内置 HTTP 服务一个 canvas 页面，
 * 帧数据经 WebSocket 二进制推送。
 *
 * 与设备层解耦：本模块不订阅事件，只被调用方在事件循环里周期性 `pump()`
 * （模拟器同步执行时会阻塞事件循环，pump 的调用时机即帧率上限）。
 * 判"有没有新帧"用 RESOURCE_FLUSH 的累计计数，取画面用 getFramebuffer 快照。
 *
 * 线协议 —— 二进制帧 = 32 字节头 + **矩形**像素（virtio 32bpp 小端，即字节序 B,G,R,A）：
 *   magic 'TSIE'(4B) | version u32le(=2) | canvasW | canvasH | rectX | rectY | rectW | rectH
 * 像素区 = rectW*rectH*4 字节，逐行紧排（源的行宽是整屏宽，服务端负责抽出来）。
 * 浏览器端把 B/R 互换后 putImageData(img, rectX, rectY) —— 只覆盖那块矩形。
 *
 * 为什么带矩形：早期每帧都发整屏（1024x768x4 = 3MB），一次引导实测推了 **3021 MB**，
 * 而多数变化只是几行文字（1024x19 = 78KB）。矩形来自设备侧 TRANSFER_TO_HOST_2D 的并集。
 * 头里同时带 canvas 尺寸，是为了让浏览器知道画布多大（矩形本身不携带）。
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { GpuFramebuffer, GpuRect } from '../dev/virtio-gpu.ts';

const MAGIC = 0x45495354; // 'TSIE' 按小端 u32 读出
/** 线协议版本（2 = 帧带矩形）。头 32B：magic|ver|canvasW|canvasH|rectX|rectY|rectW|rectH */
const PROTO_VERSION = 2;
const HEADER_SIZE = 32;
/**
 * 单个连接允许的最大待发积压。超过就**跳过本次发送**（丢帧优于把内存堆爆）。
 * 没有这道闸，观众端一慢（网络差、标签页被挂起、断点调试）Node 会把待发帧无上限缓存 ——
 * 每帧最大 3MB，几分钟就能吃掉几个 GB。
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface DisplayServerOptions {
  /** 监听端口，0 = 随机（测试用），实际端口见 address() */
  port: number;
  /** 默认 127.0.0.1；显示内容不出本机，无需对外 */
  host?: string;
  /** 当前画面快照（无画面时返回 undefined） */
  getFramebuffer: () => GpuFramebuffer | undefined;
  /** 累计帧数（RESOURCE_FLUSH 计数），两次 pump 之间变了才有新帧 */
  getFrameCount: () => number;
  /** 广播节流，默认 40ms（约 25fps） */
  minSendIntervalMs?: number;
  /**
   * 自上次推送以来的变化矩形；null 表示画面没变。
   * 不给则退化为"每帧整屏"（与旧行为一致）。
   */
  getDirtyRect?: () => GpuRect | null;
  /** 推完一帧后由本模块调用，让设备重新开始累计脏区 */
  clearDirty?: () => void;
  /**
   * 浏览器按键回传。给了才算双向：页面把 KeyboardEvent.code 发上来，
   * 由调用方映射成 guest 的 input event（见 VirtioInput.sendBrowserKey）。
   * 不给则页面不发键盘（避免做了无用功）。
   */
  onInput?: (ev: { code: string; down: boolean }) => void;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>TSIE display</title>
<style>
  html,body{margin:0;height:100%;background:#111;color:#bbb;
    font:13px/1.6 ui-monospace,Consolas,monospace}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
  canvas{max-width:100vw;max-height:calc(100vh - 2.4em);image-rendering:pixelated;object-fit:contain;
    outline:none} /* tabindex 只为收键，不留焦点框 */
  canvas:focus,canvas:focus-visible{outline:none}
  #status{height:1.6em}
</style>
<div id="status">connecting...</div>
<canvas id="screen" width="16" height="16" tabindex="0"></canvas>
<script>
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
let frames = 0, fpsMark = 0, fpsAt = 0;

function draw(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x45495354 || dv.getUint32(4, true) !== 2) return;
  const cw = dv.getUint32(8, true), ch = dv.getUint32(12, true);
  const rx = dv.getUint32(16, true), ry = dv.getUint32(20, true);
  const rw = dv.getUint32(24, true), rh = dv.getUint32(28, true);
  if (rw === 0 || rh === 0 || 32 + rw * rh * 4 > buf.byteLength) return;
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const src = new Uint32Array(buf, 32, rw * rh);
  const img = ctx.createImageData(rw, rh);
  const dst = new Uint32Array(img.data.buffer);
  // guest 侧是 32bpp（内存字节序 B,G,R,X）；canvas 要 R,G,B,A。
  // 换 B/R、保留 G，并把 alpha 强制不透明 —— X 字节常为 0，原样搬过去整块透明（=全黑）
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    dst[i] = 0xff000000 | (v & 0x0000ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
  }
  ctx.putImageData(img, rx, ry); // 只覆盖变化的那块矩形
  frames++;
  const now = performance.now();
  if (now - fpsAt > 1000) {
    fpsMark = Math.round(frames * 1000 / (now - fpsAt));
    fpsAt = now; frames = 0;
  }
  status.textContent = canvas.width + 'x' + canvas.height + '  fps ' + fpsMark;
}

// 键盘回传：需要 canvas 有焦点（点一下画面即可）。
// 带 Ctrl/Meta 的组合键放行给浏览器（否则 Ctrl+W 之类会被吃掉）
let sendKeys = false;
function focusScreen() { canvas.focus(); }
canvas.addEventListener('mousedown', focusScreen);
canvas.addEventListener('keydown', (e) => { if (e.repeat) return; if (key(e.code, true, e)) e.preventDefault(); });
canvas.addEventListener('keyup',   (e) => { if (key(e.code, false, e)) e.preventDefault(); });
function key(code, down, e) {
  if (!sendKeys || !wsRef || wsRef.readyState !== 1) return false;
  if (e && (e.ctrlKey || e.metaKey || e.altKey)) return false; // 组合键放行给浏览器
  wsRef.send(JSON.stringify({ t: 'key', code: code, down: down }));
  return true;
}
let wsRef = null;

function connect() {
  const ws = new WebSocket('ws://' + location.host + '/');
  wsRef = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => (status.textContent = 'connected');
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      // hello：服务端告知是否支持键盘回传
      try { sendKeys = !!JSON.parse(e.data).input; } catch (_) {}
      return;
    }
    draw(e.data);
  };
  ws.onclose = () => {
    status.textContent = 'disconnected, retrying...';
    setTimeout(connect, 500);
  };
}
connect();
</script>
`;

export class DisplayServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly open = new Set<WebSocket>();
  /** 刚连上、还没发过 hello + 当前帧的客户端 */
  private readonly pending = new Set<WebSocket>();
  private lastCount = -1;
  private lastSentAt = 0;
  /**
   * 上次推送后的画面留底（32 位视角），用来跟新帧做像素 diff。
   *
   * 为什么不能只信设备给的脏矩形：**Linux 的 virtio_gpu 驱动每次更新都传整屏**
   * （实测命令追踪里全是 `TRANSFER_TO_HOST_2D 0,0 1024x768`），只有 EDK2 才会传
   * "一行文字"那种小矩形。而整屏推送实测一次引导要 3021 MB，其中绝大多数像素没变。
   * 所以这里在设备脏区范围内自己比像素，只发真正变化的紧致矩形。
   */
  private prev: Uint32Array | null = null;
  private prevW = 0;
  private prevH = 0;
  /** 已广播帧数 / 因内容没变而跳过的帧数 / 累计推送字节数 / 因观众积压而丢的帧数 */
  private sentFrames = 0;
  private dedupedFrames = 0;
  private sentBytes = 0;
  private droppedBackpressure = 0;
  private readonly minInterval: number;
  /** listen() 是异步的：address()/端口查询前必须先 await 它（含 EADDRINUSE 等错误） */
  readonly ready: Promise<void>;

  constructor(private readonly opts: DisplayServerOptions) {
    this.minInterval = opts.minSendIntervalMs ?? 40;
    this.http = createServer((req, res) => {
      if ((req.url ?? '/') === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else {
        res.writeHead(404).end('not found');
      }
    });
    this.http.listen(opts.port, opts.host ?? '127.0.0.1');
    this.ready = new Promise<void>((resolve, reject) => {
      this.http.once('listening', resolve);
      this.http.once('error', reject);
    });
    this.ready.catch(() => {}); // 不 await 者也不至于是未处理拒绝
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws) => {
      this.open.add(ws);
      this.pending.add(ws);
      ws.on('close', () => {
        this.open.delete(ws);
        this.pending.delete(ws);
        if (this.open.size === 0) this.lastCount = -1; // 观众走空，下一位强制重同步
      });
      // 反向通道：浏览器按键 → 调用方（映射成 guest 的 input event）。
      // 只认 {t:'key', code:string, down:bool}；非法消息静默丢弃。
      ws.on('message', (data: unknown) => {
        const onInput = this.opts.onInput;
        if (!onInput) return;
        try {
          const msg = JSON.parse(String(data)) as { t?: string; code?: unknown; down?: unknown };
          if (msg.t === 'key' && typeof msg.code === 'string' && typeof msg.down === 'boolean') {
            onInput({ code: msg.code, down: msg.down });
          }
        } catch {
          /* 非法 JSON：忽略 */
        }
      });
    });
    // 兜底：机器停机或分块间隙较长时仍能出帧。unref 以免拖住进程退出
    const timer = setInterval(() => this.pump(), 100);
    timer.unref();
  }

  /** 实际监听地址（port=0 时查真实端口用） */
  address(): ReturnType<Server['address']> {
    return this.http.address();
  }

  /** 推一帧：有新 flush 就广播；新客户端先补 hello + 当前帧 */
  pump(force = false): void {
    if (this.open.size === 0) return;
    let fb: GpuFramebuffer | undefined;
    const frame = (): GpuFramebuffer | undefined => (fb ??= this.opts.getFramebuffer());

    if (this.pending.size > 0) {
      const cur = frame();
      const head = JSON.stringify({
        type: 'hello',
        width: cur?.width ?? 0,
        height: cur?.height ?? 0,
        input: this.opts.onInput !== undefined,
      });
      for (const ws of this.pending) {
        if (ws.readyState !== ws.OPEN) {
          this.pending.delete(ws);
          continue;
        }
        ws.send(head);
        // 新客户端没有历史，必须整屏，不能给它增量
        if (cur) {
          const buf = buildFrame(cur, { x: 0, y: 0, w: cur.width, h: cur.height });
          if (ws.readyState === ws.OPEN) {
            if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
              this.droppedBackpressure++; // 新客户端还没追上进度，这帧先不给它
            } else {
              ws.send(buf);
              this.sentBytes += buf.length;
            }
          }
        }
        this.pending.delete(ws);
      }
    }

    const count = this.opts.getFrameCount();
    if (count === this.lastCount) return;
    const now = Date.now();
    if (!force && now - this.lastSentAt < this.minInterval) return;
    const cur = frame();
    if (!cur) return;

    // 设备脏区只是**扫描范围**（它可能远大于真实变化，Linux 干脆给整屏）。
    // 真正发什么由像素 diff 决定：留底与当前帧在脏区内不同的那段紧致矩形。
    // 注意 lastCount 同样要推进 —— 否则下一次 pump 会为同一个 flush 再算一遍。
    const hint = this.opts.getDirtyRect?.() ?? { x: 0, y: 0, w: cur.width, h: cur.height };
    if (!hint || hint.w <= 0 || hint.h <= 0) {
      this.lastCount = count;
      return;
    }
    const curWords = new Uint32Array(cur.data.buffer, cur.data.byteOffset, cur.data.length >>> 2);
    let dr: GpuRect;
    if (this.prev === null || this.prevW !== cur.width || this.prevH !== cur.height) {
      // 首次（或画布尺寸变了）：没有留底可比，必须整屏，并留下底
      dr = { x: 0, y: 0, w: cur.width, h: cur.height };
      this.prev = new Uint32Array(curWords);
      this.prevW = cur.width;
      this.prevH = cur.height;
    } else {
      const tight = diffRect(this.prev, curWords, cur.width, hint);
      if (tight === null) {
        // 画面真的没变（guest 重复 flush）
        this.lastCount = count;
        this.dedupedFrames++;
        this.opts.clearDirty?.();
        return;
      }
      dr = tight;
      copyRect(this.prev, curWords, cur.width, tight); // 只更新推出去那块（其余本来就一致）
    }
    const buf = buildFrame(cur, dr);
    let sent = 0;
    for (const ws of this.open) {
      if (ws.readyState !== ws.OPEN) continue;
      // 背压闸：观众追不上就丢这一帧。它是增量的，下一帧只补新变化 ——
      // 所以丢帧在观众端会表现为"这块暂时没更新"，而不是画面永久错位。
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.droppedBackpressure++;
        continue;
      }
      ws.send(buf);
      sent++;
    }
    this.lastCount = count;
    this.lastSentAt = now;
    this.sentFrames++;
    this.sentBytes += buf.length * sent;
    this.opts.clearDirty?.();
  }

  /** 观测用：已推帧数、因内容未变跳过的帧数、当前观众数 */
  stats(): { sent: number; deduped: number; clients: number; bytes: number; dropped: number } {
    return {
      sent: this.sentFrames,
      deduped: this.dedupedFrames,
      clients: this.open.size,
      bytes: this.sentBytes,
      dropped: this.droppedBackpressure,
    };
  }

  close(): void {
    // terminate 而非优雅 close：浏览器端连接若挂着，会拖住事件循环让进程不退出
    for (const ws of this.open) ws.terminate();
    this.wss.close();
    this.http.close();
  }
}

/**
 * 在 hint 指定的范围内，找出 cur 相对 prev 的变化包围盒；完全没变返回 null。
 * 逐行扫 32 位字：先定位该行首个/末个不同的字，再汇总成全屏坐标的包围盒。
 * 控制台输出通常只动连续几行，所以这个包围盒很紧（一行文字 ≈ 1024x19）。
 */
function diffRect(prev: Uint32Array, cur: Uint32Array, width: number, hint: GpuRect): GpuRect | null {
  const xEnd = Math.min(width, hint.x + hint.w);
  let x0 = xEnd;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let y = hint.y; y < hint.y + hint.h; y++) {
    const base = y * width;
    let lo = -1;
    let hi = -1;
    for (let x = hint.x; x < xEnd; x++) {
      if (cur[base + x] !== prev[base + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) {
      if (y0 < 0) y0 = y;
      y1 = y;
      if (lo < x0) x0 = lo;
      if (hi > x1) x1 = hi;
    }
  }
  if (y0 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 把 cur 的 r 区域抄进 prev（只抄推出去那块，其余部分两边本来就一致） */
function copyRect(prev: Uint32Array, cur: Uint32Array, width: number, r: GpuRect): void {
  const rowLen = r.w;
  for (let y = 0; y < r.h; y++) {
    const base = (r.y + y) * width + r.x;
    prev.set(cur.subarray(base, base + rowLen), base);
  }
}

/**
 * 组一帧：32B 头 + 矩形像素。逐行从整屏里抽（源行宽是整屏宽），一次分配、无中间拷贝。
 * 组完即与设备缓冲脱钩 —— 发送排队期间 guest 会继续改写 res.host，不能引用它。
 */
function buildFrame(fb: GpuFramebuffer, r: GpuRect): Buffer {
  const rowBytes = r.w * 4;
  const out = Buffer.allocUnsafe(HEADER_SIZE + rowBytes * r.h);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(PROTO_VERSION, 4);
  out.writeUInt32LE(fb.width, 8);
  out.writeUInt32LE(fb.height, 12);
  out.writeUInt32LE(r.x, 16);
  out.writeUInt32LE(r.y, 20);
  out.writeUInt32LE(r.w, 24);
  out.writeUInt32LE(r.h, 28);
  const stride = fb.width * 4;
  for (let row = 0; row < r.h; row++) {
    const src = (r.y + row) * stride + r.x * 4;
    Buffer.from(fb.data.buffer, fb.data.byteOffset + src, rowBytes).copy(
      out,
      HEADER_SIZE + row * rowBytes,
    );
  }
  return out;
}
