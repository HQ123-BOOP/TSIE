/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import {
  MASK64,
  immB,
  immI,
  immJ,
  immS,
  immU,
  s32,
  s64,
  sext,
  u64,
} from '../core/bits.ts';
import type { Bus } from '../mem/bus.ts';
import { AccessType, type MemSize } from '../mem/types.ts';
import {
  CSR,
  CsrFile,
  Exc,
  INTERRUPT_FLAG,
  Irq,
  MISA_VALUE,
  Priv,
  SR_FS,
  SR_MIE,
  SR_MPIE,
  SR_MPP,
  SR_MPRV,
  SR_SIE,
  SR_SPIE,
  SR_SPP,
  type PrivLevel,
} from './csr.ts';
import { Mmu } from './mmu.ts';
import {
  FFLAG,
  RM,
  bitsToF64,
  f32Box,
  f64Box,
  fclassOfBits,
  fcmpFlags,
  flagsForResult,
  fminMax,
  rawF32,
  roundResult,
  unboxF32,
} from './fpu.ts';

export type MisalignedMode = 'trap' | 'slow';

export interface CpuOptions {
  misaligned?: MisalignedMode;
  hartId?: number;
}

/** 是否为无穷大 */
function isInf(x: number): boolean {
  return x === Infinity || x === -Infinity;
}

// ---------------- Zba / Zbb / Zbs 位计数助手 ----------------

/** 32 位 popcount（输入按无符号 32 位解释） */
function popcnt32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

function clz64(v: bigint): number {
  return v === 0n ? 64 : 64 - v.toString(2).length;
}

function ctz64(v: bigint): number {
  return v === 0n ? 64 : (v & -v).toString(2).length - 1;
}

function popcount64(v: bigint): number {
  return popcnt32(Number(v >> 32n)) + popcnt32(Number(v & 0xffffffffn));
}

/** RV64GC 处理器核心 */
export class Cpu {
  /** 整数寄存器 x0-x31（x0 恒为 0） */
  readonly x: bigint[] = new Array(32).fill(0n);
  /** 浮点寄存器 f0-f31，保存原始位模式（单精度 NaN-boxed） */
  readonly f: bigint[] = new Array(32).fill(0n);

  pc = 0n;
  /** 调试钩子：每次非法指令异常时回调（pc、指令编码、当前特权级） */
  onIllegal?: (pc: bigint, inst: number, priv: PrivLevel) => void;
  /** 调试钩子：每次同步异常（含 ECALL）进入时回调，在 SBI 拦截之前 */
  onTrap?: (cause: number, tval: bigint, pc: bigint, priv: PrivLevel) => void;
  /** 调试钩子：每次中断被响应时回调（中断号、目标特权级） */
  onInterrupt?: (irq: number, target: PrivLevel) => void;
  /** 下一条指令地址（跳转指令修改它） */
  nextPc = 0n;
  priv: PrivLevel = Priv.M;

  readonly csr = new CsrFile();
  readonly mmu: Mmu;

  instret = 0n;
  mcycle = 0n;
  /** 外部时间源（CLINT 的 mtime） */
  timeSource: () => bigint = () => this.mcycle;

  halted = false;
  haltReason = '';
  exitCode = 0;
  wfi = false;

  misaligned: MisalignedMode;
  hartId: number;

  /** 指令跟踪回调 */
  onTrace?: (pc: bigint, inst: number, len: number, priv: PrivLevel) => void;
  traceEnabled = false;
  /** PC 大于等于该值时才开始跟踪（配合 traceEnabled） */
  traceFrom = 0n;

  /** 设备驱动的中断挂起线（bit = Irq 编号） */
  private irqLines = 0n;

  /** LR/SC 保留集 */
  private reserved = false;
  private reservedAddr = 0n;
  /** 本条指令是否发生陷阱（陷阱入口地址已写入 pc） */
  private trapTaken = false;

  stats = { loads: 0, stores: 0, amo: 0, traps: 0, fp: 0 };

  constructor(bus: Bus, opts: CpuOptions = {}) {
    this.mmu = new Mmu(bus);
    this.misaligned = opts.misaligned ?? 'trap';
    this.hartId = opts.hartId ?? 0;
    this.csr.setCounterSource({
      cycle: () => this.mcycle & MASK64,
      time: () => this.timeSource() & MASK64,
      instret: () => this.instret & MASK64,
    });
    this.csr.onSatpWrite = () => this.mmu.flush();
    this.reset();
  }

  reset(entryPc = 0n): void {
    this.x.fill(0n);
    this.f.fill(0n);
    this.pc = entryPc;
    this.priv = Priv.M;
    this.halted = false;
    this.wfi = false;
    this.reserved = false;
    // 复位状态：M 模式，FS=3（dirty，避免浮点指令陷入）、MPP=M
    this.csr.writeRaw(CSR.MSTATUS, SR_MPP | SR_FS | (2n << 30n) | (2n << 32n));
    this.csr.writeRaw(CSR.MISA, MISA_VALUE);
    this.csr.writeRaw(CSR.MHARTID, BigInt(this.hartId));
    this.csr.writeRaw(CSR.MARCHID, 0x0000000000000000n);
    this.csr.writeRaw(CSR.MIMPID, 0x0000000000000001n);
    this.csr.writeRaw(CSR.SATP, 0n);
    this.mmu.flush();
    this.syncMmu();
  }

  // ------------------------------------------------------------------
  // 寄存器 / 状态同步
  // ------------------------------------------------------------------

  private setX(rd: number, v: bigint): void {
    if (rd === 0) return;
    this.x[rd] = v & MASK64;
  }

  private setF(rd: number, v: bigint): void {
    this.f[rd] = v & MASK64;
  }

  /**
   * 把特权级 / mstatus / satp 同步到 MMU（公开以便调试与测试）。
   *
   * 热路径优化：mstatus/satp 极少变化，用 csr.mmuDirty 脏标记 + priv 比较短路，
   * 避免每条指令都走两次带钩子的 CSR read（含 BigInt 掩码运算）。
   * 这里用 csr.raw() 直读原始值：mstatus 的 read 钩子只合成 SD 位，MMU 不使用该位。
   */
  syncMmu(): void {
    if (!this.csr.mmuDirty && this.mmu.priv === this.priv) return;
    this.csr.mmuDirty = false;
    this.mmu.priv = this.priv;
    this.mmu.mstatus = this.csr.raw(CSR.MSTATUS);
    this.mmu.satp = this.csr.raw(CSR.SATP);
  }

  /** 供设备调用：设置中断挂起线 */
  setIrqLines(mask: bigint): void {
    this.irqLines = mask;
  }

  /**
   * 由设备直接驱动的 mip 位：MTIP(7) / MSIP(3) / MEIP(11) / SEIP(9)。
   * STIP(5) 与 SSIP(1) 由 M 模式软件（SBI）管理，不在此覆盖。
   * 预计算为常量字段，避免每条指令重新构造 BigInt 掩码。
   */
  private static readonly DEVICE_MIP_MASK = (1n << 7n) | (1n << 3n) | (1n << 11n) | (1n << 9n);
  private static readonly DEVICE_MIP_NMASK = ~((1n << 7n) | (1n << 3n) | (1n << 11n) | (1n << 9n));

  /**
   * 每条指令的中断同步：refreshMip + pending 预判合并。
   *
   * 旧实现 refreshMip + checkInterrupts 各自读 MIP/MIE（常态共 4 次
   * BigInt 读 + AND）。合并后一次读出：先算 pending = MIE & MIP，
   * 非零才需要 checkInterrupts 的委派/优先级深层逻辑（冷路径）。
   * 返回 pending 供调用方决定是否陷入。
   */
  private irqPending: bigint = 0n;

  private syncIrqState(): void {
    const lines = this.irqLines;
    let mip = this.csr.raw(CSR.MIP); // mip 无 read 钩子，可直读
    const dm = Cpu.DEVICE_MIP_MASK;
    // 设备中断线 → mip 位同步（常态 lines=0 且无残留，一次 AND 出门）
    if (lines !== 0n || (mip & dm) !== 0n) {
      const next = (mip & Cpu.DEVICE_MIP_NMASK) | (lines & dm);
      if (next !== mip) {
        this.csr.writeRaw(CSR.MIP, next);
        mip = next;
      }
    }
    const mie = this.csr.raw(CSR.MIE);
    this.irqPending = mie === 0n ? 0n : (mie & mip);
  }

