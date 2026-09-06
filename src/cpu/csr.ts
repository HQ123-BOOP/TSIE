/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { MASK64 } from '../core/bits.ts';

/** 特权级 */
export const Priv = { U: 0, S: 1, H: 2, M: 3 } as const;
export type PrivLevel = 0 | 1 | 2 | 3;

/** 异常编号（mcause / scause 的低位） */
export const Exc = {
  InstAddrMisaligned: 0,
  InstAccessFault: 1,
  IllegalInstruction: 2,
  Breakpoint: 3,
  LoadAddrMisaligned: 4,
  LoadAccessFault: 5,
  StoreAddrMisaligned: 6,
  StoreAccessFault: 7,
  EnvCallFromU: 8,
  EnvCallFromS: 9,
  EnvCallFromM: 11,
  InstPageFault: 12,
  LoadPageFault: 13,
  StorePageFault: 15,
  SoftwareCheck: 18,
  HardwareError: 19,
} as const;

/** 中断编号 */
export const Irq = {
  USoftware: 0,
  SSoftware: 1,
  MSoftware: 3,
  UTimer: 4,
  STimer: 5,
  MTimer: 7,
  UExternal: 8,
  SExternal: 9,
  MExternal: 11,
} as const;

/** mcause 中断标志位 */
export const INTERRUPT_FLAG = 0x8000000000000000n;

/** 常用 CSR 地址 */
export const CSR = {
  // 浮点
  FFLAGS: 0x001,
  FRM: 0x002,
  FCSR: 0x003,
  // 只读计数器（影子）
  CYCLE: 0xc00,
  TIME: 0xc01,
  INSTRET: 0xc02,
  // Supervisor
  SSTATUS: 0x100,
  SIE: 0x104,
  STVEC: 0x105,
  SCOUNTEREN: 0x106,
  SSCRATCH: 0x140,
  SEPC: 0x141,
  SCAUSE: 0x142,
  STVAL: 0x143,
  SIP: 0x144,
  SATP: 0x180,
  // Machine
  MSTATUS: 0x300,
  MISA: 0x301,
  MEDELEG: 0x302,
  MIDELEG: 0x303,
  MIE: 0x304,
  MTVEC: 0x305,
  MCOUNTEREN: 0x306,
  MENVCFG: 0x30a,
  MCOUNTINHIBIT: 0x320,
  MSCRATCH: 0x340,
  MEPC: 0x341,
  MCAUSE: 0x342,
  MTVAL: 0x343,
  MIP: 0x344,
  PMPCFG0: 0x3a0,
  PMPADDR0: 0x3b0,
  MCYCLE: 0xb00,
  MINSTRET: 0xb02,
  MVENDORID: 0xf11,
  MARCHID: 0xf12,
  MIMPID: 0xf13,
  MHARTID: 0xf14,
  MCONFIGPTR: 0xf15,
} as const;

// --- mstatus 位定义（RV64） ---
export const SR_SIE = 1n << 1n;
export const SR_MIE = 1n << 3n;
export const SR_SPIE = 1n << 5n;
export const SR_UBE = 1n << 6n;
export const SR_MPIE = 1n << 7n;
export const SR_SPP = 1n << 8n;
export const SR_VS = 3n << 9n;
export const SR_MPP = 3n << 11n;
export const SR_FS = 3n << 13n;
export const SR_XS = 3n << 15n;
export const SR_MPRV = 1n << 17n;
export const SR_SUM = 1n << 18n;
export const SR_MXR = 1n << 19n;
export const SR_TVM = 1n << 20n;
export const SR_TW = 1n << 21n;
export const SR_TSR = 1n << 22n;
export const SR_UXL = 3n << 30n;
export const SR_SXL = 3n << 32n;
export const SR_SBE = 1n << 34n;
export const SR_MBE = 1n << 35n;
export const SR_SD = 1n << 63n;

/** mstatus 中软件可写位（其余为 WPRI / 只读） */
export const MSTATUS_WRITABLE =
  (SR_SIE | SR_MIE | SR_SPIE | SR_UBE | SR_MPIE | SR_SPP | SR_MPP | SR_FS | SR_MPRV | SR_SUM | SR_MXR |
    SR_TVM | SR_TW | SR_TSR | SR_UXL | SR_SXL | SR_SBE | SR_MBE) &
  MASK64;

