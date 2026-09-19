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
 * 线协议 —— 二进制帧 = 16 字节头 + 原始像素（virtio 32bpp 小端，即字节序 B,G,R,A）：
 *   magic 'TSIE'(4B) | width u32le | height u32le | pixelBytes u32le
 * 浏览器端把 B/R 互换后写进 ImageData。
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { GpuFramebuffer } from '../dev/virtio-gpu.ts';

const MAGIC = 0x45495354; // 'TSIE' 按小端 u32 读出

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
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), len = dv.getUint32(12, true);
  if (dv.getUint32(0, true) !== 0x45495354 || len + 16 > buf.byteLength) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const src = new Uint32Array(buf, 16, w * h);
  const img = ctx.createImageData(w, h);
  const dst = new Uint32Array(img.data.buffer);
  // guest 侧是 32bpp（内存字节序 B,G,R,X）；canvas 要 R,G,B,A。
  // 换 B/R、保留 G，并把 alpha 强制不透明 —— X 字节常为 0，原样搬过去整屏透明（=全黑）
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    dst[i] = 0xff000000 | (v & 0x0000ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
  }
  ctx.putImageData(img, 0, 0);
  frames++;
  const now = performance.now();
  if (now - fpsAt > 1000) {
    fpsMark = Math.round(frames * 1000 / (now - fpsAt));
    fpsAt = now; frames = 0;
  }
  status.textContent = w + 'x' + h + '  fps ' + fpsMark;
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
   * 上一帧内容的哈希：**guest 会重复 flush 相同画面**（实测某次引导里 311 次 flush
   * 有 206 次与上一帧逐字节相同，即约 2/3 的推送是白费），光标闪烁、fbcon 重绘都会这样。
   * 所以除了"有新 flush"这一层，再加一层"内容真的变了"。
   */
  private lastHash = 0;
  /** 已广播帧数 / 因内容相同而跳过的帧数（供 stats() 观测去重效果） */
  private sentFrames = 0;
  private dedupedFrames = 0;
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
        if (cur) sendFrame(ws, cur);
        this.pending.delete(ws);
      }
    }

    const count = this.opts.getFrameCount();
    if (count === this.lastCount) return;
    const now = Date.now();
    if (!force && now - this.lastSentAt < this.minInterval) return;
    const cur = frame();
    if (!cur) return;

    // 内容判重：与上一帧逐字节相同就只记账、不推。
    // 注意 lastCount 同样要推进 —— 否则下一次 pump 会为同一个 flush 再算一遍哈希。
    const h = hashFramebuffer(cur.data);
    if (h === this.lastHash) {
      this.lastCount = count;
      this.dedupedFrames++;
      return;
    }
    for (const ws of this.open) {
      if (ws.readyState === ws.OPEN) sendFrame(ws, cur);
    }
    this.lastCount = count;
    this.lastHash = h;
    this.lastSentAt = now;
    this.sentFrames++;
  }

  /** 观测用：已推帧数、因内容未变跳过的帧数、当前观众数 */
  stats(): { sent: number; deduped: number; clients: number } {
    return { sent: this.sentFrames, deduped: this.dedupedFrames, clients: this.open.size };
  }

  close(): void {
    // terminate 而非优雅 close：浏览器端连接若挂着，会拖住事件循环让进程不退出
    for (const ws of this.open) ws.terminate();
    this.wss.close();
    this.http.close();
  }
}

/**
 * 帧缓冲的 32 位 FNV-1a。只用来判断"内容变了没有"，不追求密码学强度。
 * 按 32 位字走（末尾不足 4 字节补按字节），比逐字节快数倍。
 */
function hashFramebuffer(data: Uint8Array): number {
  const words = data.length >>> 2;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < words; i++) {
    h = (h ^ dv.getUint32(i << 2, true)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = words << 2; i < data.length; i++) {
    h = (h ^ data[i]!) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function sendFrame(ws: WebSocket, fb: GpuFramebuffer): void {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(fb.width, 4);
  header.writeUInt32LE(fb.height, 8);
  header.writeUInt32LE(fb.data.length, 12);
  // 拷贝一份：res.host 是设备内部缓冲，发送排队期间 guest 可能继续改写
  ws.send(Buffer.concat([header, Buffer.from(fb.data)]));
}
