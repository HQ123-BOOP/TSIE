/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { Device, MemSize } from '../mem/types.ts';
import type { DiskImage } from './disk.ts';
import { SECTOR_SIZE } from './disk.ts';
import type { IrqLine } from './uart.ts';

// --- VirtIO-MMIO 寄存器偏移（virtio-v1.x spec §4.2.2，与 U-Boot v2025.01
//     drivers/virtio/virtio_mmio.h 逐一核对）---
const R_MAGIC = 0x00;
const R_VERSION = 0x04;
const R_DEVICE_ID = 0x08;
const R_VENDOR_ID = 0x0c;
const R_DEVICE_FEATURES = 0x10;
const R_DEVICE_FEATURES_SEL = 0x14;
const R_DRIVER_FEATURES = 0x20;
const R_DRIVER_FEATURES_SEL = 0x24;
const R_GUEST_PAGE_SIZE = 0x28; // 仅 legacy 使用，modern 忽略
const R_QUEUE_SEL = 0x30;
const R_QUEUE_NUM_MAX = 0x34;
const R_QUEUE_NUM = 0x38;
const R_QUEUE_READY = 0x44;
const R_QUEUE_NOTIFY = 0x50;
const R_INTERRUPT_STATUS = 0x60;
const R_INTERRUPT_ACK = 0x64;
const R_STATUS = 0x70;
const R_QUEUE_DESC_LOW = 0x80;
const R_QUEUE_DESC_HIGH = 0x84;
const R_QUEUE_AVAIL_LOW = 0x90;
const R_QUEUE_AVAIL_HIGH = 0x94;
const R_QUEUE_USED_LOW = 0xa0;
const R_QUEUE_USED_HIGH = 0xa4;
const R_CONFIG_GENERATION = 0xfc;
const R_CONFIG = 0x100;

// --- 特性位 ---
const VIRTIO_F_VERSION_1 = 1n << 32n; // 现代设备必选位（缺少则 U-Boot 判为 legacy）
const F_SIZE_MAX = 1n << 1n;
const F_SEG_MAX = 1n << 2n;
const F_GEOMETRY = 1n << 4n;
const F_BLK_SIZE = 1n << 6n;
const F_FLUSH = 1n << 9n;
const F_TOPOLOGY = 1n << 10n;
const F_CONFIG_WCE = 1n << 11n;

// 暴露给驱动的 64 位特性集。不暴露 RING_EVENT_IDX（避免 avail/used 环布局变化）。
const FEATURES_HOST =
  VIRTIO_F_VERSION_1 |
  F_SIZE_MAX |
  F_SEG_MAX |
  F_GEOMETRY |
  F_BLK_SIZE |
  F_FLUSH |
  F_TOPOLOGY |
  F_CONFIG_WCE;

// --- 块设备请求类型 ---
const BLK_T_IN = 0;
const BLK_T_OUT = 1;
const BLK_T_FLUSH = 4;
const BLK_T_GET_ID = 8;
const BLK_T_WRITE_ZEROES = 13;

const BLK_S_OK = 0;
const BLK_S_IOERR = 1;
const BLK_S_UNSUPP = 2;

// --- virtqueue 标志 ---
const VRING_DESC_F_NEXT = 1;
const VRING_DESC_F_WRITE = 2;
const VRING_DESC_F_INDIRECT = 4;
const VRING_AVAIL_F_NO_INTERRUPT = 1;

const QUEUE_SIZE = 256;

interface VQueue {
  ready: boolean;
  num: number;
  desc: bigint;
  driver: bigint; // avail 环
  device: bigint; // used 环
  lastAvail: number;
}

/**
 * VirtIO-MMIO 块设备（virtio-v1.x，寄存器布局与 U-Boot virtio_mmio.h 一致）。
 * 可挂载 raw 磁盘镜像作为 U-Boot/Linux 的根文件系统。
 */
export class VirtioBlk implements Device {
  readonly name = 'virtio-blk';
  readonly size = 0x200n;

  private bus: Bus;
  private disk: DiskImage;
  private irq: IrqLine | undefined;

  private status = 0;
  private hostFeaturesSel = 0;
  private guestFeatures = 0n;
  private guestFeaturesSel = 0;
  private queueSel = 0;
  private interruptStatus = 0;
  private queues: VQueue[] = [];
  private notifyStats = 0;
  private reqCount = 0;