/** sstatus 视图：S-mode 可见/可写位 */
export const SSTATUS_MASK =
  (SR_SIE | SR_SPIE | SR_UBE | SR_SPP | SR_FS | SR_XS | SR_SUM | SR_MXR | SR_UXL) & MASK64;

/** RV64GC + B：MXL=2, 扩展集合 I M A F D C B S U */
export const MISA_VALUE = 0x800000000014112fn;

/** 计数器来源（由 CPU/机器提供） */
export interface CounterSource {
  cycle(): bigint;
  time(): bigint;
  instret(): bigint;
}

interface CsrDef {
  mask: bigint;
  /** 只读 CSR（写会触发非法指令异常） */
  readOnly?: boolean;
  read?(cur: bigint): bigint;
  write?(next: bigint, cur: bigint): bigint;
}

/**
 * CSR 寄存器文件：实现 WARL 掩码、只读保护、别名（sstatus/mstatus）与副作用钩子。
 */
const CSR_SPACE = 4096;

/**
 * CSR 寄存器文件：实现 WARL 掩码、只读保护、别名（sstatus/mstatus）与副作用钩子。
 * 内部用定长数组存储（CSR 地址空间只有 12 位），热路径上比 Map 快数倍。
 */
export class CsrFile {
  private regs: Array<bigint | undefined> = new Array(CSR_SPACE);
  private defs: Array<CsrDef | undefined> = new Array(CSR_SPACE);
  private counters: CounterSource = {
    cycle: () => 0n,
    time: () => 0n,
    instret: () => 0n,
  };
  /** satp 写入回调（用于刷 TLB） */
  onSatpWrite?: (value: bigint) => void;
  /**
   * mstatus / satp 自上次 MMU 同步以来是否被写过。
   * CPU 每条指令都要把 mstatus/satp 同步给 MMU，但这两个 CSR 极少变化；
   * 用脏标记把常态开销从「2 次带钩子的 read + 掩码」降为一次布尔判断。
   */
  mmuDirty = true;

  constructor() {
    this.defineDefaults();
  }

  setCounterSource(src: CounterSource): void {
    this.counters = src;
  }

  define(addr: number, initial: bigint, def: CsrDef): void {
    this.defs[addr] = def;
    this.regs[addr] = initial & def.mask;
    if (addr === CSR.MSTATUS || addr === CSR.SATP) this.mmuDirty = true;
  }

  /** 读取 CSR；返回 null 表示该 CSR 未实现（应触发非法指令） */
  read(addr: number): bigint | null {
    const def = this.defs[addr];
    if (def === undefined) return null;
    const cur = this.regs[addr] ?? 0n;
    return (def.read ? def.read(cur) : cur) & def.mask;
  }

  /**
   * 热路径直读：返回内部存储的原始值，跳过 read 钩子与掩码。
   *
   * 仅可用于「没有 read 钩子」或「钩子结果对调用方无影响」的 CSR。
   * 目前用于 MMU 同步（mstatus 的 read 钩子只合成 SD 位，MMU 不使用该位）
   * 与 mip 刷新（mip 无 read 钩子）。
   */
  raw(addr: number): bigint {
    return this.regs[addr] ?? 0n;
  }

  /** 直接写（绕过特权检查），返回值表示是否成功 */
  writeRaw(addr: number, value: bigint): boolean {
    const def = this.defs[addr];
    if (def === undefined) return false;
    const cur = this.regs[addr] ?? 0n;
    let next = value & def.mask;
    if (def.write) next = def.write(next, cur) & def.mask;
    this.regs[addr] = next & MASK64;
    if (addr === CSR.MSTATUS || addr === CSR.SATP) this.mmuDirty = true;
    return true;
  }

  /** 特权检查 + 只读检查，返回 true 表示可写 */
  canWrite(addr: number, priv: PrivLevel): boolean {
    const level = (addr >> 8) & 3;
    if (priv < level) return false;
    const def = this.defs[addr];
    if (def === undefined) return false;
    return !def.readOnly;
  }