  // ------------------------------------------------------------------
  // 执行主循环入口
  // ------------------------------------------------------------------

  /** 执行一条指令 */
  step(): void {
    this.mcycle++;
    if (this.halted) return;

    this.syncMmu();
    this.syncIrqState();
    if (this.irqPending !== 0n && this.checkInterrupts()) return;
    if (this.wfi) {
      // RISC-V 特权规范 §3.3.3：WFI 的唤醒**不受 mstatus.MIE/SIE 与 mideleg 影响**。
      // 只要有中断挂起（无论全局使能位是否打开），hart 就必须退出 WFI、
      // 从 WFI 之后一条继续执行 —— 此时并不陷入；随后软件开中断才会真正响应它。
      // Linux 正是据此实现的：kernel/sched/idle.c 先 local_irq_disable() 再
      // arch_cpu_idle() 执行 wfi，返回后才 local_irq_enable()。
      // 若在这里直接 return 而不检查挂起，关着中断的 WFI 会永久死锁 ——
      // 表现为 mtime 一路快进、外设中断来了也无人应答。
      // 注意：irqPending 含 MIE 门控（WFI 唤醒语义更宽），此处按规范
      // 只看 MIE&MIP 之外的挂起——直接用未门控的挂起判断：
      if (this.irqPending !== 0n || (this.csr.raw(CSR.MIP) & this.irqLines) !== 0n) this.wfi = false;
      return;
    }

    const pc = this.pc;
    this.nextPc = pc + 4n;
    this.trapTaken = false;

    // 指令地址必须至少 2 字节对齐（RVC IALIGN=16）
    if ((pc & 0x1n) !== 0n) {
      this.takeException(Exc.InstAddrMisaligned, pc);
      return;
    }

    const lo = this.mmu.fetch16(pc);
    if (lo === null) {
      this.takeException(this.mmu.faultCause, this.mmu.faultTval);
      return;
    }
    if ((lo & 3) !== 3) {
      this.instret++;
      if (this.traceEnabled) this.emitTrace(pc, lo, 2);
      this.nextPc = pc + 2n; // 压缩指令占 2 字节（跳转指令会覆盖它）
      this.execCompressed(lo);
      if (!this.trapTaken) this.pc = this.nextPc;
      return;
    }
    // RVC（IALIGN=16）下 32 位指令允许 2 字节对齐；step() 入口已保证 pc 为偶数
    const hi = this.mmu.fetch16(pc + 2n);
    if (hi === null) {
      this.takeException(this.mmu.faultCause, this.mmu.faultTval);
      return;
    }
    const inst = (lo | (hi << 16)) >>> 0;
    this.instret++;
    if (this.traceEnabled) this.emitTrace(pc, inst, 4);
    this.nextPc = pc + 4n;
    this.execute(inst);
    if (!this.trapTaken) this.pc = this.nextPc;
  }

  private emitTrace(pc: bigint, inst: number, len: number): void {
    if (pc < this.traceFrom) return;
    this.onTrace?.(pc, inst, len, this.priv);
  }

  // ------------------------------------------------------------------
  // 32 位指令执行
  // ------------------------------------------------------------------