  /** 调试：记录 MMIO 寄存器访问（供固件 probe 追踪） */
  trace = false;
  readonly traceLog: string[] = [];

  constructor(bus: Bus, disk: DiskImage, irq?: IrqLine) {
    this.bus = bus;
    this.disk = disk;
    this.irq = irq;
    for (let i = 0; i < 1; i++) {
      this.queues.push({ ready: false, num: QUEUE_SIZE, desc: 0n, driver: 0n, device: 0n, lastAvail: 0 });
    }
  }

  private curQueue(): VQueue {
    return this.queues[this.queueSel] ?? this.queues[0];
  }

  private traceOp(o: number, isWrite: boolean, value?: bigint): void {
    if (!this.trace || this.traceLog.length >= 3000) return;
    this.traceLog.push(
      `${isWrite ? 'W' : 'R'} ${'0x' + o.toString(16).padStart(2, '0')}${isWrite ? ' = 0x' + (value ?? 0n).toString(16) : ''}`,
    );
  }

  // ------------------------------------------------------------------
  // MMIO 寄存器
  // ------------------------------------------------------------------

  read(offset: bigint, size: MemSize): bigint {
    const o = Number(offset);
    this.traceOp(o, false);
    if (o >= R_CONFIG) return this.readConfig(o - R_CONFIG, size);
    switch (o) {
      case R_MAGIC: return 0x74726976n; // 'virt'
      case R_VERSION: return 2n;
      case R_DEVICE_ID: return 2n; // block device
      case R_VENDOR_ID: return 0x554d4551n; // 'QEMU'
      case R_DEVICE_FEATURES:
        return this.hostFeaturesSel === 0
          ? FEATURES_HOST & 0xffffffffn
          : (FEATURES_HOST >> 32n) & 0xffffffffn;
      case R_DEVICE_FEATURES_SEL: return BigInt(this.hostFeaturesSel);
      case R_DRIVER_FEATURES:
        return this.guestFeaturesSel === 0
          ? this.guestFeatures & 0xffffffffn
          : (this.guestFeatures >> 32n) & 0xffffffffn;
      case R_DRIVER_FEATURES_SEL: return BigInt(this.guestFeaturesSel);
      case R_QUEUE_SEL: return BigInt(this.queueSel);
      case R_QUEUE_NUM_MAX: return BigInt(QUEUE_SIZE);
      case R_QUEUE_NUM: return BigInt(this.curQueue().num);
      case R_QUEUE_READY: return this.curQueue().ready ? 1n : 0n;
      case R_QUEUE_NOTIFY: return 0n;
      case R_INTERRUPT_STATUS: return BigInt(this.interruptStatus);
      case R_INTERRUPT_ACK: return 0n;
      case R_STATUS: return BigInt(this.status);
      case R_QUEUE_DESC_LOW: return this.curQueue().desc & 0xffffffffn;
      case R_QUEUE_DESC_HIGH: return (this.curQueue().desc >> 32n) & 0xffffffffn;
      case R_QUEUE_AVAIL_LOW: return this.curQueue().driver & 0xffffffffn;
      case R_QUEUE_AVAIL_HIGH: return (this.curQueue().driver >> 32n) & 0xffffffffn;
      case R_QUEUE_USED_LOW: return this.curQueue().device & 0xffffffffn;
      case R_QUEUE_USED_HIGH: return (this.curQueue().device >> 32n) & 0xffffffffn;
      case R_CONFIG_GENERATION: return 0n;
      default: return 0n;
    }
  }

