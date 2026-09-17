/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../../mem/bus.ts';
import type { Device, MemSize } from '../../mem/types.ts';

/**
 * PCIe 主机桥（ECAM）。
 *
 * 只实现 guest 真正看得见的那部分 —— 和 QEMU riscv `virt` 一样，
 * 没有 GPEX 私有寄存器，配置空间就是一段内存映射区（ECAM）：
 *
 *     地址 = (bus << 20) | (dev << 15) | (fn << 12) | reg
 *     1 条总线 = 32 dev × 8 fn × 4KiB = 1MiB，默认给 256 条 = 256MiB
 *
 * BAR 的**定容**与**分配**由 guest 的 PCI 总线驱动（EDK2 的 PciBusDxe / Linux 的
 * pci_bus）按标准流程做：往 BAR 写全 1、读回得到尺寸掩码、再写回真正的地址。
 * 本桥只负责照规矩应答，并在地址落定后把该 BAR 的访问路由到功能上。
 *
 * 功能侧只需要声明「我是什么」（vendor/device/class/BAR 大小/能力链），
 * 以及「BAR 落定后怎么处理访问」——见 PciFunction。
 */

/** 一个 BAR 的定义 */
export interface PciBarSpec {
  /** true = I/O 空间（落到 PIO 窗口），false = 内存空间（落到 MMIO32 窗口） */
  io: boolean;
  /** 期望大小（字节，必须 2 的幂） */
  size: number;
}

/** BAR 拿到地址后，主机桥用它把该窗口的访问转给功能 */
export interface PciBarTarget {
  read(offset: bigint, size: MemSize): bigint;
  write(offset: bigint, value: bigint, size: MemSize): void;
}

/** PCI 功能（一个 dev/fn 槽位上的设备） */
export interface PciFunction {
  readonly vendorId: number;
  /** PCI device id（注意：不是 virtio 设备类型 id，后者是 VirtioDevice.deviceId()） */
  readonly pciDeviceId: number;
  /** 24 位：base << 16 | sub << 8 | progIf（0x038000 = Display / Other） */
  readonly classCode: number;
  readonly revision?: number;
  /** 子系统厂商（默认与 vendorId 相同） */
  readonly subsystemVendorId?: number;
  /** 子系统 ID（virtio 现代设备规定等于 virtio device id） */
  readonly subsystemId?: number;
  /** BAR 定义，索引即 BAR 号 */
  readonly bars: PciBarSpec[];
  /** 扩展配置空间（0x40 起，最多 0xc0 字节）；能力链由功能自己摆 */
  readonly extConfig?: Uint8Array;
  /** 该 BAR 被分到 address（总线侧地址）后返回访问目标；undefined = 不路由 */
  barTarget(barIndex: number, address: bigint): PciBarTarget | undefined;
  /** 旁听配置空间写入（命令寄存器、能力结构内字段等） */
  configWritten?(offset: number, size: MemSize, value: bigint): void;
}

/** 内存 / I/O 窗口（总线侧地址） */
export interface PciWindow {
  base: bigint;
  size: bigint;
}

/**
 * Machine 的 PCIe 选项。
 *
 * 目前只有显卡走 PCI —— 这是**上游设计的正路**：UEFI 的
 * `PlatformBootManagerBeforeConsole()` 只显式 connect PCI 显示设备
 * （`FilterAndProcess(&gEfiPciIoProtocolGuid, IsPciDisplay, Connect)`），
 * virtio-mmio 显示设备不在其列，所以 MMIO 显卡的 GOP 会晚于 ConOut 组装，
 * 启动 logo 需要改平台库才能出现。
 */
export interface PciOptions {
  /** 把 virtio-gpu 挂成 PCI 显示设备（默认 true；false 则该设备仍走 virtio-mmio） */
  gpu?: boolean;
}

export interface PciHostBridgeOptions {
  /** ECAM 基址，默认 0x30000000 */
  ecam?: bigint;
  /** ECAM 覆盖的总线数，默认 256（= 256MiB） */
  busCount?: number;
  /** 32 位内存窗口，BAR 从这里分配；默认 0x40000000 + 1GiB */
  mmio?: PciWindow;
  /** I/O 窗口，默认 0x03000000 + 64KiB */
  io?: PciWindow;
}

const CFG_SIZE = 0x100;
const FUNC_STRIDE = 0x1000;
const DEV_STRIDE = FUNC_STRIDE * 8;
const BUS_STRIDE = DEV_STRIDE * 32;
const MAX_BARS = 6;

