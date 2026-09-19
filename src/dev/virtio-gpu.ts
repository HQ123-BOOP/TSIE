/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';
import type { ChainDesc, VQueue, VirtioQueueOps } from './virtio.ts';
import { VirtioMmio, VIRTIO_F_VERSION_1 } from './virtio-mmio.ts';
import { VirtioPci } from './pci/virtio-pci.ts';

// --- 控制队列命令（virtio spec §5.7.6）---
const CMD_GET_DISPLAY_INFO = 0x0100;
const CMD_RESOURCE_CREATE_2D = 0x0101;
const CMD_RESOURCE_UNREF = 0x0102;
const CMD_SET_SCANOUT = 0x0103;
const CMD_RESOURCE_FLUSH = 0x0104;
const CMD_TRANSFER_TO_HOST_2D = 0x0105;
const CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const CMD_RESOURCE_DETACH_BACKING = 0x0107;
const CMD_GET_EDID = 0x0108;

// --- 光标队列命令 ---
const CMD_UPDATE_CURSOR = 0x0300;
const CMD_MOVE_CURSOR = 0x0301;

// --- 响应码 ---
const RESP_OK_NODATA = 0x1100;
const RESP_OK_DISPLAY_INFO = 0x1101;
const RESP_ERR_UNSPEC = 0x1200;
const RESP_ERR_INVALID_SCANOUT_ID = 0x1202;
const RESP_ERR_INVALID_RESOURCE_ID = 0x1203;
const RESP_ERR_INVALID_PARAMETER = 0x1205;

/** 响应里必须回显请求的 fence 位，否则 Linux 的 fence 等待者不会完成 */
const FLAG_FENCE = 1;

const HDR_SIZE = 24;
const MAX_SCANOUTS = 16;
const DISPLAY_ONE_SIZE = 24;
const RESP_DISPLAY_INFO_SIZE = HDR_SIZE + MAX_SCANOUTS * DISPLAY_ONE_SIZE;

/** 设备 config 空间大小（num_scanouts / num_capsets 在此） */
const CONFIG_SIZE = 16;

const QUEUE_SIZE = 256;

/** 32bpp 格式（本实现只支持 4 字节/像素，足以覆盖 Linux fbdev 的所有模式） */
const FORMATS_32BPP = new Set([1, 2, 3, 4, 67, 68, 121, 134]);
const BPP = 4;

const MAX_DIM = 8192;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_BACKING_ENTRIES = 1024;

/** 命令名（仅调试追踪用） */
const CMD_NAMES: Record<number, string> = {
  [CMD_GET_DISPLAY_INFO]: 'GET_DISPLAY_INFO',
  [CMD_RESOURCE_CREATE_2D]: 'RESOURCE_CREATE_2D',
  [CMD_RESOURCE_UNREF]: 'RESOURCE_UNREF',
  [CMD_SET_SCANOUT]: 'SET_SCANOUT',
  [CMD_RESOURCE_FLUSH]: 'RESOURCE_FLUSH',
  [CMD_TRANSFER_TO_HOST_2D]: 'TRANSFER_TO_HOST_2D',
  [CMD_RESOURCE_ATTACH_BACKING]: 'ATTACH_BACKING',
  [CMD_RESOURCE_DETACH_BACKING]: 'DETACH_BACKING',
  [CMD_GET_EDID]: 'GET_EDID',
  [CMD_UPDATE_CURSOR]: 'UPDATE_CURSOR',
  [CMD_MOVE_CURSOR]: 'MOVE_CURSOR',
};

export interface VirtioGpuOptions {
  /** 上报给 guest 的扫描输出分辨率，默认 1024x768 */
  width?: number;
  height?: number;
  /** 扫描输出数量，默认 1 */
  scanouts?: number;
  /** 每次 RESOURCE_FLUSH 后触发（前端据此重绘画面） */
  onFlush?: (fb: GpuFramebuffer) => void;
}

/** 当前上屏画面的快照视图（data 是设备内部缓冲，前端只读，勿改） */
export interface GpuFramebuffer {
  width: number;
  height: number;
  /** VIRTIO_GPU_FORMAT_* */
  format: number;
  /** 32bpp 行主序像素（小端） */
  data: Uint8Array;
}

/** 像素矩形（前端做增量推送用） */
export interface GpuRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GpuResource {
  id: number;
  format: number;
  width: number;
  height: number;
  /** 像素数据在 guest 物理内存中的散射表 */
  backing: { addr: bigint; length: number }[];
  /** Host 侧副本（width * height * 4） */
  host: Uint8Array;
}