  write(offset: bigint, value: bigint, _size: MemSize): void {
    const o = Number(offset);
    this.traceOp(o, true, value);
    const v = Number(value & 0xffffffffn);
    switch (o) {
      case R_DEVICE_FEATURES_SEL:
        this.hostFeaturesSel = v & 1;
        return;
      case R_DRIVER_FEATURES:
        if (this.guestFeaturesSel === 0) {
          this.guestFeatures = (this.guestFeatures & ~0xffffffffn) | (value & 0xffffffffn);
        } else {
          this.guestFeatures = (this.guestFeatures & 0xffffffffn) | ((value & 0xffffffffn) << 32n);
        }
        return;
      case R_DRIVER_FEATURES_SEL:
        this.guestFeaturesSel = v & 1;
        return;
      case R_GUEST_PAGE_SIZE:
        return; // legacy only，忽略
      case R_QUEUE_SEL:
        this.queueSel = v < this.queues.length ? v : 0;
        return;
      case R_QUEUE_NUM:
        if (v > 0 && v <= QUEUE_SIZE) this.curQueue().num = v;
        return;
      case R_QUEUE_READY: {
        const q = this.curQueue();
        q.ready = v === 1;
        if (q.ready) q.lastAvail = this.readAvailIdx(q);
        return;
      }
      case R_QUEUE_NOTIFY:
        this.processQueue(this.queues[v] ?? this.queues[0]);
        this.notifyStats++;
        return;
      case R_INTERRUPT_ACK:
        this.interruptStatus &= ~v;
        if (this.interruptStatus === 0) this.irq?.(false);
        return;
      case R_STATUS:
        this.status = v & 0xff;
        if (this.status === 0) this.reset();
        return;
      case R_QUEUE_DESC_LOW:
        this.curQueue().desc = (this.curQueue().desc & ~0xffffffffn) | BigInt(v);
        return;
      case R_QUEUE_DESC_HIGH:
        this.curQueue().desc = (this.curQueue().desc & 0xffffffffn) | (BigInt(v) << 32n);
        return;
      case R_QUEUE_AVAIL_LOW:
        this.curQueue().driver = (this.curQueue().driver & ~0xffffffffn) | BigInt(v);
        return;
      case R_QUEUE_AVAIL_HIGH:
        this.curQueue().driver = (this.curQueue().driver & 0xffffffffn) | (BigInt(v) << 32n);
        return;
      case R_QUEUE_USED_LOW:
        this.curQueue().device = (this.curQueue().device & ~0xffffffffn) | BigInt(v);
        return;
      case R_QUEUE_USED_HIGH:
        this.curQueue().device = (this.curQueue().device & 0xffffffffn) | (BigInt(v) << 32n);
        return;
      default:
        return;
    }
  }

  reset(): void {
    for (const q of this.queues) {
      q.ready = false;
      q.lastAvail = 0;
    }
    this.interruptStatus = 0;
    this.guestFeatures = 0n;
    this.guestFeaturesSel = 0;
    this.queueSel = 0;
    this.status = 0;
  }

  private readConfig(o: number, _size: MemSize): bigint {
    const cap = this.disk.sectorCount;
    switch (o) {
      case 0x00: return cap & 0xffffffffn; // capacity low
      case 0x04: return (cap >> 32n) & 0xffffffffn; // capacity high
      case 0x08: return 0n; // size_max
      case 0x0c: return BigInt(QUEUE_SIZE - 2); // seg_max
      case 0x10: {
        // geometry: cylinders(u16) heads(u8) sectors(u8)
        const cyl = Number(cap) > 0xffff ? 0xffff : Number(cap);
        return BigInt((cyl << 16) | (16 << 8) | 63);
      }
      case 0x14: return 512n; // blk_size
      case 0x18: return 0n; // topology
      case 0x20: return 1n; // writeback
      default: return 0n;
    }
  }

  // ------------------------------------------------------------------
  // virtqueue 处理
  // ------------------------------------------------------------------

  private mem16(addr: bigint): number {
    return Number(this.bus.read(addr, 2) & 0xffffn);
  }
  private mem32(addr: bigint): number {
    return Number(this.bus.read(addr, 4) & 0xffffffffn);
  }
  private mem64(addr: bigint): bigint {
    return this.bus.read(addr, 8);
  }

  private readAvailIdx(q: VQueue): number {
    return this.mem16(q.driver + 2n);
  }

  private readAvailFlags(q: VQueue): number {
    return this.mem16(q.driver);
  }

  /** 处理一个 virtqueue 上所有新的请求 */
  private processQueue(q: VQueue): void {
    if (!q.ready) return;
    const availIdx = this.readAvailIdx(q);
    const noInterrupt = (this.readAvailFlags(q) & VRING_AVAIL_F_NO_INTERRUPT) !== 0;

    while (q.lastAvail !== availIdx) {
      const slot = q.lastAvail % q.num;
      const headId = this.mem16(q.driver + BigInt(4 + slot * 2));
      this.handleRequest(q, headId);
      q.lastAvail = (q.lastAvail + 1) & 0xffff;
    }

    if (!noInterrupt && this.usedWritten) {
      this.interruptStatus |= 1;
      this.irq?.(true);
      this.usedWritten = false;
    }
  }

  private usedWritten = false;