/** 把一个 BAR 窗口注册到总线上，转发给功能 */
class PciBarWindow implements Device {
  constructor(
    readonly name: string,
    readonly size: bigint,
    private readonly target: PciBarTarget,
  ) {}

  read(offset: bigint, size: MemSize): bigint {
    return this.target.read(offset, size);
  }

  write(offset: bigint, value: bigint, size: MemSize): void {
    this.target.write(offset, value, size);
  }
}

interface Slot {
  dev: number;
  fn: number;
  impl: PciFunction;
  /** 256 字节配置空间（头 0x40 由桥合成，其后来自 extConfig） */
  cfg: Uint8Array;
  /** 每个 BAR 已分配的地址（0 = 未分配） */
  barAddr: bigint[];
  /** 该 BAR 正在定容探测（guest 刚写了全 1） */
  barProbe: boolean[];
  /** 已注册的总线窗口，重新分配时先撤掉 */
  windows: Array<PciBarWindow | undefined>;
}

export class PciHostBridge implements Device {
  readonly name = 'pci-host-ecam';
  readonly size: bigint;
  readonly ecamBase: bigint;
  readonly mmioWindow: PciWindow;
  readonly ioWindow: PciWindow;

  private readonly busCount: number;
  private readonly slots: Slot[] = [];
  /** 设备侧 MMIO 访问计数（调试用） */
  barReads = 0;
  barWrites = 0;

  constructor(
    private readonly bus: Bus,
    opts: PciHostBridgeOptions = {},
  ) {
    this.ecamBase = opts.ecam ?? 0x30000000n;
    this.busCount = opts.busCount ?? 256;
    this.size = BigInt(this.busCount) * BigInt(BUS_STRIDE);
    this.mmioWindow = opts.mmio ?? { base: 0x40000000n, size: 0x40000000n };
    this.ioWindow = opts.io ?? { base: 0x03000000n, size: 0x10000n };
  }

  /** 挂一个功能到 dev/fn 槽位（dev 0..31、fn 0..7） */
  addFunction(dev: number, fn: number, impl: PciFunction): void {
    const cfg = new Uint8Array(CFG_SIZE);
    const dv = new DataView(cfg.buffer);
    dv.setUint16(0x00, impl.vendorId & 0xffff, true);
    dv.setUint16(0x02, impl.pciDeviceId & 0xffff, true);
    dv.setUint16(0x04, 0, true); // command：全关（等驱动打开）
    // status：bit4 = 有能力链。没给 extConfig 就别声称有。
    dv.setUint16(0x06, impl.extConfig ? 0x0010 : 0x0000, true);
    cfg[0x08] = (impl.revision ?? 0) & 0xff;
    cfg[0x09] = impl.classCode & 0xff; // progIf
    cfg[0x0a] = (impl.classCode >> 8) & 0xff; // sub class
    cfg[0x0b] = (impl.classCode >> 16) & 0xff; // base class
    cfg[0x0e] = 0x00; // headerType：普通设备（BAR0..5）
    dv.setUint16(0x2c, (impl.subsystemVendorId ?? impl.vendorId) & 0xffff, true);
    dv.setUint16(0x2e, (impl.subsystemId ?? impl.pciDeviceId) & 0xffff, true);
    cfg[0x34] = impl.extConfig ? 0x40 : 0x00; // capability pointer
    cfg[0x3d] = 0x01; // interruptPin = INTA#
    if (impl.extConfig) {
      const n = Math.min(impl.extConfig.length, CFG_SIZE - 0x40);
      cfg.set(impl.extConfig.subarray(0, n), 0x40);
    }

    const barAddr: bigint[] = [];
    const barProbe: boolean[] = [];
    const windows: Array<PciBarWindow | undefined> = [];
    for (let i = 0; i < MAX_BARS; i++) {
      barAddr.push(0n);
      barProbe.push(false);
      windows.push(undefined);
    }
    this.slots.push({ dev, fn, impl, cfg, barAddr, barProbe, windows });
    this.syncBars(this.slots[this.slots.length - 1]!);
  }

  /** ECAM 地址 → 槽位（没挂功能则返回 undefined，读回全 1） */
  private slotAt(dev: number, fn: number): Slot | undefined {
    return this.slots.find((s) => s.dev === dev && s.fn === fn);
  }