interface Scanout {
  enabled: boolean;
  resourceId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GpuStats = {
  commands: number;
  flushes: number;
  resources: number;
};

/**
 * virtio-gpu 的**设备逻辑**，与传输无关。
 *
 * 只实现 2D 命令子集 —— 目标是让 guest 侧 virtio_gpu (DRM/KMS) / UEFI 的
 * VirtioGpuDxe 拿到一个可用的 connector/CRTC：在 DRM_FBDEV_EMULATION 下产出
 * /dev/fb0，再由 FRAMEBUFFER_CONSOLE 把文本控制台上屏。3D（VIRGL / blob
 * resource / capset）一律不宣告，驱动不会来问。
 *
 * 与块设备的本质差别：**像素不进 virtqueue**。guest 用 RESOURCE_ATTACH_BACKING 把
 * 像素 buffer 的物理地址（散射表）交给设备，TRANSFER_TO_HOST_2D 时设备按 GPA
 * 直接读 guest RAM，队列里只走几十字节的命令结构体。因此画面前端拿到的是
 * host 侧副本的快照。
 *
 * 传输侧（VirtioMmio / VirtioPci）只把寄存器访问映射到这个 core 上，
 * 通过 VirtioQueueOps 提供描述符链遍历与 used 环回写。
 */
export class VirtioGpuCore {
  /** 设备 config 空间长度（PCI 传输要写进 device cfg 能力结构） */
  static readonly CONFIG_SIZE = CONFIG_SIZE;

  private readonly resources = new Map<number, GpuResource>();
  private readonly scanouts: Scanout[] = [];

  private readonly width: number;
  private readonly height: number;
  private readonly numScanouts: number;
  private readonly onFlush?: (fb: GpuFramebuffer) => void;

  private cmdCount = 0;
  private flushCount = 0;

  /**
   * 自前端上次取走以来，**画面变化区域的并集**（bounding box）。
   *
   * 为什么要有它：一次 1024x768 引导实测往浏览器推了 3021 MB —— 因为每帧都搬整屏，
   * 而多数变化只是几行文字（1024x19 才 78KB）。驱动每次更新都会发 TRANSFER_TO_HOST_2D
   * 并带矩形，所以设备侧本来就知道变了哪里，把它累计起来给前端即可。
   *
   * dirtyAll：扫描输出被重新绑定（或第一次上屏）时必须整屏重发 —— 此前的增量对不上。
   */
  private dirty: GpuRect | null = null;
  private dirtyAll = true;

  /** 调试：记录控制队列命令（设备侧协议追踪，最多 200 条）。与传输层的 MMIO trace 相互独立 */
  cmdTrace = false;
  readonly cmdTraceLog: string[] = [];

  constructor(
    private readonly bus: Bus,
    opts: VirtioGpuOptions = {},
  ) {
    this.width = opts.width ?? 1024;
    this.height = opts.height ?? 768;
    this.numScanouts = opts.scanouts ?? 1;
    this.onFlush = opts.onFlush;
    for (let i = 0; i < this.numScanouts; i++) {
      this.scanouts.push({ enabled: false, resourceId: 0, x: 0, y: 0, width: 0, height: 0 });
    }
  }

  private traceLine(s: string): void {
    if (!this.cmdTrace || this.cmdTraceLog.length >= 200) return;
    this.cmdTraceLog.push(s);
  }

  /** 设备 config 空间读（offset 相对配置区起点） */
  readConfig(o: number, size: MemSize): bigint {
    const cfg = new Uint8Array(CONFIG_SIZE);
    const dv = new DataView(cfg.buffer);
    dv.setUint32(0x00, 0, true); // events_read（无事件）
    dv.setUint32(0x04, 0, true); // events_clear
    dv.setUint32(0x08, this.numScanouts, true); // num_scanouts（为 0 驱动会直接报错退出）
    dv.setUint32(0x0c, 0, true); // num_capsets（无 3D）
    let v = 0n;
    for (let i = 0; i < size; i++) {
      const off = o + i;
      if (off >= cfg.length) break;
      v |= BigInt(cfg[off]) << BigInt(8 * i);
    }
    return v;
  }

