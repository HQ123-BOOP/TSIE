/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { MemSize } from '../../mem/types.ts';
import type { IrqLine } from '../uart.ts';
import type { Bus } from '../../mem/bus.ts';
import { VirtioDevice, VIRTIO_F_VERSION_1 } from '../virtio.ts';
import type { PciBarSpec, PciBarTarget, PciFunction } from './ecam.ts';

/**
 * VirtIO-PCI 现代传输（virtio spec §4.1.4）。
 *
 * 和 VirtIO-MMIO 的差别只在「寄存器怎么排」：
 *   - MMIO：一整块寄存器组，设备配置空间在 0x100 起；
 *   - PCI ：4 个 vendor capability 指向 BAR0 内的 4 段结构
 *            common cfg(0x0000) / ISR(0x1000) / device cfg(0x2000) / notify(0x3000)。
 * 队列遍历、特性协商、used 环、中断语义全部来自 VirtioDevice。
 *
 * 只宣告 virtio 1.0（不暴露 legacy，不实现 MSI-X）—— 中断走 INTx，
 * 由 DTB 的 interrupt-map 映射到 PLIC（QEMU riscv virt：设备 N 的 INTA = IRQ 32+N）。
 */

export const VIRTIO_PCI_VENDOR_ID = 0x1af4;
/** virtio 现代设备：PCI device id = 0x1040 + virtio device id */
const VIRTIO_PCI_MODERN_BASE = 0x1040;

/** PCI_CAP_ID_VNDR */
const PCI_CAP_ID_VNDR = 0x09;

// capability 类型（§4.1.4.3）
const CAP_COMMON = 1;
const CAP_NOTIFY = 2;
const CAP_ISR = 3;
const CAP_DEVICE = 4;

// BAR0 内 4 段结构的偏移与长度
const OFF_COMMON = 0x0000;
const OFF_ISR = 0x1000;
const OFF_DEVICE = 0x2000;
const OFF_NOTIFY = 0x3000;
const BAR0_SIZE = 0x4000;
const COMMON_LEN = 0x38;
const ISR_LEN = 4;
const NOTIFY_LEN = 0x1000;
/** notify 地址 = notify 基址 + queue_notify_off × 本乘数 */
const NOTIFY_OFF_MULTIPLIER = 2;

/** 没有 MSI-X 时这些字段按规范读回 NO_VECTOR */
const VIRTIO_MSI_NO_VECTOR = 0xffff;

/** 组一个 vendor capability（16 字节；notify 多带 4 字节乘数） */
function vendorCap(next: number, cfgType: number, offset: number, length: number, extra?: Uint8Array): Uint8Array {
  const c = new Uint8Array(16 + (extra?.length ?? 0));
  const dv = new DataView(c.buffer);
  c[0] = PCI_CAP_ID_VNDR;
  c[1] = next;
  c[2] = c.length;
  c[3] = cfgType;
  c[4] = 0; // bar = BAR0
  c[5] = 0; // id（仅 PCI_CFG 类型使用）
  // 布局按 virtio spec，也与 EDK2 的 VIRTIO_PCI_CAP
  // （OvmfPkg/Include/IndustryStandard/Virtio10.h）一致：
  //   VendorHdr(Id/Next/Length = 3B) + ConfigType + Bar + Padding[3] + Offset(le32) + Length(le32)
  // → Offset 在字节 8、Length 在字节 12。
  // 曾把两者写到 6 / 10（只留 1 字节 padding），错位两字节：EDK2 于是把 Length 读成 0，
  // 每次寄存器访问都撞上 `FieldOffset > Config->Length - FieldSize` 的边界检查
  // 而返回 EFI_INVALID_PARAMETER，VirtioGpuInit() 失败，最终一个 GOP 都没有。
  dv.setUint32(8, offset, true);
  dv.setUint32(12, length, true);
  if (extra) c.set(extra, 16);
  return c;
}

/**
 * virtio-pci 传输的公共部分。子类只需声明两件与设备类型有关的事：
 *   - `deviceId()`      → virtio 设备类型 id（1=net、2=blk、16=gpu）
 *   - `pciClassCode()`  → PCI 类码（显示设备必须是 0x03xxxx，UEFI 的 IsPciDisplay 只看基类）
 * 两个都必须是无副作用的常量（构造期就会被调用来合成配置空间）。
 */