  // ------------------------------------------------------------------
  // ECAM 配置空间
  // ------------------------------------------------------------------

  read(offset: bigint, size: MemSize): bigint {
    const o = Number(offset);
    const slot = this.slotAt((o >> 15) & 0x1f, (o >> 12) & 0x7);
    if (!slot) return mask(size); // 空槽位：惯例是读回全 1
    const reg = o & (CFG_SIZE - 1);
    if (size === 8) return mask(8); // 配置空间最多 4 字节访问

    let v = 0n;
    for (let i = 0; i < size; i++) {
      v |= BigInt(slot.cfg[reg + i] ?? 0xff) << BigInt(8 * i);
    }
    // BAR 定容：写全 1 之后读回尺寸掩码
    if (reg >= 0x10 && reg < 0x10 + MAX_BARS * 4 && size === 4) {
      const idx = (reg - 0x10) / 4;
      if ((reg - 0x10) % 4 === 0 && slot.barProbe[idx]) {
        return this.barMask(slot, idx);
      }
    }
    return v & mask(size);
  }

  write(offset: bigint, value: bigint, size: MemSize): void {
    const o = Number(offset);
    const slot = this.slotAt((o >> 15) & 0x1f, (o >> 12) & 0x7);
    if (!slot || size === 8) return;
    const reg = o & (CFG_SIZE - 1);

    // BAR 区：定容 / 分配
    if (reg >= 0x10 && reg < 0x10 + MAX_BARS * 4 && size === 4 && (reg - 0x10) % 4 === 0) {
      const idx = (reg - 0x10) / 4;
      const spec = slot.impl.bars[idx];
      if (!spec) return;
      if (value === 0xffffffffn) {
        slot.barProbe[idx] = true;
        return;
      }
      slot.barProbe[idx] = false;
      // 低 4 位是类型/属性位，地址按 BAR 大小对齐
      const align = BigInt(spec.size);
      slot.barAddr[idx] = value & ~(align - 1n);
      slot.cfg[reg] = Number(slot.barAddr[idx] & 0xffn);
      slot.cfg[reg + 1] = Number((slot.barAddr[idx] >> 8n) & 0xffn);
      slot.cfg[reg + 2] = Number((slot.barAddr[idx] >> 16n) & 0xffn);
      slot.cfg[reg + 3] = Number((slot.barAddr[idx] >> 24n) & 0xffn);
      this.syncBars(slot);
      return;
    }

    for (let i = 0; i < size; i++) {
      slot.cfg[reg + i] = Number((value >> BigInt(8 * i)) & 0xffn);
    }
    slot.impl.configWritten?.(reg, size, value);
  }

  /** 一个 BAR 的定容掩码（含类型位） */
  private barMask(slot: Slot, idx: number): bigint {
    const spec = slot.impl.bars[idx];
    if (!spec) return 0n;
    // 内存 BAR：低 4 位可写（bit0=0 表示内存，bit1/2=类型，bit3=可预取）
    // I/O BAR：低 2 位可写（bit0=1 表示 I/O）
    const flags = spec.io ? 0x3n : 0xfn;
    return (~(BigInt(spec.size) - 1n) & 0xffffffffn) | flags;
  }

  /** 把已分配的 BAR 注册成总线窗口（先撤旧的） */
  private syncBars(slot: Slot): void {
    for (let i = 0; i < MAX_BARS; i++) {
      const spec = slot.impl.bars[i];
      const old = slot.windows[i];
      if (old) {
        this.bus.removeDevice(old);
        slot.windows[i] = undefined;
      }
      if (!spec || slot.barAddr[i] === 0n) continue;
      const target = slot.impl.barTarget(i, slot.barAddr[i]);
      if (!target) continue;
      const w = new PciBarWindow(`${this.name}.bar${i}`, BigInt(spec.size), target);
      this.bus.addDevice(slot.barAddr[i], w);
      slot.windows[i] = w;
    }
  }

  /** 已挂上的功能（调试 / 测试用） */
  functions(): Array<{ dev: number; fn: number; impl: PciFunction; barAddr: bigint[] }> {
    return this.slots.map((s) => ({ dev: s.dev, fn: s.fn, impl: s.impl, barAddr: s.barAddr.slice() }));
  }
}

function mask(size: number): bigint {
  return size >= 8 ? 0xffffffffffffffffn : (1n << BigInt(8 * size)) - 1n;
}