  /** 当前上屏画面；未绑定扫描输出时返回 undefined */
  getFramebuffer(): GpuFramebuffer | undefined {
    const s = this.scanouts[0];
    if (!s || !s.enabled) return undefined;
    const res = this.resources.get(s.resourceId);
    if (!res) return undefined;
    return { width: res.width, height: res.height, format: res.format, data: res.host };
  }

  /** 把一次传输的矩形并入脏区（只关心当前上屏的那个资源） */
  private markDirty(resourceId: number, r: { x: number; y: number; width: number; height: number }): void {
    const s = this.scanouts[0];
    if (!s || !s.enabled || s.resourceId !== resourceId) return; // 非上屏资源：不影响画面
    if (this.dirtyAll) return; // 已经要整屏了，不必再算
    const x0 = Math.max(0, Math.min(this.dirty ? this.dirty.x : r.x, r.x));
    const y0 = Math.max(0, Math.min(this.dirty ? this.dirty.y : r.y, r.y));
    const x1 = Math.max(this.dirty ? this.dirty.x + this.dirty.w : r.x + r.width, r.x + r.width);
    const y1 = Math.max(this.dirty ? this.dirty.y + this.dirty.h : r.y + r.height, r.y + r.height);
    this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * 前端取用：自上次 clearDirty() 以来的变化矩形。
   * 返回整屏尺寸的矩形表示"必须整屏重发"；返回 null 表示没有变化。
   */
  dirtyRect(): GpuRect | null {
    const fb = this.getFramebuffer();
    if (!fb) return null;
    if (this.dirtyAll) return { x: 0, y: 0, w: fb.width, h: fb.height };
    return this.dirty;
  }

  /** 前端推完这一帧后调用，重新开始累计 */
  clearDirty(): void {
    this.dirty = null;
    this.dirtyAll = false;
  }

  stats(): GpuStats {
    return { commands: this.cmdCount, flushes: this.flushCount, resources: this.resources.size };
  }

  /** 已上屏帧数（前端/测试用） */
  get flushes(): number {
    return this.flushCount;
  }

  // ------------------------------------------------------------------
  // 描述符链读写
  // ------------------------------------------------------------------

  /** 把链上某一侧的缓冲拼成一个连续块（out = 设备只读，in = 设备可写） */
  private readChain(chain: ChainDesc[], writable: boolean): Uint8Array {
    let total = 0;
    for (const c of chain) if (c.write === writable) total += c.len;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chain) {
      if (c.write !== writable) continue;
      out.set(this.bus.readBytes(c.addr, c.len), off);
      off += c.len;
    }
    return out;
  }

  /** 把响应铺进可写描述符，返回实际写出的字节数（即 used.len） */
  private writeChain(chain: ChainDesc[], bytes: Uint8Array): number {
    let off = 0;
    for (const c of chain) {
      if (!c.write) continue;
      const n = Math.min(c.len, bytes.length - off);
      if (n <= 0) break;
      this.bus.writeBytes(c.addr, bytes.subarray(off, off + n));
      off += n;
    }
    return off;
  }

  /** 从资源的散射表里按逻辑偏移取一段连续字节 */
  private readBacking(res: GpuResource, offset: number, dst: Uint8Array, dstOff: number, len: number): void {
    let logical = 0;
    for (const b of res.backing) {
      const end = logical + b.length;
      if (offset + len <= logical) return;
      if (offset >= end) {
        logical = end;
        continue;
      }
      const from = Math.max(offset, logical);
      const to = Math.min(offset + len, end);
      if (to > from) {
        const guestAddr = b.addr + BigInt(from - logical);
        dst.set(this.bus.readBytes(guestAddr, to - from), dstOff + (from - offset));
      }
      logical = end;
      if (logical >= offset + len) return;
    }
  }

  // ------------------------------------------------------------------
  // 请求处理
  // ------------------------------------------------------------------