  private execute(inst: number): void {
    const opcode = inst & 0x7f;
    const rd = (inst >> 7) & 0x1f;
    const funct3 = (inst >> 12) & 0x7;
    const rs1 = (inst >> 15) & 0x1f;
    const rs2 = (inst >> 20) & 0x1f;
    const funct7 = (inst >>> 25) & 0x7f;

    switch (opcode) {
      // ---------------- LUI / AUIPC ----------------
      case 0x37: // LUI
        this.setX(rd, immU(inst));
        return;
      case 0x17: // AUIPC
        this.setX(rd, u64(this.pc + immU(inst)));
        return;

      // ---------------- JAL / JALR ----------------
      case 0x6f: {
        // JAL
        const target = u64(this.pc + immJ(inst));
        this.setX(rd, u64(this.pc + 4n));
        this.jump(target);
        return;
      }
      case 0x67: {
        // JALR
        if (funct3 !== 0) return this.illegal(inst);
        const target = u64(s64(this.x[rs1] + immI(inst)) & ~1n);
        this.setX(rd, u64(this.pc + 4n));
        this.jump(target);
        return;
      }

      // ---------------- BRANCH ----------------
      case 0x63: {
        const a = this.x[rs1];
        const b = this.x[rs2];
        let take: boolean;
        switch (funct3) {
          case 0: take = a === b; break; // BEQ
          case 1: take = a !== b; break; // BNE
          case 4: take = s64(a) < s64(b); break; // BLT
          case 5: take = s64(a) >= s64(b); break; // BGE
          case 6: take = a < b; break; // BLTU
          case 7: take = a >= b; break; // BGEU
          default: return this.illegal(inst);
        }
        if (take) this.jump(u64(this.pc + immB(inst)));
        return;
      }

      // ---------------- LOAD ----------------
      case 0x03: {
        const addr = u64(this.x[rs1] + immI(inst));
        const size = 1 << (funct3 & 3);
        const v = this.loadMem(addr, size as MemSize);
        if (v === null) return;
        const signed = funct3 < 4;
        this.setX(rd, signed ? sext(v, size * 8) : v);
        return;
      }

      // ---------------- STORE ----------------
      case 0x23: {
        const addr = u64(this.x[rs1] + immS(inst));
        const size = 1 << (funct3 & 3);
        if (funct3 > 3) return this.illegal(inst);
        this.storeMem(addr, this.x[rs2], size as MemSize);
        return;
      }

      // ---------------- OP-IMM ----------------
      case 0x13: {
        const a = this.x[rs1];
        const imm = immI(inst);
        switch (funct3) {
          case 0: this.setX(rd, u64(a + imm)); return; // ADDI
          case 2: this.setX(rd, BigInt(Number(s64(a) < s64(imm)))); return; // SLTI
          case 3: this.setX(rd, BigInt(Number(a < (imm & MASK64)))); return; // SLTIU
          case 4: this.setX(rd, a ^ imm); return; // XORI
          case 6: this.setX(rd, a | imm); return; // ORI
          case 7: this.setX(rd, a & imm); return; // ANDI
          case 1: // SLLI
          case 5: {
            // SRLI / SRAI / rori / bexti（Zbb/Zbs）
            const shamt = BigInt((inst >> 20) & 0x3f);
            const f6 = (inst >>> 26) & 0x3f;
            if (funct3 === 1) {
              // SLLI + Zbs 立即数形态（bseti/bclri/binvi）+ Zbb 单操作数（clz/ctz/cpop/sext）
              const bit = 1n << shamt;
              if (f6 === 0x00) this.setX(rd, u64(a << shamt));
              else if (f6 === 0x0a) this.setX(rd, u64(a | bit)); // bseti
              else if (f6 === 0x12) this.setX(rd, u64(a & ~bit)); // bclri
              else if (f6 === 0x1a) this.setX(rd, u64(a ^ bit)); // binvi
              else if (f6 === 0x18) {
                // clz/ctz/cpop/sext.b/sext.h：funct12=0x600|k（规范编码是 OP-IMM）
                switch (shamt) {
                  case 0n: this.setX(rd, BigInt(clz64(a))); break;
                  case 1n: this.setX(rd, BigInt(ctz64(a))); break;
                  case 2n: this.setX(rd, BigInt(popcount64(a))); break;
                  case 4n: this.setX(rd, sext(a & 0xffn, 8)); break; // sext.b
                  case 5n: this.setX(rd, sext(a & 0xffffn, 16)); break; // sext.h
                  default: return this.illegal(inst);
                }
              } else return this.illegal(inst);
            } else if (f6 === 0x00) {
              this.setX(rd, a >> shamt);
            } else if (f6 === 0x10) {
              this.setX(rd, u64(s64(a) >> shamt));
            } else if (f6 === 0x18) {
              // rori：BigInt 位移无 64 位上限问题，n=0 天然成立
              this.setX(rd, shamt === 0n ? a & MASK64 : u64((a >> shamt) | (a << (64n - shamt))));
            } else if (f6 === 0x12) {
              this.setX(rd, (a >> shamt) & 1n); // bexti
            } else if (f6 === 0x0a && shamt === 0x07n) {
              // orc.b（Zbb）：每个非零字节展开为 0xff
              let r = 0n;
              for (let i = 0n; i < 8n; i++) {
                if (((a >> (i * 8n)) & 0xffn) !== 0n) r |= 0xffn << (i * 8n);
              }
              this.setX(rd, r);
            } else if (f6 === 0x1a && shamt === 0x18n) {
              // rev8（Zbb）：64 位字节序反转
              let r = 0n;
              for (let i = 0n; i < 8n; i++) r = (r << 8n) | ((a >> (i * 8n)) & 0xffn);
              this.setX(rd, r);
            } else {
              return this.illegal(inst);
            }
            return;
          }
        }
        return;
      }

      // ---------------- OP-IMM-32 ----------------
      case 0x1b: {
        const a = this.x[rs1];
        switch (funct3) {
          case 0: this.setX(rd, s32(a + immI(inst))); return; // ADDIW
          case 1: {
            // SLLIW（funct7=0）、slli.uw（Zba，f6=000010）与 clzw/ctzw/cpopw（Zbb，f6=011000）
            const f6 = (inst >>> 26) & 0x3f;
            const shamt = BigInt((inst >> 20) & 0x3f);
            if (funct7 === 0x00 && f6 === 0) this.setX(rd, s32(a << shamt));
            else if (f6 === 0x02) this.setX(rd, (a & 0xffffffffn) << shamt);
            else if (f6 === 0x18) {
              // clzw/ctzw/cpopw：规范编码在 OP-IMM-32（funct12=0x600|k），结果按 32 位符号扩展
              const ua = a & 0xffffffffn;
              switch (shamt) {
                case 0n: this.setX(rd, s32(BigInt(ua === 0n ? 32 : 32 - ua.toString(2).length))); break;
                case 1n: this.setX(rd, s32(BigInt(ua === 0n ? 32 : (ua & -ua).toString(2).length - 1))); break;
                case 2n: this.setX(rd, s32(BigInt(popcnt32(Number(ua))))); break;
                default: return this.illegal(inst);
              }
            } else return this.illegal(inst);
            return;
          }
          case 5: {
            const shamt = BigInt((inst >> 20) & 0x1f);
            const f6 = (inst >>> 26) & 0x3f;
            if (funct7 === 0x00) this.setX(rd, s32((a & 0xffffffffn) >> shamt));
            else if (funct7 === 0x20) this.setX(rd, sext(s32(a) >> shamt, 32));
            else if (f6 === 0x18) {
              // roriw：32 位循环右移后符号扩展
              const u = a & 0xffffffffn;
              this.setX(rd, s32(shamt === 0n ? u : (u >> shamt) | ((u << (32n - shamt)) & 0xffffffffn)));
            } else return this.illegal(inst);
            return;
          }
          default: return this.illegal(inst);
        }
      }

      // ---------------- OP / OP-32 ----------------
      case 0x33:
      case 0x3b: {
        const is32 = opcode === 0x3b;
        const a = is32 ? s32(this.x[rs1]) : this.x[rs1];
        const b = is32 ? s32(this.x[rs2]) : this.x[rs2];
        let res: bigint;
        if (funct7 === 0x01) {
          // M 扩展
          // 有符号运算需要先把寄存器值按位宽解释为有符号数
          const sa = is32 ? a : s64(a);
          const sb = is32 ? b : s64(b);
          switch (funct3) {
            case 0: res = is32 ? s32(a * b) : u64(a * b); break; // MUL / MULW
            case 1: // MULH
              if (is32) return this.illegal(inst);
              res = u64((sa * sb) >> 64n);
              break;
            case 2: // MULHSU：rs1 有符号 × rs2 无符号
              if (is32) return this.illegal(inst);
              res = u64((sa * (b & MASK64)) >> 64n);
              break;
            case 3: // MULHU
              if (is32) return this.illegal(inst);
              res = ((a & MASK64) * (b & MASK64)) >> 64n;
              break;
            case 4: // DIV：向零截断，除零返回全 1
              res = sb === 0n ? (is32 ? s32(-1n) : MASK64) : is32 ? s32(sa / sb) : u64(sa / sb);
              break;
            case 5: { // DIVU
              const ua = is32 ? a & 0xffffffffn : a & MASK64;
              const ub = is32 ? b & 0xffffffffn : b & MASK64;
              res = ub === 0n ? (is32 ? 0xffffffffn : MASK64) : is32 ? s32(ua / ub) : ua / ub;
              break;
            }
            case 6: // REM：符号与被除数一致；除零返回被除数
              res = sb === 0n ? (is32 ? s32(a) : a) : is32 ? s32(sa % sb) : u64(sa % sb);
              break;
            case 7: { // REMU
              const ua = is32 ? a & 0xffffffffn : a & MASK64;
              const ub = is32 ? b & 0xffffffffn : b & MASK64;
              res = ub === 0n ? (is32 ? s32(ua) : ua) : is32 ? s32(ua % ub) : ua % ub;
              break;
            }
            default: return this.illegal(inst);
          }
        } else if (this.execBext(is32, funct7, funct3, rd, rs1, rs2)) {
          return;
        } else {
          switch (funct3) {
            case 0:
              res = funct7 === 0x20 ? a - b : a + b;
              break; // ADD/SUB
            case 1: res = u64(a << (b & (is32 ? 0x1fn : 0x3fn))); break; // SLL
            case 2: res = BigInt(Number(s64(a) < s64(b))); break; // SLT
            case 3: res = BigInt(Number((a & MASK64) < (b & MASK64))); break; // SLTU
            case 4: res = a ^ b; break; // XOR
            case 5: {
              const sh = b & (is32 ? 0x1fn : 0x3fn);
              res = funct7 === 0x20 ? u64(s64(a) >> sh) : (is32 ? (a & 0xffffffffn) : a) >> sh;
              break; // SRL/SRA
            }
            case 6: res = a | b; break; // OR
            case 7: res = a & b; break; // AND
            default: return this.illegal(inst);
          }
        }
        this.setX(rd, is32 ? s32(res) : u64(res));
        return;
      }

      // ---------------- MISC-MEM ----------------
      case 0x0f:
        // FENCE / FENCE.I：无缓存，按 nop 处理
        return;

      // ---------------- SYSTEM ----------------
      case 0x73:
        this.execSystem(inst, rd, funct3, rs1);
        return;

      // ---------------- 浮点 / AMO ----------------
      case 0x07: // LOAD-FP
      case 0x27: // STORE-FP
      case 0x53: // OP-FP
      case 0x43: // FMADD
      case 0x47: // FMSUB
      case 0x4b: // FNMSUB
      case 0x4f: // FNMADD
        this.execFp(inst, opcode, rd, funct3, rs1, rs2, funct7);
        return;

      case 0x2f: // AMO
        this.execAmo(inst, rd, funct3, rs1, rs2);
        return;

      default:
        return this.illegal(inst);
    }
  }

/** 跳转：目标最低位由调用者负责清零（JALR）或天然为 0（JAL） */
private jump(target: bigint): void {
  this.nextPc = target & MASK64;
}

/**
 * Zba/Zbb/Zbs 位运算扩展。命中并执行返回 true；返回 false 表示
 * 该 funct7/funct3 组合不属于 B（走通用分发）。
 * 注意 BigInt 位移无 32 位上限截断，rol/ror 的 n=0 边界天然正确。
 */
private execBext(is32: boolean, funct7: number, funct3: number, rd: number, rs1: number, rs2: number): boolean {
  const a = this.x[rs1] & MASK64;
  const b = this.x[rs2] & MASK64;
  if (!is32) {
    switch (funct7) {
      case 0x05: // min/max/minu/maxu
        switch (funct3) {
          case 4: this.setX(rd, s64(a) < s64(b) ? a : b); return true; // min
          case 5: this.setX(rd, a < b ? a : b); return true; // minu
          case 6: this.setX(rd, s64(a) > s64(b) ? a : b); return true; // max
          case 7: this.setX(rd, a > b ? a : b); return true; // maxu
          default: return false;
        }
      case 0x10: // sh1add/sh2add/sh3add（f3=000 是 SUB，不在 B 内）
        switch (funct3) {
          case 2: this.setX(rd, u64((a << 1n) + b)); return true;
          case 4: this.setX(rd, u64((a << 2n) + b)); return true;
          case 6: this.setX(rd, u64((a << 3n) + b)); return true;
          default: return false;
        }
      case 0x30: // rol/ror（funct7=0b0110000；clz 族是 OP-IMM 编码，不在这）
        switch (funct3) {
          case 1: { // rol
            const n = b & 63n;
            this.setX(rd, n === 0n ? a : u64((a << n) | (a >> (64n - n))));
            return true;
          }
          case 5: { // ror
            const n = b & 63n;
            this.setX(rd, n === 0n ? a : u64((a >> n) | (a << (64n - n))));
            return true;
          }
          default: return false;
        }
      case 0x20: // andn/orn/xnor（f3=000 是 SUB、f3=101 是 SRA，不在 B 内）
        switch (funct3) {
          case 7: this.setX(rd, a & ~b); return true; // andn
          case 6: this.setX(rd, a | ~b); return true; // orn
          case 4: this.setX(rd, u64(~(a ^ b))); return true; // xnor
          default: return false;
        }
      case 0x14: // bset
        if (funct3 === 1) {
          this.setX(rd, a | (1n << (b & 63n)));
          return true;
        }
        return false;
      case 0x24: // bclr/bext
        switch (funct3) {
          case 1: this.setX(rd, a & ~(1n << (b & 63n))); return true;
          case 5: this.setX(rd, (a >> (b & 63n)) & 1n); return true;
          default: return false;
        }
      case 0x34: // binv
        if (funct3 === 1) {
          this.setX(rd, a ^ (1n << (b & 63n)));
          return true;
        }
        return false;
      default: return false;
    }
  }
  // ---- 0x3b：字半宽（*W 结果符号扩展；*.uw 结果 64 位） ----
  const ua = a & 0xffffffffn;
  switch (funct7) {
    case 0x04: // add.uw / zext.h
      switch (funct3) {
        case 0: this.setX(rd, ua + b); return true; // add.uw
        case 4:
          if (rs2 === 0) {
            this.setX(rd, ua & 0xffffn); // zext.h：零扩展低 16 位
            return true;
          }
          return false;
        default: return false;
      }
    case 0x10: // sh1add.uw/sh2add.uw/sh3add.uw
      switch (funct3) {
        case 2: this.setX(rd, (ua << 1n) + b); return true;
        case 4: this.setX(rd, (ua << 2n) + b); return true;
        case 6: this.setX(rd, (ua << 3n) + b); return true;
        default: return false;
      }
    case 0x30: // rolw/rorw（clzw/ctzw/cpopw 在 OP-IMM-32，不在这）
      switch (funct3) {
        case 1: { // rolw
          const n = b & 31n;
          this.setX(rd, s32(n === 0n ? ua : ((ua << n) | (ua >> (32n - n))) & 0xffffffffn));
          return true;
        }
        case 5: { // rorw
          const n = b & 31n;
          this.setX(rd, s32(n === 0n ? ua : ((ua >> n) | ((ua << (32n - n)) & 0xffffffffn))));
          return true;
        }
        default: return false;
      }
    default: return false;
  }
}

