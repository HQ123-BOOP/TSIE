/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';

/** 现代设备必选位（不暴露则 Linux / U-Boot / UEFI 的 probe 都会失败） */
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

/** 三环地址字段名 */
export type RingName = 'desc' | 'driver' | 'device';

/**
 * 设备逻辑侧能用的队列/内存操作 —— 由传输层提供。
 *
 * 具体设备（virtio-gpu 等）的逻辑写在「与传输无关的 core 类」里，两个传输
 * （VirtioMmio / VirtioPci）各自把 core 接到 VirtioDevice 上；core 通过这个
 * 窄接口做描述符链遍历与 used 环回写，不需要知道寄存器怎么排。
 */
export interface VirtioQueueOps {
  readonly bus: Bus;
  collectChain(q: VQueue, headId: number): ChainDesc[];
  pushUsed(q: VQueue, id: number, len: number): void;
}

/**
 * VirtIO 传输层公共基类 —— 「与寄存器怎么排无关」的那一半：特性协商状态、
 * virtqueue 状态机、avail/used 环遍历、电平中断（PLIC 语义：置位后由 guest 应答撤线）。
 *
 * 具体传输只负责把寄存器访问映射到这些状态：
 *   - `VirtioMmio` → virtio spec §4.2.2 的 MMIO 寄存器组
 *   - `VirtioPci`  → §4.1.4 的 PCI 现代能力结构（common / notify / ISF / device）
 * 设备类型差异（DeviceID、特性集、config 空间、队列数量与请求语义）由子类提供。
 */
export abstract class VirtioDevice {
  /** 物理总线：core 侧要按 GPA 直接读写 guest 内存（virtio 的像素/请求体不进队列） */
  readonly bus: Bus;
  protected readonly irq: IrqLine | undefined;

  protected status = 0;
  protected hostFeaturesSel = 0;
  protected guestFeatures = 0n;
  protected guestFeaturesSel = 0;
  protected queueSel = 0;
  protected interruptStatus = 0;
  protected queues: VQueue[] = [];
  protected notifyStats = 0;
  protected usedWritten = false;

  /** 调试：记录寄存器访问（供固件 probe 追踪） */
  trace = false;
  readonly traceLog: string[] = [];

  /** 设备类型 ID（块=2、网络=1、GPU=16，virtio spec §5） */
  protected abstract deviceId(): number;
  /** 暴露给驱动的 64 位特性集（必须含 VIRTIO_F_VERSION_1） */
  protected abstract hostFeatures(): bigint;
  /** 单个 virtqueue 的容量上限（2 的幂；驱动 QUEUE_NUM 不能超过它） */
  protected abstract queueSizeMax(): number;
  /** 设备配置空间读（offset 相对设备配置区起点，与传输无关） */
  protected abstract readConfig(offset: number, size: MemSize): bigint;
  /** 设备配置空间长度：PCI 传输要写进 device cfg 能力结构；MMIO 传输隐式占 0x100..0x200 */
  protected configSize(): number {
    return 0x100;
  }
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

  protected traceOp(tag: string, isWrite: boolean, value?: bigint): void {
    if (!this.trace || this.traceLog.length >= 3000) return;
    this.traceLog.push(`${isWrite ? 'W' : 'R'} ${tag}${isWrite ? ' = 0x' + (value ?? 0n).toString(16) : ''}`);
  }

  // ------------------------------------------------------------------
  // 传输层共用的「寄存器语义」小动作
  // 两种传输的字段布局不同，但落到状态上的操作完全相同，统一收在这里。
  // ------------------------------------------------------------------

  /** 选中队列（越界回落到队列 0，与 MMIO 既有行为一致） */
  protected selectQueue(v: number): void {
    this.queueSel = v < this.queues.length ? v : 0;
  }

  /** 设置队列容量；只接受 (0, queueSizeMax()] */
  protected setQueueNum(v: number): void {
    if (v > 0 && v <= this.queueSizeMax()) this.curQueue().num = v;
  }

  /** 置/清 QUEUE_READY；置位时把 lastAvail 对齐到当前 avail 下标（跳过陈旧请求） */
  protected setQueueReady(v: boolean): void {
    const q = this.curQueue();
    q.ready = v;
    if (q.ready) q.lastAvail = this.readAvailIdx(q);
  }

  /** 写 device_status；写 0 触发设备复位（virtio 规范要求的复位序列） */
  protected writeStatus(v: number): void {
    this.status = v & 0xff;
    if (this.status === 0) this.reset();
  }

  /** 应答中断（MMIO 的 INTERRUPT_ACK / PCI 的 ISF 读都走这里） */
  protected ackInterrupt(v: number): void {
    this.interruptStatus &= ~v;
    if (this.interruptStatus === 0) this.irq?.(false);
  }

  /** 上下半字写三环地址（MMIO 传 low/high，PCI 直接传 64 位整值） */
  protected setRing(name: RingName, value: bigint, high: boolean): void {
    const q = this.curQueue();
    q[name] = high ? (q[name] & 0xffffffffn) | (value << 32n) : (q[name] & ~0xffffffffn) | value;
  }

  /** 写整值三环地址（PCI 传输用：queue_desc / queue_driver / queue_device 都是 64 位字段） */
  protected setRingFull(name: RingName, value: bigint): void {
    this.curQueue()[name] = value;
  }

  /** QueueNotify：处理该队列上所有新到的请求 */
  protected notifyQueue(index: number): void {
    this.processQueue(this.queues[index] ?? this.queues[0]);
    this.notifyStats++;
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

  /** 收集描述符链（展开 indirect）；VirtioQueueOps 的一部分，供设备 core 调用 */
  collectChain(q: VQueue, headId: number): ChainDesc[] {
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
  pushUsed(q: VQueue, id: number, len: number): void {
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