  /**
   * 读特权检查。除常规特权级门槛外，还实现 Zicntr 的 counteren 门控：
   * 特权规范 §3.1.10 —— S/U 态读 cycle/time/instret 时，若 mcounteren
   * 对应位为 0（U 态还要求 scounteren 对应位为 1）则抛非法指令。
   */
  canRead(addr: number, priv: PrivLevel): boolean {
    const level = (addr >> 8) & 3;
    if (priv < level) return false;
    if (this.defs[addr] === undefined) return false;
    if (priv < 3 && addr >= CSR.CYCLE && addr <= CSR.INSTRET) {
      const bit = 1n << BigInt(addr & 0x1f);
      if (((this.regs[CSR.MCOUNTEREN] ?? 0n) & bit) === 0n) return false;
      if (priv === 0 && ((this.regs[CSR.SCOUNTEREN] ?? 0n) & bit) === 0n) return false;
    }
    return true;
  }

  has(addr: number): boolean {
    return this.defs[addr] !== undefined;
  }

  /** 读取特权级要求 */
  static privLevel(addr: number): number {
    return (addr >> 8) & 3;
  }

  /** 内部：mstatus 的 SD 位随 FS/XS 变化 */
  private readMstatus(cur: bigint): bigint {
    const dirty = ((cur & SR_FS) === SR_FS || (cur & SR_XS) === SR_XS) ? SR_SD : 0n;
    return (cur & ~SR_SD) | dirty;
  }