export abstract class VirtioPci extends VirtioDevice implements PciFunction, PciBarTarget {
  readonly name: string;

  // --- PciFunction：PCI 身份 ---
  readonly vendorId = VIRTIO_PCI_VENDOR_ID;
  readonly pciDeviceId: number;
  readonly classCode: number;
  readonly revision = 0x01;
  readonly subsystemVendorId = VIRTIO_PCI_VENDOR_ID;
  /**
   * 子系统 ID。QEMU 对**纯 modern** 设备不在 PCI_SUBSYSTEM_ID 上写 virtio id
   * （那是 legacy 分支才做的事），沿用 PCI 核心的默认值 PCI_SUBDEVICE_ID_QEMU
   * = 0x1100 —— 而 EDK2 的 Virtio10Dxe 恰好要求 `SubsystemID >= 0x40` 才绑定，
   * 所以这里必须照抄 0x1100，不能填 virtio 设备类型 id。
   */
  readonly subsystemId = 0x1100;
  readonly bars: PciBarSpec[] = [{ io: false, size: BAR0_SIZE }];
  readonly extConfig: Uint8Array;

  /** 落在哪条总线的哪个 dev/fn 槽位 */
  readonly pciDev: number;
  readonly pciFn: number;

  /** 调试：配置空间的写入流水 */
  readonly configLog: string[] = [];

  constructor(bus: Bus, irq: IrqLine | undefined, queueCount: number, queueSize: number, dev = 0, fn = 0) {
    super(bus, irq, queueCount, queueSize);
    this.pciDev = dev;
    this.pciFn = fn;
    const vdevId = this.deviceId();
    this.name = `virtio-pci(${vdevId})`;
    this.pciDeviceId = VIRTIO_PCI_MODERN_BASE + vdevId;
    this.classCode = this.pciClassCode();
    this.extConfig = this.buildCaps();
  }

  /** PCI 类码（24 位：base<<16 | sub<<8 | progIf） */
  protected abstract pciClassCode(): number;

  private buildCaps(): Uint8Array {
    const cfgLen = Math.max(4, Math.min(this.configSize(), 0x1000));
    const mult = new Uint8Array(4);
    new DataView(mult.buffer).setUint32(0, NOTIFY_OFF_MULTIPLIER, true);
    const out = new Uint8Array(0x44);
    out.set(vendorCap(0x50, CAP_COMMON, OFF_COMMON, COMMON_LEN), 0x00);
    out.set(vendorCap(0x64, CAP_NOTIFY, OFF_NOTIFY, NOTIFY_LEN, mult), 0x10);
    out.set(vendorCap(0x74, CAP_ISR, OFF_ISR, ISR_LEN), 0x24);
    out.set(vendorCap(0x00, CAP_DEVICE, OFF_DEVICE, cfgLen), 0x34);
    return out;
  }

  /** 只有 BAR0 会被路由；其余 BAR 不存在 */
  barTarget(barIndex: number, _address: bigint): PciBarTarget | undefined {
    return barIndex === 0 ? this : undefined;
  }

  configWritten(offset: number, size: MemSize, value: bigint): void {
    if (this.configLog.length < 100) {
      this.configLog.push(`cfg+0x${offset.toString(16)} size=${size} = 0x${value.toString(16)}`);
    }
  }

  // ------------------------------------------------------------------
  // BAR0 窗口（PciBarTarget）
  // ------------------------------------------------------------------

  read(offset: bigint, size: MemSize): bigint {
    return this.windowRead(Number(offset), size);
  }

  write(offset: bigint, value: bigint, size: MemSize): void {
    this.windowWrite(Number(offset), value, size);
  }

  private windowRead(o: number, size: MemSize): bigint {
    if (o >= OFF_NOTIFY) return 0n; // notify 只写不读
    if (o >= OFF_DEVICE) return this.readConfig(o - OFF_DEVICE, size);
    if (o >= OFF_ISR) {
      // 读 ISF 即应答中断（§4.1.4.4）
      const v = BigInt(this.interruptStatus);
      this.ackInterrupt(0xffffffff);
      return v & maskOf(size);
    }
    return this.commonRead(o, size);
  }

