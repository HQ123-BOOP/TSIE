/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { Device, MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';
import { VirtioDevice } from './virtio.ts';

// 与传输无关的部分（特性位、virtqueue、VQueue/ChainDesc、VirtioDevice 基类）
// 都在 ./virtio.ts —— 这里原样转出，保持既有 import 路径可用。
export {
  VirtioDevice,
  VIRTIO_F_VERSION_1,
  VRING_DESC_F_NEXT,
  VRING_DESC_F_WRITE,
  VRING_DESC_F_INDIRECT,
  VRING_AVAIL_F_NO_INTERRUPT,
  type VQueue,
  type ChainDesc,
  type RingName,
} from './virtio.ts';

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

/**
 * VirtIO-MMIO 传输层：只负责「§4.2.2 的寄存器布局 → VirtioDevice 状态」的映射。
 * 特性协商、virtqueue 遍历、中断语义都在基类里，两种传输共用。
 */
export abstract class VirtioMmio extends VirtioDevice implements Device {
  abstract readonly name: string;
  readonly size = 0x200n;

  constructor(bus: Bus, irq: IrqLine | undefined, queueCount: number, queueSize: number) {
    super(bus, irq, queueCount, queueSize);
  }

  read(offset: bigint, size: MemSize): bigint {
    const o = Number(offset);
    this.traceOp('0x' + o.toString(16).padStart(2, '0'), false);
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
    this.traceOp('0x' + o.toString(16).padStart(2, '0'), true, value);
    const v = Number(value & 0xffffffffn);
    if (o >= R_CONFIG) {
      this.writeConfig(o - R_CONFIG, value, _size);
      return;
    }
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
        this.selectQueue(v);
        return;
      case R_QUEUE_NUM:
        this.setQueueNum(v);
        return;
      case R_QUEUE_READY:
        this.setQueueReady(v === 1);
        return;
      case R_QUEUE_NOTIFY:
        this.notifyQueue(v);
        return;
      case R_INTERRUPT_ACK:
        this.ackInterrupt(v);
        return;
      case R_STATUS:
        this.writeStatus(v);
        return;
      case R_QUEUE_DESC_LOW:
        this.setRing('desc', BigInt(v), false);
        return;
      case R_QUEUE_DESC_HIGH:
        this.setRing('desc', BigInt(v), true);
        return;
      case R_QUEUE_AVAIL_LOW:
        this.setRing('driver', BigInt(v), false);
        return;
      case R_QUEUE_AVAIL_HIGH:
        this.setRing('driver', BigInt(v), true);
        return;
      case R_QUEUE_USED_LOW:
        this.setRing('device', BigInt(v), false);
        return;
      case R_QUEUE_USED_HIGH:
        this.setRing('device', BigInt(v), true);
        return;
      default:
        return;
    }
  }
}