  private defineDefaults(): void {
    const self = this;

    // ---------------- 浮点 ----------------
    this.define(CSR.FFLAGS, 0n, {
      mask: 0x1fn,
      read: () => (self.read(CSR.FCSR) ?? 0n) & 0x1fn,
      write: (next) => {
        self.writeRaw(CSR.FCSR, ((self.read(CSR.FCSR) ?? 0n) & ~0x1fn) | (next & 0x1fn));
        return next & 0x1fn;
      },
    });
    this.define(CSR.FRM, 0n, {
      mask: 0x7n,
      read: () => ((self.read(CSR.FCSR) ?? 0n) >> 5n) & 0x7n,
      write: (next) => {
        self.writeRaw(CSR.FCSR, ((self.read(CSR.FCSR) ?? 0n) & ~(0x7n << 5n)) | ((next & 0x7n) << 5n));
        return next & 0x7n;
      },
    });
    this.define(CSR.FCSR, 0n, { mask: 0xffn });

    // ---------------- 计数器 ----------------
    const roCounter = (which: 'cycle' | 'time' | 'instret') => ({
      mask: MASK64,
      readOnly: true,
      read: () => self.counters[which](),
    });
    this.define(CSR.CYCLE, 0n, roCounter('cycle'));
    this.define(CSR.TIME, 0n, roCounter('time'));
    this.define(CSR.INSTRET, 0n, roCounter('instret'));
    // mcycle/minstret 可由软件读写（写 0 清零通常用于基准测试），与内部计数器相互独立
    this.define(CSR.MCYCLE, 0n, { mask: MASK64 });
    this.define(CSR.MINSTRET, 0n, { mask: MASK64 });
    this.define(CSR.MCOUNTINHIBIT, 0n, { mask: 0xffffffffn });
    // 默认开放 cycle/time/instret 给 S 与 U 态（QEMU/Spike 固件通常如此初始化，
    // 否则用户态 rdcycle/rdtime 一上来就是非法指令）
    this.define(CSR.MCOUNTEREN, 0x7n, { mask: 0xffffn });
    this.define(CSR.SCOUNTEREN, 0x7n, { mask: 0xffffn });

    // ---------------- mstatus / sstatus ----------------
    this.define(CSR.MSTATUS, SR_MPP | (SR_UXL & (2n << 30n)) | (SR_SXL & (2n << 32n)), {
      mask: MASK64,
      read: (cur) => self.readMstatus(cur),
      write: (next) => {
        // SXL/UXL 只支持 64 位；VS/XS 恒为 0（未实现向量/用户扩展）
        let v = next & MSTATUS_WRITABLE;
        v = (v & ~SR_XS) | (0n << 15n);
        v = (v & ~SR_VS) | (0n << 9n);
        v = (v & ~SR_UXL) | (2n << 30n);
        v = (v & ~SR_SXL) | (2n << 32n);
        return v;
      },
    });
    this.define(CSR.SSTATUS, 0n, {
      mask: SSTATUS_MASK,
      read: () => (self.read(CSR.MSTATUS) ?? 0n) & SSTATUS_MASK,
      write: (next) => {
        const m = self.read(CSR.MSTATUS) ?? 0n;
        self.writeRaw(CSR.MSTATUS, (m & ~SSTATUS_MASK) | (next & SSTATUS_MASK));
        return next;
      },
    });

    // ---------------- trap 相关（M） ----------------
    this.define(CSR.MTVEC, 0n, { mask: MASK64 & ~0x2n });
    this.define(CSR.MEDELEG, 0n, { mask: MASK64 });
    this.define(CSR.MIDELEG, 0n, { mask: 0xffffffffn });
    this.define(CSR.MIE, 0n, { mask: 0xffffffffn });
    this.define(CSR.MIP, 0n, { mask: 0xffffffffn });
    this.define(CSR.MSCRATCH, 0n, { mask: MASK64 });
    this.define(CSR.MEPC, 0n, { mask: MASK64 & ~0x1n });
    this.define(CSR.MCAUSE, 0n, { mask: MASK64 });
    this.define(CSR.MTVAL, 0n, { mask: MASK64 });
    this.define(CSR.MENVCFG, 0n, { mask: MASK64 });
    this.define(CSR.MCONFIGPTR, 0n, { mask: MASK64, readOnly: true });

    // ---------------- trap 相关（S） ----------------
    this.define(CSR.STVEC, 0n, { mask: MASK64 & ~0x2n });
    this.define(CSR.STVAL, 0n, { mask: MASK64 });
    this.define(CSR.SSCRATCH, 0n, { mask: MASK64 });
    this.define(CSR.SEPC, 0n, { mask: MASK64 & ~0x1n });
    this.define(CSR.SCAUSE, 0n, { mask: MASK64 });
    this.define(CSR.SIE, 0n, {
      mask: 0xffffffffn,
      read: () => (self.read(CSR.MIE) ?? 0n) & (self.read(CSR.MIDELEG) ?? 0n) & 0xffffffffn,
      write: (next) => {
        const mie = self.read(CSR.MIE) ?? 0n;
        const mideleg = self.read(CSR.MIDELEG) ?? 0n;
        self.writeRaw(CSR.MIE, (mie & ~mideleg) | (next & mideleg));
        return next;
      },
    });
    this.define(CSR.SIP, 0n, {
      mask: 0xffffffffn,
      read: () => (self.read(CSR.MIP) ?? 0n) & (self.read(CSR.MIDELEG) ?? 0n) & 0xffffffffn,
      write: (next) => {
        const mip = self.read(CSR.MIP) ?? 0n;
        const mideleg = self.read(CSR.MIDELEG) ?? 0n;
        // 只有 SSIP 可被 S 模式写；STIP/SEIP 由硬件（CLINT/PLIC）驱动
        const writable = (1n << 1n) & mideleg;
        self.writeRaw(CSR.MIP, (mip & ~writable) | (next & writable));
        return next;
      },
    });
    this.define(CSR.SATP, 0n, {
      mask: MASK64,
      write: (next) => {
        const mode = (next >> 60n) & 0xfn;
        // 只支持 Bare / Sv39 / Sv48
        if (mode !== 0n && mode !== 8n && mode !== 9n) return self.read(CSR.SATP) ?? 0n;
        if (self.onSatpWrite) self.onSatpWrite(next);
        return next;
      },
    });

    // ---------------- 只读标识 ----------------
    this.define(CSR.MISA, MISA_VALUE, { mask: MASK64, readOnly: true });
    this.define(CSR.MVENDORID, 0x00000000n, { mask: MASK64, readOnly: true });
    this.define(CSR.MARCHID, 0x00000000n, { mask: MASK64, readOnly: true });
    this.define(CSR.MIMPID, 0x00000000n, { mask: MASK64, readOnly: true });
    this.define(CSR.MHARTID, 0n, { mask: MASK64, readOnly: true });

    // ---------------- PMP（寄存器可读写，但不做权限强制） ----------------
    for (let i = 0; i < 4; i++) this.define(CSR.PMPCFG0 + i, 0n, { mask: MASK64 });
    for (let i = 0; i < 16; i++) this.define(CSR.PMPADDR0 + i, 0n, { mask: (1n << 54n) - 1n });
  }

  /** 调试用：快照所有 CSR */
  snapshot(): Map<number, bigint> {
    const m = new Map<number, bigint>();
    for (let addr = 0; addr < CSR_SPACE; addr++) {
      if (this.defs[addr] === undefined) continue;
      const v = this.read(addr);
      if (v !== null) m.set(addr, v);
    }
    return m;
  }
}
