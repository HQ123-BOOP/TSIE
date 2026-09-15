/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { Device, MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';

// --- VirtIO-MMIO 寄存器偏移（virtio-v1.x spec §4.2.2，与 U-Boot v2025.01
//     drivers/virtio/virtio_mmio.h 逐一核对）---
export const R_MAGIC = 0x00;
export const R_VERSION = 0x04;
export const R_DEVICE_ID = 0x08;
export const R_VENDOR_ID = 0x0c;
export const R_DEVICE_FEATURES = 0x10;
export const R_DEVICE_FEATURES_SEL = 0x14;
export const R_DRIVER_FEATURES = 0x20;
export const R_DRIVER_FEATURES_SEL = 0x24;
export const R_GUEST_PAGE_SIZE = 0x28; // 仅 legacy 使用，modern 忽略
export const R_QUEUE_SEL = 0x30;
export const R_QUEUE_NUM_MAX = 0x34;
export const R_QUEUE_NUM = 0x38;
export const R_QUEUE_READY = 0x44;
export const R_QUEUE_NOTIFY = 0x50;
export const R_INTERRUPT_STATUS = 0x60;
export const R_INTERRUPT_ACK = 0x64;
export const R_STATUS = 0x70;
export const R_QUEUE_DESC_LOW = 0x80;
export const R_QUEUE_DESC_HIGH = 0x84;
export const R_QUEUE_AVAIL_LOW = 0x90;
export const R_QUEUE_AVAIL_HIGH = 0x94;
export const R_QUEUE_USED_LOW = 0xa0;
export const R_QUEUE_USED_HIGH = 0xa4;
export const R_SHM_SEL = 0xac;
export const R_SHM_LEN_LOW = 0xb0;
export const R_SHM_LEN_HIGH = 0xb4;
export const R_SHM_BASE_LOW = 0xb8;
export const R_SHM_BASE_HIGH = 0xbc;
export const R_CONFIG_GENERATION = 0xfc;
export const R_CONFIG = 0x100;

/** 现代设备必选位（mmio v2 不暴露则 Linux/UPCBoot probe 失败） */
export const VIRTIO_F_VERSION_1 = 1n << 32n;

// --- virtqueue 标志 ---
export const VRING_DESC_F_NEXT = 1;
export const VRING_DESC_F_WRITE = 2;
export const VRING_DESC_F_INDIRECT = 4;
export const VRING_AVAIL_F_NO_INTERRUPT = 1;

/** virtqueue 状态（由 guest 在 QUEUE_READY 前配好 desc/avail/used 三环地址） */
export interface VQueue {
  ready: boolean;
  num: number;
  desc: bigint;
  driver: bigint; // avail 环
  device: bigint; // used 环
  lastAvail: number;
}

/** collectChain 的产物：guest 视角的描述符（write=设备可写=guest 提供输出缓冲） */
export interface ChainDesc {
  addr: bigint;
  len: number;
  write: boolean;
}

/**
 * VirtIO-MMIO 传输层公共基类：寄存器组、特性协商、virtqueue 管理、
 * avail/used 环遍历与电平中断（PLIC 语义：置位后由 guest 写
 * INTERRUPT_ACK 撤线）。设备类型差异（DeviceID、特性集、config 空间、
 * 队列数量与请求语义）由子类通过抽象成员提供。
 */
export abstract class VirtioMmio implements Device {
  abstract readonly name: string;
  readonly size = 0x200n;

  protected readonly bus: Bus;
  protected readonly irq: IrqLine | undefined;

  protected status = 0;
  protected hostFeaturesSel = 0;
  protected guestFeatures = 0n;
  protected guestFeaturesSel = 0;
  protected queueSel = 0;
  protected interruptStatus = 0;
  protected queues: VQueue[] = [];
  protected notifyStats = 0;

  /** 调试：记录 MMIO 寄存器访问（供固件 probe 追踪） */
  trace = false;
  readonly traceLog: string[] = [];

  /** 设备类型 ID（块=2、网络=1，virtio spec §5） */
  protected abstract deviceId(): number;
  /** 暴露给驱动的 64 位特性集（必须含 VIRTIO_F_VERSION_1） */
  protected abstract hostFeatures(): bigint;
  /** 单个 virtqueue 的容量上限（2 的幂；驱动 QUEUE_NUM 不能超过它） */
  protected abstract queueSizeMax(): number;
  /** config 空间读（offset 相对 0x100） */
  protected abstract readConfig(offset: number, size: MemSize): bigint;
  /** 处理 avail 环上一个请求（headId = head 描述符下标），完成后必须 pushUsed */
  protected abstract handleRequest(q: VQueue, headId: number): void;

  constructor(bus: Bus, irq: IrqLine | undefined, queueCount: number, queueSize: number) {
    this.bus = bus;
    this.irq = irq;
    for (let i = 0; i < queueCount; i++) {
      this.queues.push({ ready: false, num: queueSize, desc: 0n, driver: 0n, device: 0n, lastAvail: 0 });
    }
  }

  protected curQueue(): VQueue {
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
      case R_DEVICE_ID: return BigInt(this.deviceId());
      case R_VENDOR_ID: return 0x554d4551n; // 'QEMU'
      case R_DEVICE_FEATURES: {
        const f = this.hostFeatures();
        return this.hostFeaturesSel === 0 ? f & 0xffffffffn : (f >> 32n) & 0xffffffffn;
      }
      case R_DEVICE_FEATURES_SEL: return BigInt(this.hostFeaturesSel);
      case R_DRIVER_FEATURES:
        return this.guestFeaturesSel === 0
          ? this.guestFeatures & 0xffffffffn
          : (this.guestFeatures >> 32n) & 0xffffffffn;
      case R_DRIVER_FEATURES_SEL: return BigInt(this.guestFeaturesSel);
      case R_QUEUE_SEL: return BigInt(this.queueSel);
      case R_QUEUE_NUM_MAX: return BigInt(this.queueSizeMax());
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
      // 共享内存寄存器：本实现不提供任何 SHM 区域。
      // 约定是「读回全 1（-1）」表示不存在 —— Linux vm_get_shm_region() 只在
      // len == ~0ULL 时返回 false；返回 0 会被理解成「存在一个长度为 0 的区域」，
      // 于是 virtio_gpu 去 devm_request_mem_region(0, 0) 失败并 -EBUSY 放弃 probe。
      case R_SHM_SEL: return 0n;
      case R_SHM_LEN_LOW:
      case R_SHM_LEN_HIGH:
      case R_SHM_BASE_LOW:
      case R_SHM_BASE_HIGH:
        return (1n << BigInt(size * 8)) - 1n;
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
        if (v > 0 && v <= this.queueSizeMax()) this.curQueue().num = v;
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

  // ------------------------------------------------------------------
  // virtqueue 处理
  // ------------------------------------------------------------------

  protected mem16(addr: bigint): number {
    return Number(this.bus.read(addr, 2) & 0xffffn);
  }
  protected mem32(addr: bigint): number {
    return Number(this.bus.read(addr, 4) & 0xffffffffn);
  }
  protected mem64(addr: bigint): bigint {
    return this.bus.read(addr, 8);
  }

  protected readAvailIdx(q: VQueue): number {
    return this.mem16(q.driver + 2n);
  }

  protected readAvailFlags(q: VQueue): number {
    return this.mem16(q.driver);
  }

  /** 处理一个 virtqueue 上所有新到请求（QueueNotify 触发；网络 RX 由注入点主动调） */
  protected processQueue(q: VQueue): void {
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

  protected usedWritten = false;

  /** 收集描述符链（展开 indirect） */
  protected collectChain(q: VQueue, headId: number): ChainDesc[] {
    const out: ChainDesc[] = [];
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

  /** 把一个请求完成回写到 used 环（id=head 描述符下标，len=写入字节数） */
  protected pushUsed(q: VQueue, id: number, len: number): void {
    const usedIdx = this.mem16(q.device + 2n);
    const slot = usedIdx % q.num;
    const elemAddr = q.device + BigInt(4 + slot * 8);
    this.bus.write(elemAddr, BigInt(id), 4);
    this.bus.write(elemAddr + 4n, BigInt(len), 4);
    this.bus.write(q.device + 2n, BigInt((usedIdx + 1) & 0xffff), 2);
    this.usedWritten = true;
  }

  /** 置 INT_VRING 并拉电平中断（供异步路径如网络 RX 注入复用） */
  protected raiseIrq(): void {
    this.interruptStatus |= 1;
    this.irq?.(true);
  }

  stats(): { notifications: number } {
    return { notifications: this.notifyStats };
  }
}