  // ------------------------------------------------------------------
  // 访存
  // ------------------------------------------------------------------

  private loadMem(addr: bigint, size: MemSize): bigint | null {
    this.stats.loads++;
    if ((addr & BigInt(size - 1)) !== 0n) {
      if (this.misaligned === 'trap') {
        this.takeException(Exc.LoadAddrMisaligned, addr);
        return null;
      }
      let v = 0n;
      for (let i = 0; i < size; i++) {
        const b = this.mmu.load(addr + BigInt(i), 1);
        if (b === null) {
          this.takeException(this.mmu.faultCause, this.mmu.faultTval);
          return null;
        }
        v |= b << BigInt(8 * i);
      }
      return v;
    }
    const v = this.mmu.load(addr, size);
    if (v === null) {
      this.takeException(this.mmu.faultCause, this.mmu.faultTval);
      return null;
    }
    return v;
  }

  private storeMem(addr: bigint, value: bigint, size: MemSize): void {
    this.stats.stores++;
    if ((addr & BigInt(size - 1)) !== 0n) {
      if (this.misaligned === 'trap') {
        this.takeException(Exc.StoreAddrMisaligned, addr);
        return;
      }
      for (let i = 0; i < size; i++) {
        if (!this.mmu.store(addr + BigInt(i), (value >> BigInt(8 * i)) & 0xffn, 1)) {
          this.takeException(this.mmu.faultCause, this.mmu.faultTval);
          return;
        }
      }
      return;
    }
    if (!this.mmu.store(addr, value, size)) {
      this.takeException(this.mmu.faultCause, this.mmu.faultTval);
    }
  }

  // ------------------------------------------------------------------
  // AMO
  // ------------------------------------------------------------------

  private execAmo(inst: number, rd: number, funct3: number, rs1: number, rs2: number): void {
    this.stats.amo++;
    const funct5 = (inst >>> 27) & 0x1f;
    const addr = this.x[rs1] & MASK64;
    const isDouble = funct3 === 3;

    if (funct5 === 0x02) {
      // LR.W / LR.D
      if (rs2 !== 0) return this.illegal(inst);
      const size: MemSize = isDouble ? 8 : 4;
      if ((addr & BigInt(size - 1)) !== 0n) {
        this.takeException(Exc.LoadAddrMisaligned, addr);
        return;
      }
      const v = this.loadMem(addr, size);
      if (v === null) return;
      this.reserved = true;
      this.reservedAddr = addr;
      this.setX(rd, isDouble ? v : sext(v, 32));
      return;
    }

    if (funct5 === 0x03) {
      // SC.W / SC.D
      const size: MemSize = isDouble ? 8 : 4;
      if ((addr & BigInt(size - 1)) !== 0n) {
        this.takeException(Exc.StoreAddrMisaligned, addr);
        return;
      }
      const ok = this.reserved && this.reservedAddr === addr;
      if (ok) {
        this.storeMem(addr, this.x[rs2], size);
        this.reserved = false;
      } else {
        this.reserved = false;
      }
      this.setX(rd, ok ? 0n : 1n);
      return;
    }

    const size: MemSize = isDouble ? 8 : 4;
    if ((addr & BigInt(size - 1)) !== 0n) {
      this.takeException(Exc.StoreAddrMisaligned, addr);
      return;
    }
    const old = this.loadMem(addr, size);
    if (old === null) return;
    const a = isDouble ? old : sext(old, 32);
    const b = isDouble ? this.x[rs2] : sext(this.x[rs2], 32);
    let r: bigint;
    switch (funct5) {
      case 0x01: r = b; break; // AMOSWAP
      case 0x00: r = a + b; break; // AMOADD
      case 0x04: r = a ^ b; break; // AMOXOR
      case 0x08: r = a | b; break; // AMOOR
      case 0x0c: r = a & b; break; // AMOAND
      case 0x10: r = s64(a) < s64(b) ? a : b; break; // AMOMIN
      case 0x14: r = s64(a) > s64(b) ? a : b; break; // AMOMAX
      case 0x18: r = a < b ? a : b; break; // AMOMINU
      case 0x1c: r = a > b ? a : b; break; // AMOMAXU
      default: return this.illegal(inst);
    }
    this.storeMem(addr, isDouble ? r & MASK64 : r & 0xffffffffn, size);
    this.setX(rd, a);
  }

  // ------------------------------------------------------------------
  // SYSTEM：CSR / 特权指令
  // ------------------------------------------------------------------