  /** 处理控制队列/光标队列上的一个请求；io 由传输层提供 */
  handleRequest(io: VirtioQueueOps, q: VQueue, headId: number): void {
    this.cmdCount++;
    const chain = io.collectChain(q, headId);
    if (chain.length === 0) {
      io.pushUsed(q, headId, 0);
      return;
    }

    let req: Uint8Array;
    try {
      req = this.readChain(chain, false);
    } catch {
      io.pushUsed(q, headId, 0);
      return;
    }
    if (req.length < HDR_SIZE) {
      io.pushUsed(q, headId, 0);
      return;
    }

    const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
    const type = dv.getUint32(0, true);
    const flags = dv.getUint32(4, true);
    const fenceId = dv.getBigUint64(8, true);
    const ctxId = dv.getUint32(16, true);

    const resp = new Uint8Array(RESP_DISPLAY_INFO_SIZE);
    const rv = new DataView(resp.buffer);
    let respLen = HDR_SIZE;
    let respType = RESP_OK_NODATA;
    /** 供 trace 使用的命令关键参数 */
    let detail = '';

    const need = (n: number): boolean => req.length >= n;
    const rectAt = (o: number) => ({
      x: dv.getUint32(o, true),
      y: dv.getUint32(o + 4, true),
      width: dv.getUint32(o + 8, true),
      height: dv.getUint32(o + 12, true),
    });

    switch (type) {
      case CMD_GET_DISPLAY_INFO: {
        respType = RESP_OK_DISPLAY_INFO;
        for (let i = 0; i < MAX_SCANOUTS; i++) {
          const b = HDR_SIZE + i * DISPLAY_ONE_SIZE;
          const on = i < this.numScanouts;
          rv.setUint32(b + 0, 0, true);
          rv.setUint32(b + 4, 0, true);
          rv.setUint32(b + 8, on ? this.width : 0, true);
          rv.setUint32(b + 12, on ? this.height : 0, true);
          rv.setUint32(b + 16, on ? 1 : 0, true);
          rv.setUint32(b + 20, 0, true);
        }
        respLen = RESP_DISPLAY_INFO_SIZE;
        break;
      }

      case CMD_RESOURCE_CREATE_2D: {
        if (!need(HDR_SIZE + 16)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const id = dv.getUint32(24, true);
        const format = dv.getUint32(28, true);
        const w = dv.getUint32(32, true);
        const h = dv.getUint32(36, true);
        if (!FORMATS_32BPP.has(format) || w === 0 || h === 0 || w > MAX_DIM || h > MAX_DIM) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        if (w * h * BPP > MAX_RESOURCE_BYTES) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        detail = `id=${id} fmt=${format} ${w}x${h}`;
        this.resources.set(id, {
          id,
          format,
          width: w,
          height: h,
          backing: [],
          host: new Uint8Array(w * h * BPP),
        });
        break;
      }

      case CMD_RESOURCE_ATTACH_BACKING: {
        if (!need(HDR_SIZE + 8)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const id = dv.getUint32(24, true);
        const nr = dv.getUint32(28, true);
        const res = this.resources.get(id);
        if (!res) {
          respType = RESP_ERR_INVALID_RESOURCE_ID;
          break;
        }
        if (nr === 0 || nr > MAX_BACKING_ENTRIES || !need(HDR_SIZE + 8 + nr * 16)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const entries: { addr: bigint; length: number }[] = [];
        for (let i = 0; i < nr; i++) {
          const b = HDR_SIZE + 8 + i * 16;
          entries.push({ addr: dv.getBigUint64(b, true), length: dv.getUint32(b + 8, true) });
        }
        res.backing = entries;
        detail = `id=${id} nr=${nr} e0=${entries[0].addr}/${entries[0].length}`;
        break;
      }

      case CMD_RESOURCE_DETACH_BACKING: {
        if (!need(HDR_SIZE + 8)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const res = this.resources.get(dv.getUint32(24, true));
        if (!res) {
          respType = RESP_ERR_INVALID_RESOURCE_ID;
          break;
        }
        res.backing = [];
        detail = `id=${res.id}`;
        break;
      }

      case CMD_SET_SCANOUT: {
        if (!need(HDR_SIZE + 24)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const r = rectAt(HDR_SIZE);
        const scanoutId = dv.getUint32(HDR_SIZE + 16, true);
        const resourceId = dv.getUint32(HDR_SIZE + 20, true);
        if (scanoutId >= this.numScanouts) {
          respType = RESP_ERR_INVALID_SCANOUT_ID;
          break;
        }
        const target = this.scanouts[scanoutId];
        if (resourceId === 0) {
          target.enabled = false;
          target.resourceId = 0;
          break;
        }
        if (!this.resources.has(resourceId)) {
          respType = RESP_ERR_INVALID_RESOURCE_ID;
          break;
        }
        target.enabled = true;
        target.resourceId = resourceId;
        target.x = r.x;
        target.y = r.y;
        target.width = r.width;
        target.height = r.height;
        this.dirtyAll = true; // 换了上屏资源：增量对不上，下次整屏发
        detail = `scr=${scanoutId} res=${resourceId} ${r.x},${r.y} ${r.width}x${r.height}`;
        break;
      }

      case CMD_TRANSFER_TO_HOST_2D: {
        if (!need(HDR_SIZE + 32)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const r = rectAt(HDR_SIZE);
        const offset = Number(dv.getBigUint64(HDR_SIZE + 16, true));
        const res = this.resources.get(dv.getUint32(HDR_SIZE + 24, true));
        if (!res) {
          respType = RESP_ERR_INVALID_RESOURCE_ID;
          break;
        }
        if (res.backing.length === 0) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const stride = res.width * BPP;
        const rowBytes = Math.min(r.width, res.width) * BPP;
        const rows = Math.min(r.height, res.height);
        let ok = true;
        for (let row = 0; row < rows; row++) {
          const dstOff = (r.y + row) * stride + r.x * BPP;
          if (dstOff < 0 || dstOff + rowBytes > res.host.length) {
            ok = false;
            break;
          }
          // offset 已经指向矩形原点 —— EDK2 的 GopBlt() 传的就是
          // `sizeof(UINT32) * (DestinationY * CurrentHorizontal + DestinationX)`。
          // 所以源地址只需再按行推进一个 stride；早先这里又多加了一次
          // `(r.y + row) * stride + r.x * BPP`，整块像素会从错位若干行的位置读出：
          // 表现是画面上只有第一行文字（还在边缘上，裁掉顶边仍能认出）、
          // 而居中的 logo 那块被读来的空白覆盖，永远不出现。
          this.readBacking(res, offset + row * stride, res.host, dstOff, rowBytes);
        }
        if (!ok) {
          respType = RESP_ERR_INVALID_PARAMETER;
        } else {
          this.markDirty(res.id, r);
        }
        detail = `res=${res.id} off=${offset} ${r.x},${r.y} ${r.width}x${r.height} resSz=${res.width}x${res.height}`;
        break;
      }

      case CMD_RESOURCE_FLUSH: {
        if (!need(HDR_SIZE + 24)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const res = this.resources.get(dv.getUint32(HDR_SIZE + 16, true));
        if (!res) {
          respType = RESP_ERR_INVALID_RESOURCE_ID;
          break;
        }
        this.flushCount++;
        {
          const fr = rectAt(HDR_SIZE);
          detail = `res=${res.id} ${fr.x},${fr.y} ${fr.width}x${fr.height}`;
        }
        const fb = this.getFramebuffer();
        if (fb && this.onFlush) this.onFlush(fb);
        break;
      }

      case CMD_RESOURCE_UNREF: {
        if (!need(HDR_SIZE + 8)) {
          respType = RESP_ERR_INVALID_PARAMETER;
          break;
        }
        const id = dv.getUint32(24, true);
        if (!this.resources.delete(id)) {
          respType = RESP_ERR_INVALID_RESOURCE_ID;
          break;
        }
        detail = `id=${id}`;
        for (const s of this.scanouts) {
          if (s.resourceId === id) {
            s.enabled = false;
            s.resourceId = 0;
          }
        }
        break;
      }

      case CMD_UPDATE_CURSOR:
      case CMD_MOVE_CURSOR:
        // 光标不绘制，只应答：驱动发的是 fire-and-forget，不该卡在这里
        break;

      case CMD_GET_EDID:
        // 未宣告 VIRTIO_GPU_F_EDID，正常不会走到这里
        respType = RESP_ERR_UNSPEC;
        break;

      default:
        respType = RESP_ERR_UNSPEC;
        break;
    }

    this.traceLine(
      (CMD_NAMES[type] ?? 'cmd=0x' + type.toString(16)) +
        (detail ? ' ' + detail : '') +
        (respType === RESP_OK_NODATA ? '' : ' -> resp=0x' + respType.toString(16)),
    );
    rv.setUint32(0, respType, true);
    rv.setUint32(4, flags & FLAG_FENCE, true);
    rv.setBigUint64(8, fenceId, true);
    rv.setUint32(16, ctxId, true);
    rv.setUint32(20, 0, true);

    const written = this.writeChain(chain, resp.subarray(0, respLen));
    io.pushUsed(q, headId, written);
  }
}

/**
 * virtio-gpu 在 **virtio-mmio** 传输上的形态（当前默认）。
 * 队列：0 = controlq，1 = cursorq（Linux virtio_gpu 固定申请 2 个，少一个 probe 就失败）。
 */
export class VirtioGpu extends VirtioMmio {
  readonly name = 'virtio-gpu';
  readonly core: VirtioGpuCore;

  constructor(bus: Bus, irq: IrqLine | undefined, opts: VirtioGpuOptions = {}) {
    super(bus, irq, 2, QUEUE_SIZE);
    this.core = new VirtioGpuCore(bus, opts);
  }

  protected deviceId(): number {
    return 16; // VIRTIO_ID_GPU
  }

  protected hostFeatures(): bigint {
    // 只宣告 VERSION_1：不给 VIRGL/EDID/RESOURCE_BLOB/CONTEXT_INIT，
    // 驱动便不会走 3D/EDID/blob 那些我们没实现的路径。
    return VIRTIO_F_VERSION_1;
  }

  protected queueSizeMax(): number {
    return QUEUE_SIZE;
  }

  protected override configSize(): number {
    return VirtioGpuCore.CONFIG_SIZE;
  }

  protected readConfig(o: number, size: MemSize): bigint {
    return this.core.readConfig(o, size);
  }

  protected handleRequest(q: VQueue, headId: number): void {
    this.core.handleRequest(this, q, headId);
  }

  getFramebuffer(): GpuFramebuffer | undefined {
    return this.core.getFramebuffer();
  }

  /** 变化矩形（自上次 clearDirty 起）；见 VirtioGpuCore.dirtyRect */
  dirtyRect(): GpuRect | null {
    return this.core.dirtyRect();
  }

  clearDirty(): void {
    this.core.clearDirty();
  }

  override stats(): { commands: number; flushes: number; resources: number; notifications: number } {
    return { ...this.core.stats(), notifications: this.notifyStats };
  }

  /** 兼容既有引用：命令追踪开关与日志都在 core 上 */
  get cmdTrace(): boolean {
    return this.core.cmdTrace;
  }
  set cmdTrace(v: boolean) {
    this.core.cmdTrace = v;
  }
  get cmdTraceLog(): string[] {
    return this.core.cmdTraceLog;
  }
}

/**
 * virtio-gpu 在 **virtio-pci** 传输上的形态。
 *
 * PCI 类码取 0x038000（Display / Other）—— UEFI 的 `IsPciDisplay` 只看基类
 * 0x03，所以它会被 `PlatformBootManagerBeforeConsole()` 主动 connect，
 * GOP 因此在 `AddOutput()` 之前就存在，启动 logo 不需要任何平台补丁。
 */
export class VirtioGpuPci extends VirtioPci {
  readonly core: VirtioGpuCore;

  constructor(bus: Bus, irq: IrqLine | undefined, dev = 0, fn = 0, opts: VirtioGpuOptions = {}) {
    super(bus, irq, 2, QUEUE_SIZE, dev, fn);
    this.core = new VirtioGpuCore(bus, opts);
  }

  protected deviceId(): number {
    return 16; // VIRTIO_ID_GPU
  }

  protected pciClassCode(): number {
    return 0x038000; // Display / Other
  }

  protected hostFeatures(): bigint {
    return VIRTIO_F_VERSION_1;
  }

  protected queueSizeMax(): number {
    return QUEUE_SIZE;
  }

  protected override configSize(): number {
    return VirtioGpuCore.CONFIG_SIZE;
  }

  protected readConfig(o: number, size: MemSize): bigint {
    return this.core.readConfig(o, size);
  }

  protected handleRequest(q: VQueue, headId: number): void {
    this.core.handleRequest(this, q, headId);
  }

  getFramebuffer(): GpuFramebuffer | undefined {
    return this.core.getFramebuffer();
  }

  /** 变化矩形（自上次 clearDirty 起）；见 VirtioGpuCore.dirtyRect */
  dirtyRect(): GpuRect | null {
    return this.core.dirtyRect();
  }

  clearDirty(): void {
    this.core.clearDirty();
  }

  override stats(): { commands: number; flushes: number; resources: number; notifications: number } {
    return { ...this.core.stats(), notifications: this.notifyStats };
  }

  get cmdTrace(): boolean {
    return this.core.cmdTrace;
  }
  set cmdTrace(v: boolean) {
    this.core.cmdTrace = v;
  }
  get cmdTraceLog(): string[] {
    return this.core.cmdTraceLog;
  }
}