  /** 收集描述符链（展开 indirect） */
  private collectChain(q: VQueue, headId: number): Array<{ addr: bigint; len: number; write: boolean }> {
    const out: Array<{ addr: bigint; len: number; write: boolean }> = [];
    let id = headId;
    let guard = 0;
    let currentDesc = q.desc;
    let currentNum = q.num;

    while (guard++ < 10000) {
      const d = currentDesc + BigInt(id * 16);
      const addr = this.mem64(d);
      const len = this.mem32(d + 8n);
      const flags = this.mem16(d + 12n);
      const next = this.mem16(d + 14n);

      if ((flags & VRING_DESC_F_INDIRECT) !== 0) {
        // indirect 表：切换到表内描述符继续遍历
        if (out.length === 0) {
          currentDesc = addr;
          currentNum = Math.floor(len / 16);
          id = 0;
          continue;
        }
        break;
      }
      out.push({ addr, len, write: (flags & VRING_DESC_F_WRITE) !== 0 });
      if ((flags & VRING_DESC_F_NEXT) === 0) break;
      id = next;
      if (id >= currentNum) break;
    }
    return out;
  }

  private handleRequest(q: VQueue, headId: number): void {
    this.reqCount++;
    const chain = this.collectChain(q, headId);
    if (chain.length < 2) return;

    // 描述符 0 是请求头（布局）：type(4) + reserved(4) + sector(8)
    const type = this.mem32(chain[0].addr);
    const sector = this.mem64(chain[0].addr + 8n);

    // 最后一个可写描述符是状态码
    let statusDesc = -1;
    for (let i = chain.length - 1; i >= 1; i--) {
      if (chain[i].write) {
        statusDesc = i;
        break;
      }
    }
    const dataOut: typeof chain = []; // guest 只读（主机写）
    const dataIn: typeof chain = []; // guest 可写（主机读）
    for (let i = 1; i < chain.length; i++) {
      if (i === statusDesc) continue;
      if (chain[i].write) dataIn.push(chain[i]);
      else dataOut.push(chain[i]);
    }

    let status = BLK_S_OK;
    try {
      switch (type) {
        case BLK_T_IN: {
          let total = 0;
          for (const c of dataIn) total += c.len;
          const sectors = Math.ceil(total / SECTOR_SIZE);
          if (sectors > 0) {
            const buf = this.disk.readSectors(sector, sectors);
            let off = 0;
            for (const c of dataIn) {
              const n = Math.min(c.len, Math.max(0, buf.length - off));
              if (n > 0) this.bus.writeBytes(c.addr, buf.subarray(off, off + n));
              off += c.len;
            }
          }
          break;
        }
        case BLK_T_OUT: {
          let total = 0;
          for (const c of dataOut) total += c.len;
          const data = new Uint8Array(total);
          let off = 0;
          for (const c of dataOut) {
            data.set(this.bus.readBytes(c.addr, c.len), off);
            off += c.len;
          }
          if (total > 0) this.disk.writeSectors(sector, data);
          break;
        }
        case BLK_T_FLUSH:
          break;
        case BLK_T_GET_ID: {
          const id = Buffer.alloc(20, 0);
          Buffer.from('ts-riscv64-virtio').copy(id);
          let off = 0;
          for (const c of dataIn) {
            const n = Math.min(c.len, Math.max(0, id.length - off));
            if (n > 0) this.bus.writeBytes(c.addr, new Uint8Array(id.subarray(off, off + n)));
            off += c.len;
          }
          break;
        }
        case BLK_T_WRITE_ZEROES:
          break;
        default:
          status = BLK_S_UNSUPP;
      }
    } catch {
      status = BLK_S_IOERR;
    }

    if (statusDesc >= 0) {
      const sd = chain[statusDesc];
      this.bus.write(sd.addr + BigInt(sd.len - 1), BigInt(status), 1);
    }
    this.pushUsed(q, headId, 0);
  }

  private pushUsed(q: VQueue, id: number, len: number): void {
    const usedIdx = this.mem16(q.device + 2n);
    const slot = usedIdx % q.num;
    const elemAddr = q.device + BigInt(4 + slot * 8);
    this.bus.write(elemAddr, BigInt(id), 4);
    this.bus.write(elemAddr + 4n, BigInt(len), 4);
    this.bus.write(q.device + 2n, BigInt((usedIdx + 1) & 0xffff), 2);
    this.usedWritten = true;
  }

  stats(): { requests: number; notifications: number } {
    return { requests: this.reqCount, notifications: this.notifyStats };
  }
}