  private execSystem(inst: number, rd: number, funct3: number, rs1: number): void {
    if (funct3 !== 0) {
      this.execCsr(inst, rd, funct3, rs1);
      return;
    }
    // SFENCE.VMA 的编码是 funct7=0x09 拼上 rs2 字段（funct12 = 0x120 | rs2），
    // 其中 rs2 指定 ASID 寄存器。因此**不能**用完整的 12 位 funct12 去 switch：
    // 那样只有 rs2=0 的 `sfence.vma` 能匹配 0x120，而内核在 execve 搬移栈页表时
    // 发出的 `sfence.vma addr, asid`（如 rs2=a6 → funct12=0x130）会被误判为非法指令。
    // 必须先按 funct7 识别，把 rs2 当参数取。
    if ((inst >>> 25) === 0x09) { // SFENCE.VMA
      if (this.priv < Priv.S) return this.illegal(inst);
      const mstatus = this.csr.raw(CSR.MSTATUS);
      if (this.priv === Priv.S && (mstatus & (1n << 20n)) !== 0n) return this.illegal(inst); // TVM
      const rs2 = (inst >>> 20) & 0x1f;
      const vaddr = rs1 === 0 ? undefined : this.x[rs1];
      const asid = rs2 === 0 ? undefined : Number(this.x[rs2]! & 0xffffn);
      this.mmu.flushBy(vaddr, asid);
      return;
    }

    const imm = (inst >>> 20) & 0xfff;
    switch (imm) {
      case 0x000: { // ECALL
        const cause =
          this.priv === Priv.M ? Exc.EnvCallFromM : this.priv === Priv.S ? Exc.EnvCallFromS : Exc.EnvCallFromU;
        this.takeException(cause, 0n);
        return;
      }
      case 0x001: // EBREAK
        this.takeException(Exc.Breakpoint, this.pc);
        return;
      case 0x102: { // SRET
        if (this.priv < Priv.S) return this.illegal(inst);
        const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
        if (this.priv === Priv.S && (mstatus & (1n << 22n)) !== 0n) return this.illegal(inst); // TSR
        const spp = (mstatus & SR_SPP) !== 0n ? Priv.S : Priv.U;
        const spie = (mstatus & SR_SPIE) !== 0n;
        let next = mstatus & ~SR_SPP & ~SR_SPIE & ~SR_SIE & ~SR_MPRV;
        if (spie) next |= SR_SIE;
        this.csr.writeRaw(CSR.MSTATUS, next);
        this.priv = spp;
        this.nextPc = this.csr.read(CSR.SEPC) ?? 0n;
        this.mmu.flush();
        return;
      }
      case 0x302: { // MRET
        if (this.priv < Priv.M) return this.illegal(inst);
        const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
        const mpp = Number((mstatus & SR_MPP) >> 11n) as PrivLevel;
        const mpie = (mstatus & SR_MPIE) !== 0n;
        let next = mstatus & ~SR_MPP & ~SR_MPIE & ~SR_MIE & ~SR_MPRV;
        if (mpie) next |= SR_MIE;
        if (mpp !== Priv.M) next &= ~SR_MPRV;
        this.csr.writeRaw(CSR.MSTATUS, next);
        this.priv = mpp;
        this.nextPc = this.csr.read(CSR.MEPC) ?? 0n;
        this.mmu.flush();
        return;
      }
      case 0x105: { // WFI
        if (this.priv === Priv.U) return this.illegal(inst);
        this.wfi = true;
        return;
      }
      // 注意：SFENCE.VMA（funct7=0x09）已在上面按 funct7 处理，
      // 不能放在这里按 funct12 匹配，否则带 ASID 的形式会漏判。
      default:
        return this.illegal(inst);
    }
  }

  private execCsr(inst: number, rd: number, funct3: number, rs1: number): void {
    const csrAddr = (inst >>> 20) & 0xfff;
    const uimm = rs1; // CSR 立即数形式使用 rs1 字段作为 5 位零扩展立即数
    const isImm = (funct3 & 0x4) !== 0;
    const writeVal = isImm ? BigInt(uimm) : this.x[rs1];

    if (!this.csr.canRead(csrAddr, this.priv)) return this.illegal(inst);

    const old = this.csr.read(csrAddr);
    if (old === null) return this.illegal(inst);

    let doWrite = false;
    if (funct3 === 1 || funct3 === 5) doWrite = true; // CSRRW / CSRRWI
    else doWrite = isImm ? uimm !== 0 : rs1 !== 0; // CSRRS/I, CSRRC/I

    if (doWrite && !this.csr.canWrite(csrAddr, this.priv)) return this.illegal(inst);

    if (doWrite) {
      let next: bigint;
      switch (funct3) {
        case 1:
        case 5:
          next = writeVal;
          break;
        case 2:
        case 6:
          next = old | writeVal;
          break;
        case 3:
        case 7:
          next = old & ~writeVal;
          break;
        default:
          return this.illegal(inst);
      }
      this.csr.writeRaw(csrAddr, next & MASK64);
      if (csrAddr === CSR.SATP || csrAddr === CSR.MSTATUS) this.mmu.flush();
    }
    this.setX(rd, old);
  }

  // ------------------------------------------------------------------
  // 浮点子系统
  // ------------------------------------------------------------------

  private get frm(): number {
    const fcsr = this.csr.read(CSR.FCSR) ?? 0n;
    const rm = Number((fcsr >> 5n) & 0x7n);
    return rm === RM.DYN ? RM.RNE : rm;
  }

  private setFflags(f: number): void {
    if (f === 0) return;
    const fcsr = this.csr.read(CSR.FCSR) ?? 0n;
    this.csr.writeRaw(CSR.FCSR, fcsr | BigInt(f & 0x1f));
  }

  private checkFp(): boolean {
    const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
    if ((mstatus & SR_FS) === 0n) return false;
    if ((mstatus & SR_FS) !== SR_FS) this.csr.writeRaw(CSR.MSTATUS, mstatus | SR_FS);
    this.stats.fp++;
    return true;
  }

  private fRs(single: boolean, idx: number): number {
    return single ? unboxF32(this.f[idx]) : bitsToF64(this.f[idx]);
  }