  private windowWrite(o: number, value: bigint, size: MemSize): void {
    if (o >= OFF_NOTIFY) {
      const idx = (o - OFF_NOTIFY) / NOTIFY_OFF_MULTIPLIER;
      if (Number.isInteger(idx)) this.notifyQueue(idx);
      return;
    }
    if (o >= OFF_DEVICE) return; // device cfg 只读
    if (o >= OFF_ISR) return; // ISF 只读
    this.commonWrite(o, value, size);
  }

  // ------------------------------------------------------------------
  // common cfg（§4.1.4.3）
  // ------------------------------------------------------------------

  private commonRead(o: number, size: MemSize): bigint {
    const q = this.curQueue();
    switch (o) {
      case 0x00: return BigInt(this.hostFeaturesSel);
      case 0x04: {
        const f = this.hostFeatures();
        return (this.hostFeaturesSel === 0 ? f & 0xffffffffn : (f >> 32n) & 0xffffffffn) & maskOf(size);
      }
      case 0x08: return BigInt(this.guestFeaturesSel);
      case 0x0c:
        return (
          this.guestFeaturesSel === 0
            ? this.guestFeatures & 0xffffffffn
            : (this.guestFeatures >> 32n) & 0xffffffffn
        ) & maskOf(size);
      case 0x10: return BigInt(VIRTIO_MSI_NO_VECTOR); // msix_config：无 MSI-X
      case 0x12: return BigInt(this.queues.length); // num_queues
      case 0x14: return BigInt(this.status); // device_status
      case 0x15: return 0n; // config_generation
      case 0x16: return BigInt(this.queueSel);
      case 0x18: return BigInt(q.num);
      case 0x1a: return BigInt(VIRTIO_MSI_NO_VECTOR); // queue_msix_vector
      case 0x1c: return q.ready ? 1n : 0n; // queue_enable
      case 0x1e: return BigInt(this.queueSel); // queue_notify_off
      case 0x20: case 0x24: case 0x28: case 0x2c: case 0x30: case 0x34: {
        const ring = this.ringValue(ringNameAt(o));
        const base = o & ~0x4; // 0x24 → 0x20 …
        if (size === 8) {
          return ring & 0xffffffffffffffffn;
        }
        if (o === base) return ring & maskOf(size);
        return (ring >> 32n) & maskOf(size);
      }
      default: return 0n;
    }
  }

  /** 当前选中队列的三环地址 */
  private ringValue(name: 'desc' | 'driver' | 'device'): bigint {
    const q = this.curQueue();
    return name === 'desc' ? q.desc : name === 'driver' ? q.driver : q.device;
  }

  private commonWrite(o: number, value: bigint, size: MemSize): void {
    const v = Number(value & 0xffffffffn);
    switch (o) {
      case 0x00: this.hostFeaturesSel = v & 0xffffffff; return;
      case 0x08: this.guestFeaturesSel = v & 0xffffffff; return;
      case 0x0c:
        if (this.guestFeaturesSel === 0) {
          this.guestFeatures = (this.guestFeatures & ~0xffffffffn) | (value & 0xffffffffn);
        } else {
          this.guestFeatures = (this.guestFeatures & 0xffffffffn) | ((value & 0xffffffffn) << 32n);
        }
        return;
      case 0x10: return; // msix_config：无 MSI-X
      case 0x14: this.writeStatus(v); return;
      case 0x16: this.selectQueue(v); return;
      case 0x18: this.setQueueNum(v); return;
      case 0x1a: return; // queue_msix_vector
      case 0x1c: this.setQueueReady(v === 1); return;
      case 0x20: case 0x24: case 0x28: case 0x2c: case 0x30: case 0x34: {
        const name = ringNameAt(o);
        const base = o & ~0x4;
        if (size === 8) {
          this.setRingFull(name, value & 0xffffffffffffffffn);
        } else if (o === base) {
          this.setRing(name, value & 0xffffffffn, false);
        } else {
          this.setRing(name, value & 0xffffffffn, true);
        }
        return;
      }
      default: return;
    }
  }
}

/** common cfg 里三环地址所在偏移 → 环名 */
function ringNameAt(o: number): 'desc' | 'driver' | 'device' {
  if (o >= 0x30) return 'device';
  if (o >= 0x28) return 'driver';
  return 'desc';
}

function maskOf(size: MemSize): bigint {
  return size >= 8 ? 0xffffffffffffffffn : (1n << BigInt(8 * size)) - 1n;
}

/** 现代设备必选位再导出，便于设备侧声明特性集时引用 */
export { VIRTIO_F_VERSION_1 };