  private execFp(
    inst: number,
    opcode: number,
    rd: number,
    funct3: number,
    rs1: number,
    rs2: number,
    funct7: number,
  ): void {
    if (!this.checkFp()) return this.illegal(inst);

    // ---- 访存类 ----
    if (opcode === 0x07 || opcode === 0x27) {
      const addr = u64(this.x[rs1] + (opcode === 0x07 ? immI(inst) : immS(inst)));
      const size: MemSize = funct3 === 2 ? 4 : 8;
      if (funct3 !== 2 && funct3 !== 3) return this.illegal(inst);
      if (opcode === 0x07) {
        const v = this.loadMem(addr, size);
        if (v === null) return;
        this.setF(rd, size === 4 ? f32Box(rawF32(v)) : v);
      } else {
        this.storeMem(addr, this.f[rs2], size);
      }
      return;
    }

    const rmField = funct3;
    const rm = rmField === RM.DYN ? this.frm : rmField;

    // 融合乘加
    if (opcode === 0x43 || opcode === 0x47 || opcode === 0x4b || opcode === 0x4f) {
      const isSingle = (funct7 & 0x3) === 0; // 00=S, 01=D
      const a = this.fRs(isSingle, rs1);
      const b = this.fRs(isSingle, rs2);
      const c = this.fRs(isSingle, rs3Field(inst));
      let v: number;
      switch (opcode) {
        case 0x43: v = a * b + c; break;
        case 0x47: v = a * b - c; break;
        case 0x4b: v = -(a * b - c); break;
        default: v = -(a * b + c); break;
      }
      const r = roundResult(v, isSingle, rm);
      this.setFflags(flagsForResult(v, r, isSingle, 0));
      this.setF(rd, isSingle ? f32Box(r) : f64Box(r));
      return;
    }

    const rs2i = rs2;

    // ---- 单 / 双精度算术（funct7 低 2 位 fmt：00=S, 01=D） ----
    const fmt = funct7 & 0x03; // 0: S, 1: D
    const isS = fmt === 0;
    const opA = this.fRs(isS, rs1);
    const opB = this.fRs(isS, rs2i);
    const base = funct7 & ~0x03;

    switch (base) {
      case 0x00: { // FADD
        const v = opA + opB;
        const r = roundResult(v, isS, rm);
        this.setFflags(flagsForResult(v, r, isS, fcmpFlags(opA, opB)));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x04: { // FSUB
        const v = opA - opB;
        const r = roundResult(v, isS, rm);
        this.setFflags(flagsForResult(v, r, isS, fcmpFlags(opA, opB)));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x08: { // FMUL
        const v = opA * opB;
        const r = roundResult(v, isS, rm);
        let flags = fcmpFlags(opA, opB);
        if ((isInf(opA) && opB === 0) || (isInf(opB) && opA === 0)) flags |= FFLAG.NV;
        this.setFflags(flagsForResult(v, r, isS, flags));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x0c: { // FDIV
        let flags = fcmpFlags(opA, opB);
        const v = opB === 0 ? (opA === 0 || Number.isNaN(opA) ? NaN : (Object.is(opA, -0) || opA < 0 ? -Infinity : Infinity)) : opA / opB;
        if (opB === 0 && opA !== 0 && !Number.isNaN(opA)) flags |= FFLAG.DZ;
        if (opB === 0 && opA === 0) flags |= FFLAG.NV;
        const r = roundResult(v, isS, rm);
        this.setFflags(flagsForResult(v, r, isS, flags));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x10: { // FSGNJ / FSGNJN / FSGNJX：直接操作位模式，保留 NaN payload
        if (funct3 > 2) return this.illegal(inst);
        const signPos = isS ? 31n : 63n;
        const aBits = isS ? this.f[rs1] & 0xffffffffn : this.f[rs1];
        const bBits = isS ? this.f[rs2i] & 0xffffffffn : this.f[rs2i];
        const signA = (aBits >> signPos) & 1n;
        const signB = (bBits >> signPos) & 1n;
        const newSign = funct3 === 0 ? signB : funct3 === 1 ? 1n - signB : signA ^ signB;
        const rBits = (aBits & ~(1n << signPos)) | (newSign << signPos);
        this.setF(rd, isS ? (rBits | 0xffffffff00000000n) : rBits);
        return;
      }
      case 0x14: { // FMIN / FMAX
        const r = fminMax(funct3 === 1, opA, opB);
        this.setFflags(fcmpFlags(opA, opB));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x2c: { // FSQRT
        let flags = 0;
        const v = opA < 0 && !Number.isNaN(opA) ? NaN : Math.sqrt(opA);
        if (opA < 0 && opA !== 0) flags |= FFLAG.NV;
        const r = roundResult(v, isS, rm);
        this.setFflags(flagsForResult(v, r, isS, flags));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x20: { // FCVT.S.D / FCVT.D.S
        if (rs2i !== (isS ? 1 : 0)) return this.illegal(inst);
        const r = roundResult(isS ? Math.fround(opA) : opA, isS, rm);
        this.setFflags(flagsForResult(opA, r, isS, 0));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x50: { // FLE / FLT / FEQ
        let res = 0;
        const flags = fcmpFlags(opA, opB);
        if (!Number.isNaN(opA) && !Number.isNaN(opB)) {
          res = funct3 === 0 ? Number(opA <= opB) : funct3 === 1 ? Number(opA < opB) : Number(opA === opB);
        }
        this.setFflags(flags);
        this.setX(rd, BigInt(res));
        return;
      }
      case 0x60: { // FCVT.W.* / FCVT.WU.* / FCVT.L.* / FCVT.LU.*
        // 目标宽度由 rs2 字段选择：0=W 1=WU 2=L 3=LU，funct3 是舍入模式
        if (rs2i > 3) return this.illegal(inst);
        this.fpToInt(rd, rs2i, opA, rm);
        return;
      }
      case 0x68: { // FCVT.S.* / FCVT.D.*（整数 → 浮点）
        const src = this.x[rs1];
        let v: number;
        switch (rs2i) {
          case 0: v = Number(s32(src)); break; // W
          case 1: v = Number(src & 0xffffffffn); break; // WU
          case 2: v = Number(s64(src)); break; // L
          case 3: v = Number(src & MASK64); break; // LU
          default: return this.illegal(inst);
        }
        const r = roundResult(v, isS, rm);
        this.setFflags(flagsForResult(v, r, isS, 0));
        this.setF(rd, isS ? f32Box(r) : f64Box(r));
        return;
      }
      case 0x70: { // FMV.X.W / FMV.X.D / FCLASS
        if (rs2i !== 0) return this.illegal(inst);
        if (funct3 === 1) {
          this.setX(rd, BigInt(fclassOfBits(this.f[rs1], isS)));
        } else if (isS) {
          this.setX(rd, sext(this.f[rs1] & 0xffffffffn, 32));
        } else {
          this.setX(rd, this.f[rs1]);
        }
        return;
      }
      case 0x78: { // FMV.W.X / FMV.D.X
        if (rs2i !== 0 || funct3 !== 0) return this.illegal(inst);
        this.setF(rd, isS ? (this.x[rs1] & 0xffffffffn) | 0xffffffff00000000n : this.x[rs1] & MASK64);
        return;
      }
      default:
        return this.illegal(inst);
    }
  }

  /** FCVT.*.W / WU / L / LU：sel = 0/1/2/3 */
  private fpToInt(rd: number, sel: number, src: number, rm: number): void {
    const is64 = sel >= 2;
    const isUnsigned = sel === 1 || sel === 3;
    let flags = 0;
    if (Number.isNaN(src)) {
      flags |= FFLAG.NV;
      this.setFflags(flags);
      this.setX(rd, isUnsigned ? (is64 ? MASK64 : 0xffffffffn) : is64 ? 0x7fffffffffffffffn : 0x7fffffffn);
      return;
    }
    const r = roundToMode(src, rm);
    if (Number.isFinite(r) && r !== src) flags |= FFLAG.NX;
    const maxS = isUnsigned ? (is64 ? 2n ** 64n - 1n : 0xffffffffn) : is64 ? 2n ** 63n - 1n : 0x7fffffffn;
    const minS = isUnsigned ? 0n : is64 ? -(2n ** 63n) : -0x80000000n;
    let big: bigint;
    if (Number.isFinite(r)) {
      big = BigInt(r);
    } else {
      big = r > 0 ? maxS : minS;
      flags |= FFLAG.NV;
    }
    if (big > maxS) {
      big = maxS;
      flags |= FFLAG.NV;
    } else if (big < minS) {
      big = minS;
      flags |= FFLAG.NV;
    }
    if (is64) this.setX(rd, big & MASK64);
    else this.setX(rd, sext(big & 0xffffffffn, 32));
    this.setFflags(flags);
  }

  // ------------------------------------------------------------------
  // 压缩指令（RVC）
  // ------------------------------------------------------------------

  private execCompressed(inst: number): void {
    const op = inst & 0x3;
    const funct3 = (inst >> 13) & 0x7;
    const rdFull = (inst >> 7) & 0x1f;
    const rs2Full = (inst >> 2) & 0x1f;
    const rdp = 8 + ((inst >> 2) & 0x7);
    const rs1p = 8 + ((inst >> 7) & 0x7);
    const rs2p = 8 + ((inst >> 2) & 0x7);

    switch (op) {
      case 0: {
        switch (funct3) {
          case 0: {
            // C.ADDI4SPN: rd' = rs2', nzimm = inst[10:7|12:11|5|6] << 2
            const nzimm =
              (((inst >> 7) & 0xf) << 6) | (((inst >> 11) & 0x3) << 4) | (((inst >> 5) & 0x1) << 3) | (((inst >> 6) & 0x1) << 2);
            if (nzimm === 0) return this.illegal(inst);
            this.setX(rdp, u64(this.x[2] + BigInt(nzimm)));
            return;
          }
          case 1: {
            // C.FLD（RV64）：uimm[5:3]=inst[12:10]，uimm[7:6]=inst[6:5]
            if (!this.checkFp()) return this.illegal(inst);
            const off = (((inst >> 10) & 0x7) << 3) | (((inst >> 5) & 0x3) << 6);
            const v = this.loadMem(u64(this.x[rs1p] + BigInt(off)), 8);
            if (v === null) return;
            this.setF(rdp, v); // rdp = 8 + inst[4:2] → f8..f15
            return;
          }
          case 2: {
            // C.LW
            const off = (((inst >> 5) & 0x1) << 6) | (((inst >> 10) & 0x7) << 3) | (((inst >> 6) & 0x1) << 2);
            const addr = u64(this.x[rs1p] + BigInt(off));
            const v = this.loadMem(addr, 4);
            if (v === null) return;
            this.setX(rdp, sext(v, 32));
            return;
          }
          case 5: {
            // C.FSD（RV64）
            if (!this.checkFp()) return this.illegal(inst);
            const off = (((inst >> 10) & 0x7) << 3) | (((inst >> 5) & 0x3) << 6);
            this.storeMem(u64(this.x[rs1p] + BigInt(off)), this.f[rs2p]!, 8);
            return;
          }
          case 3: {
            // C.LD
            const off = (((inst >> 10) & 0x7) << 3) | (((inst >> 5) & 0x3) << 6);
            const addr = u64(this.x[rs1p] + BigInt(off));
            const v = this.loadMem(addr, 8);
            if (v === null) return;
            this.setX(rdp, v);
            return;
          }
          case 6: {
            // C.SW
            const off = (((inst >> 5) & 0x1) << 6) | (((inst >> 10) & 0x7) << 3) | (((inst >> 6) & 0x1) << 2);
            this.storeMem(u64(this.x[rs1p] + BigInt(off)), this.x[rs2p], 4);
            return;
          }
          case 7: {
            // C.SD
            const off = (((inst >> 10) & 0x7) << 3) | (((inst >> 5) & 0x3) << 6);
            this.storeMem(u64(this.x[rs1p] + BigInt(off)), this.x[rs2p], 8);
            return;
          }
          default:
            return this.illegal(inst);
        }
      }
      case 1: {
        switch (funct3) {
          case 0: {
            // C.NOP / C.ADDI
            const imm = sext(BigInt(((inst >> 12) & 0x1) << 5 | rs2Full), 6);
            if (rdFull === 0) return;
            this.setX(rdFull, u64(this.x[rdFull] + imm));
            return;
          }
          case 1: {
            // C.ADDIW
            const imm = sext(BigInt(((inst >> 12) & 0x1) << 5 | rs2Full), 6);
            if (rdFull === 0) return this.illegal(inst);
            this.setX(rdFull, s32(u64(this.x[rdFull] + imm)));
            return;
          }
          case 2: {
            // C.LI
            const imm = sext(BigInt(((inst >> 12) & 0x1) << 5 | rs2Full), 6);
            if (rdFull === 0) return;
            this.setX(rdFull, u64(imm));
            return;
          }
          case 3: {
            if (rdFull === 2) {
              // C.ADDI16SP：nzimm 为 10 位有符号、低 4 位为 0
              const nzimm =
                (((inst >> 12) & 0x1) << 9) | (((inst >> 3) & 0x3) << 7) | (((inst >> 5) & 0x1) << 6) |
                (((inst >> 2) & 0x1) << 5) | (((inst >> 6) & 0x1) << 4);
              this.setX(2, u64(this.x[2] + sext(BigInt(nzimm), 10)));
            } else {
              // C.LUI
              if (rdFull === 0) return;
              this.setX(rdFull, sext(BigInt(((inst >> 12) & 0x1) << 17 | (rs2Full << 12)), 18));
            }
            return;
          }
          case 4: {
            const sub = (inst >> 10) & 0x3;
            switch (sub) {
              case 0: {
                const sh = BigInt((((inst >> 12) & 0x1) << 5) | rs2Full);
                if (sh === 0n) return;
                this.setX(rs1p, u64(this.x[rs1p] >> sh));
                return;
              }
              case 1: {
                const sh = BigInt((((inst >> 12) & 0x1) << 5) | rs2Full);
                if (sh === 0n) return;
                this.setX(rs1p, u64(s64(this.x[rs1p]) >> sh));
                return;
              }
              case 2: {
                const imm = sext(BigInt(((inst >> 12) & 0x1) << 5 | rs2Full), 6);
                this.setX(rs1p, this.x[rs1p] & imm & MASK64);
                return;
              }
              case 3: {
                const bit12 = (inst >> 12) & 0x1;
                const bits65 = (inst >> 5) & 0x3;
                const rs2c = 8 + ((inst >> 2) & 0x7);
                const rd1 = 8 + ((inst >> 7) & 0x7);
                switch (`${bit12}${bits65}`) {
                  case '00': this.setX(rd1, u64(this.x[rd1] - this.x[rs2c])); return; // C.SUB
                  case '01': this.setX(rd1, this.x[rd1] ^ this.x[rs2c]); return; // C.XOR
                  case '02': this.setX(rd1, this.x[rd1] | this.x[rs2c]); return; // C.OR
                  case '03': this.setX(rd1, this.x[rd1] & this.x[rs2c]); return; // C.AND
                  case '10': this.setX(rd1, s32(u64(this.x[rd1] - this.x[rs2c]))); return; // C.SUBW
                  case '11': this.setX(rd1, s32(u64(this.x[rd1] + this.x[rs2c]))); return; // C.ADDW
                  default: return this.illegal(inst);
                }
              }
            }
            return;
          }
          case 5: {
            // C.J
            const off = cJumpImm(inst);
            this.nextPc = u64(this.pc + off);
            return;
          }
          case 6:
          case 7: {
            // C.BEQZ / C.BNEZ
            const off = cBranchImm(inst);
            const rs1c = 8 + ((inst >> 7) & 0x7);
            const v = this.x[rs1c];
            const take = funct3 === 6 ? v === 0n : v !== 0n;
            if (take) this.nextPc = u64(this.pc + off);
            return;
          }
        }
        return;
      }
      case 2: {
        switch (funct3) {
          case 0: {
            // C.SLLI
            const sh = BigInt((((inst >> 12) & 0x1) << 5) | rs2Full);
            if (sh === 0n) return;
            this.setX(rdFull, u64(this.x[rdFull] << sh));
            return;
          }
          case 1: {
            // C.FLDSP（RV64）：uimm[4:3]=inst[6:5]，uimm[5]=inst[12]，uimm[8:6]=inst[4:2]
            if (!this.checkFp()) return this.illegal(inst);
            const off = (((inst >> 2) & 0x7) << 6) | (((inst >> 12) & 0x1) << 5) | (((inst >> 5) & 0x3) << 3);
            const v = this.loadMem(u64(this.x[2] + BigInt(off)), 8);
            if (v === null) return;
            this.setF(rdFull, v);
            return;
          }
          case 5: {
            // C.FSDSP（RV64）：uimm[5:3]=inst[12:10]，uimm[8:6]=inst[9:7]
            if (!this.checkFp()) return this.illegal(inst);
            const off = (((inst >> 7) & 0x7) << 6) | (((inst >> 10) & 0x7) << 3);
            this.storeMem(u64(this.x[2] + BigInt(off)), this.f[rs2Full]!, 8);
            return;
          }
          case 2: {
            // C.LWSP
            const off = (((inst >> 2) & 0x3) << 6) | (((inst >> 12) & 0x1) << 5) | (((inst >> 4) & 0x7) << 2);
            const v = this.loadMem(u64(this.x[2] + BigInt(off)), 4);
            if (v === null) return;
            if (rdFull === 0) return this.illegal(inst);
            this.setX(rdFull, sext(v, 32));
            return;
          }
          case 3: {
            // C.LDSP
            const off = (((inst >> 2) & 0x7) << 6) | (((inst >> 12) & 0x1) << 5) | (((inst >> 5) & 0x3) << 3);
            const v = this.loadMem(u64(this.x[2] + BigInt(off)), 8);
            if (v === null) return;
            if (rdFull === 0) return this.illegal(inst);
            this.setX(rdFull, v);
            return;
          }
          case 4: {
            const bit12 = (inst >> 12) & 0x1;
            if (bit12 === 0) {
              if (rs2Full === 0) {
                // C.JR
                if (rdFull === 0) return this.illegal(inst);
                this.nextPc = u64(this.x[rdFull] & ~0x1n);
              } else {
                // C.MV
                if (rdFull === 0) return;
                this.setX(rdFull, this.x[rs2Full]);
              }
            } else {
              if (rdFull === 0 && rs2Full === 0) {
                this.takeException(Exc.Breakpoint, this.pc);
              } else if (rs2Full === 0) {
                // C.JALR
                const target = u64(this.x[rdFull] & ~0x1n);
                this.setX(1, u64(this.pc + 2n));
                this.nextPc = target;
              } else {
                // C.ADD
                this.setX(rdFull, u64(this.x[rdFull] + this.x[rs2Full]));
              }
            }
            return;
          }
          case 6: {
            // C.SWSP
            const off = (((inst >> 7) & 0x3) << 6) | (((inst >> 9) & 0xf) << 2);
            this.storeMem(u64(this.x[2] + BigInt(off)), this.x[rs2Full], 4);
            return;
          }
          case 7: {
            // C.SDSP
            const off = (((inst >> 7) & 0x7) << 6) | (((inst >> 10) & 0x7) << 3);
            this.storeMem(u64(this.x[2] + BigInt(off)), this.x[rs2Full], 8);
            return;
          }
          default:
            return this.illegal(inst);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 异常与中断
  // ------------------------------------------------------------------

  private illegal(inst: number): void {
    // 调试钩子：定位模拟器缺失的指令。异常发生瞬间即上报，
    // 不必等内核走完 Oops 流程再从 badaddr 反推。
    this.onIllegal?.(this.pc, inst >>> 0, this.priv);
    // 规范允许 mtval/stval 存放触发异常的指令编码；真机与 QEMU 都这么做，
    // 内核 Oops 的 badaddr 字段依赖它，便于定位缺失指令。
    this.takeException(Exc.IllegalInstruction, BigInt(inst >>> 0));
  }

  /** 同步异常入口 */
  takeException(cause: number, tval: bigint): void {
    this.onTrap?.(cause, tval, this.pc, this.priv);
    const medeleg = this.csr.read(CSR.MEDELEG) ?? 0n;
    const toM = this.priv === Priv.M || (medeleg & (1n << BigInt(cause))) === 0n;
    this.stats.traps++;
    this.trapTaken = true;
    if (toM) {
      this.csr.writeRaw(CSR.MEPC, this.pc & MASK64);
      this.csr.writeRaw(CSR.MCAUSE, BigInt(cause));
      this.csr.writeRaw(CSR.MTVAL, tval & MASK64);
      const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
      let next = mstatus & ~SR_MIE & ~SR_MPP & ~SR_MPIE & ~SR_MPRV;
      if ((mstatus & SR_MIE) !== 0n) next |= SR_MPIE;
      next |= BigInt(this.priv) << 11n;
      this.csr.writeRaw(CSR.MSTATUS, next);
      this.priv = Priv.M;
      this.pc = (this.csr.read(CSR.MTVEC) ?? 0n) & ~0x3n;
    } else {
      this.csr.writeRaw(CSR.SEPC, this.pc & MASK64);
      this.csr.writeRaw(CSR.SCAUSE, BigInt(cause));
      this.csr.writeRaw(CSR.STVAL, tval & MASK64);
      const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
      let next = mstatus & ~SR_SIE & ~SR_SPP & ~SR_SPIE;
      if ((mstatus & SR_SIE) !== 0n) next |= SR_SPIE;
      next |= (BigInt(this.priv) & 0x1n) << 8n;
      next &= ~SR_MPRV;
      this.csr.writeRaw(CSR.MSTATUS, next);
      this.priv = Priv.S;
      this.pc = (this.csr.read(CSR.STVEC) ?? 0n) & ~0x3n;
    }
    this.wfi = false;
    this.mmu.flush();
  }

  /** 中断优先级：外部 > 软件 > 定时器，高特权级优先 */
  private static readonly IRQ_PRIORITY = [11, 3, 7, 9, 1, 5, 8, 0, 4];
  /** IRQ_PRIORITY 对应的位掩码，预计算避免热路径构造 BigInt */
  private static readonly IRQ_PRIORITY_BITS = Cpu.IRQ_PRIORITY.map((n) => 1n << BigInt(n));

  /**
   * 检查并投递中断，返回 true 表示本周期已陷入。
   *
   * 热路径优化：绝大多数指令没有「已使能且已挂起」的中断，因此先用
   * mie/mip 两次原始直读做早退，只有真正可能投递时才读 mstatus/mideleg。
   * mie / mip / mideleg 均无 read 钩子；mstatus 的 read 钩子只合成 SD 位，
   * 而本函数只关心 MIE(3) / SIE(1)，故四者都可安全 raw 直读。
   */
  private checkInterrupts(): boolean {
    const mie = this.csr.raw(CSR.MIE);
    if (mie === 0n) return false;
    const mip = this.csr.raw(CSR.MIP);
    const pending = mie & mip;
    if (pending === 0n) return false;

    const mstatus = this.csr.raw(CSR.MSTATUS);
    const mideleg = this.csr.raw(CSR.MIDELEG);
    const prio = Cpu.IRQ_PRIORITY;
    const bits = Cpu.IRQ_PRIORITY_BITS;
    for (let i = 0; i < prio.length; i++) {
      const irq = prio[i]!;
      const bit = bits[i]!;
      if ((pending & bit) === 0n) continue;
      const delegated = (mideleg & bit) !== 0n;
      const toM = this.priv === Priv.M || !delegated;

      if (toM) {
        if (this.priv === Priv.M && (mstatus & SR_MIE) === 0n) return false;
        this.trapInterrupt(irq, Priv.M);
        return true;
      }
      // 陷入 S 模式（当前特权级 < M）
      if (this.priv === Priv.S && (mstatus & SR_SIE) === 0n) continue;
      this.trapInterrupt(irq, Priv.S);
      return true;
    }
    return false;
  }

  private trapInterrupt(irq: number, target: PrivLevel): void {
    this.onInterrupt?.(irq, target);
    this.stats.traps++;
    this.trapTaken = true;
    this.wfi = false;
    const cause = BigInt(irq) | INTERRUPT_FLAG;
    if (target === Priv.M) {
      this.csr.writeRaw(CSR.MEPC, this.pc & MASK64);
      this.csr.writeRaw(CSR.MCAUSE, cause);
      this.csr.writeRaw(CSR.MTVAL, 0n);
      const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
      let next = mstatus & ~SR_MIE & ~SR_MPP & ~SR_MPIE & ~SR_MPRV;
      if ((mstatus & SR_MIE) !== 0n) next |= SR_MPIE;
      next |= BigInt(this.priv) << 11n;
      this.csr.writeRaw(CSR.MSTATUS, next);
      this.priv = Priv.M;
      const mtvec = this.csr.read(CSR.MTVEC) ?? 0n;
      this.pc = (mtvec & 0x1n) !== 0n ? (mtvec & ~0x3n) + BigInt(irq) * 4n : mtvec & ~0x3n;
    } else {
      this.csr.writeRaw(CSR.SEPC, this.pc & MASK64);
      this.csr.writeRaw(CSR.SCAUSE, cause);
      this.csr.writeRaw(CSR.STVAL, 0n);
      const mstatus = this.csr.read(CSR.MSTATUS) ?? 0n;
      let next = mstatus & ~SR_SIE & ~SR_SPP & ~SR_SPIE;
      if ((mstatus & SR_SIE) !== 0n) next |= SR_SPIE;
      next |= (BigInt(this.priv) & 0x1n) << 8n;
      this.csr.writeRaw(CSR.MSTATUS, next);
      this.priv = Priv.S;
      const stvec = this.csr.read(CSR.STVEC) ?? 0n;
      this.pc = (stvec & 0x1n) !== 0n ? (stvec & ~0x3n) + BigInt(irq) * 4n : stvec & ~0x3n;
    }
  }

  /** 请求停机（sifive_test / SBI shutdown 使用） */
  halt(reason: string, code = 0): void {
    this.halted = true;
    this.haltReason = reason;
    this.exitCode = code;
  }

  /** 调试：寄存器快照 */
  dumpRegisters(): string {
    const names = [
      'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
      'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3',
      's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
    ];
    const lines: string[] = [];
    for (let i = 0; i < 32; i++) {
      if (i === 0) continue;
      lines.push(`x${String(i).padStart(2, '0')} ${names[i].padEnd(4)} = ${this.x[i].toString(16).padStart(16, '0')}`);
    }
    return lines.join('\n');
  }
}

// ----------------------------------------------------------------------
// 辅助：字段与立即数
// ----------------------------------------------------------------------

function rs3Field(inst: number): number {
  return (inst >>> 27) & 0x1f;
}

/** 按舍入模式把浮点值舍入为整数（double 域） */
function roundToMode(v: number, rm: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return v;
  switch (rm) {
    case RM.RTZ:
      return Math.trunc(v);
    case RM.RDN:
      return Math.floor(v);
    case RM.RUP:
      return Math.ceil(v);
    case RM.RMM: {
      const f = Math.floor(v);
      const diff = v - f;
      return diff > 0.5 ? f + 1 : diff < 0.5 ? f : v > 0 ? f + 1 : f;
    }
    default:
      return Math.round(v);
  }
}

function cJumpImm(inst: number): bigint {
  const v =
    (((inst >> 12) & 0x1) << 11) | (((inst >> 8) & 0x1) << 10) | (((inst >> 9) & 0x3) << 8) |
    (((inst >> 6) & 0x1) << 7) | (((inst >> 7) & 0x1) << 6) | (((inst >> 2) & 0x1) << 5) |
    (((inst >> 11) & 0x1) << 4) | (((inst >> 3) & 0x7) << 1);
  return sext(BigInt(v), 12);
}

function cBranchImm(inst: number): bigint {
  const v =
    (((inst >> 12) & 0x1) << 8) | (((inst >> 5) & 0x3) << 6) | (((inst >> 2) & 0x1) << 5) |
    (((inst >> 10) & 0x3) << 3) | (((inst >> 3) & 0x3) << 1);
  return sext(BigInt(v), 9);
}

export { AccessType };
