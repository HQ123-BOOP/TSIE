/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import { BusError } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import { AccessType, type AccessTypeValue } from '../mem/types.ts';
import { MASK64 } from '../core/bits.ts';
import { Exc, SR_MXR, SR_MPRV, SR_SUM, type PrivLevel, Priv } from './csr.ts';

export const PAGE_SHIFT = 12n;
export const PAGE_SIZE = 1n << PAGE_SHIFT;

// PTE 标志位
const PTE_R = 0x02n;
const PTE_W = 0x04n;
const PTE_X = 0x08n;
const PTE_U = 0x10n;
const PTE_G = 0x20n;
const PTE_A = 0x40n;
const PTE_D = 0x80n;
const PTE_PPN_MASK = (1n << 44n) - 1n;

/** TLB 表项 */
interface TlbEntry {
  /** 物理页基址（已左移 12 位） */
  base: bigint;
  /** 页内偏移掩码（超级页时为 2MB/1GB/512GB-1） */
  mask: bigint;
  /** PTE 低 8 位（V/R/W/X/U/G/A/D） */
  prot: number;
  /** 全局映射（G 位） */
  global: boolean;
  asid: number;
}

/**
 * MMU：支持 Bare / Sv39 / Sv48，带可配置 TLB。
 * 故障信息通过 `faultCause` / `faultTval` 返回给 CPU。
 */
export class Mmu {
  readonly bus: Bus;
  /** 当前特权级（由 CPU 同步） */
  priv: PrivLevel = Priv.M;
  /** mstatus（由 CPU 同步） */
  mstatus = 0n;

  /**
   * satp 缓存的派生值：enabled/mode/asid/vaBits。
   * satp 极少变化（上下文切换才写），而 translate() 每条指令都要读——
   * 派生值在 setter 里算好，热路径只做布尔/Number 判断，
   * 省掉每次 `satp >> 60n & 0xfn` 的三次 BigInt 移位+AND+转换。
   */
  private _satp = 0n;
  private _enabled = false;
  private _mode = 0;
  private _asid = 0;
  private _vaBits = 0;

  get satp(): bigint {
    return this._satp;
  }
  set satp(v: bigint) {
    this._satp = v;
    this._mode = Number((v >> 60n) & 0xfn);
    this._asid = Number((v >> 44n) & 0xffffn);
    this._vaBits = this._mode === 8 ? 39 : this._mode === 9 ? 48 : 0;
    this._enabled = this._mode !== 0;
  }

  faultCause = -1;
  faultTval = 0n;

  /**
   * TLB：键用 bigint 保存。
   * 早期实现用 Number(vaddr>>12)*65536+asid，在 Sv48 下可达 2^52，
   * 逼近 Number 安全整数上限（2^53）：不同虚拟地址会碰撞成同一个键，
   * 且 `key >>> 16`（32 位运算）会截断高位，导致 sfence.vma 按地址失效失灵。
   */
  /**
   * TLB：键用 bigint —— VPN 是 vaddr>>12 的全量值，内核地址
   * （0xffffffff8xxxxxxx >> 12）有 52 位，压不进 Number 安全范围，
   * 也无法和 asid 位拼接（曾试过 `vpn|asid<<44`：内核 vpn 高位
   * 恒 1 导致不同 asid 键碰撞 → 上下文切换后命中陈旧表项 →
   * 内核异常风暴， Debian 13 实测卡死在 handle_exception）。
   */
  private tlb = new Map<bigint, TlbEntry>();

  /** TLB 键：vpn*65536 + asid（bigint；flushBy 用 key>>16 反解 vpn） */
  private tlbKey(vaddr: bigint, asid: number): bigint {
    return (vaddr >> PAGE_SHIFT) * 65536n + BigInt(asid);
  }
  /** TLB 容量（超出后整体清空，简单有效） */
  maxEntries = 4096;

  stats = { tlbHit: 0, tlbMiss: 0, walks: 0 };

  /** 调试：页错误时打印遍历细节 */
  debug = false;
  private dbgLog: string[] = [];

  constructor(bus: Bus) {
    this.bus = bus;
  }

  flush(): void {
    this.tlb.clear();
  }

  /** sfence.vma：按 asid / vaddr 失效 */
  flushBy(vaddr?: bigint, asid?: number): void {
    if (vaddr === undefined && asid === undefined) {
      this.flush();
      return;
    }
    for (const [key, e] of this.tlb) {
      if (vaddr !== undefined && key >> 16n !== vaddr >> PAGE_SHIFT) continue;
      if (asid !== undefined && e.asid !== asid && !(e.global && vaddr === undefined)) continue;
      this.tlb.delete(key);
    }
  }

  private fault(cause: number, tval: bigint): null {
    this.faultCause = cause;
    this.faultTval = tval & MASK64;
    if (this.debug && this.dbgLog.length < 200) {
      const mode = Number((this.satp >> 60n) & 0xfn);
      this.dbgLog.push(
        `FAULT cause=${cause} vaddr=0x${tval.toString(16)} satp=0x${this.satp.toString(16)} mode=${mode} priv=${this.priv}` +
          (this.lastWalkTrace.length ? '\n' + this.lastWalkTrace.join('\n') : ''),
      );
    }
    this.lastWalkTrace = [];
    return null;
  }

  private lastWalkTrace: string[] = [];

  /** 地址翻译是否启用：由 satp setter 缓存（translate 用 _enabled） */

  /** 判断虚拟地址是否规范（canonical） */
  private isCanonical(vaddr: bigint, vaBits: number): boolean {
    const upper = vaddr >> BigInt(vaBits - 1);
    return upper === 0n || upper === (1n << BigInt(65 - vaBits)) - 1n;
  }

  /** 有效的翻译特权级（考虑 MPRV） */
  private effectivePriv(access: AccessTypeValue): PrivLevel {
    if (access === AccessType.Instruction) return this.priv;
    if ((this.mstatus & SR_MPRV) !== 0n) return Number((this.mstatus >> 11n) & 3n) as PrivLevel;
    return this.priv;
  }

  /** 检查 TLB 命中后的权限（mstatus 变化会在这里体现） */
  private checkPerm(prot: number, effPriv: PrivLevel, access: AccessTypeValue): boolean {
    if ((prot & Number(PTE_U)) === 0 && effPriv === Priv.U) return false;
    if ((prot & Number(PTE_U)) !== 0 && effPriv === Priv.S && (this.mstatus & SR_SUM) === 0n) return false;
    if (access === AccessType.Instruction) return (prot & Number(PTE_X)) !== 0;
    if (access === AccessType.Load) {
      const readable = (prot & Number(PTE_R)) !== 0;
      const executable = (prot & Number(PTE_X)) !== 0 && (this.mstatus & SR_MXR) !== 0n;
      return readable || executable;
    }
    return (prot & Number(PTE_W)) !== 0;
  }

  /** 虚拟地址 → 物理地址；失败返回 null 并设置 faultCause/faultTval */
  translate(vaddr: bigint, access: AccessTypeValue): bigint | null {
    const faultCause =
      access === AccessType.Instruction
        ? Exc.InstPageFault
        : access === AccessType.Load
          ? Exc.LoadPageFault
          : Exc.StorePageFault;

    const effPriv = this.effectivePriv(access);
    if (effPriv === Priv.M || !this._enabled) return vaddr & MASK64;

    const mode = this._mode;
    const asid = this._asid;
    const vaBits = this._vaBits;
    if (vaBits === 0 || !this.isCanonical(vaddr, vaBits)) return this.fault(faultCause, vaddr);

    const key = this.tlbKey(vaddr, asid);
    const hit = this.tlb.get(key);
    if (hit) {
      // 写入但 D 位未置位 → 需要回内存更新，直接走慢路径
      const needDirty = access === AccessType.Store && (hit.prot & Number(PTE_D)) === 0;
      if (!needDirty && this.checkPerm(hit.prot, effPriv, access)) {
        this.stats.tlbHit++;
        return hit.base | (vaddr & hit.mask);
      }
      this.tlb.delete(key);
    }
    this.stats.tlbMiss++;
    return this.walk(vaddr, access, mode, asid, faultCause, effPriv);
  }

  private walk(
    vaddr: bigint,
    access: AccessTypeValue,
    mode: number,
    asid: number,
    faultCause: number,
    effPriv: PrivLevel,
  ): bigint | null {
    const levels = mode === 8 ? 3 : 4;
    let base = (this.satp & PTE_PPN_MASK) << PAGE_SHIFT;
    this.stats.walks++;

    for (let i = levels - 1; i >= 0; i--) {
      const vpn = Number((vaddr >> BigInt(12 + 9 * i)) & 0x1ffn);
      const pteAddr = base + BigInt(vpn * 8);
      let pte: bigint;
      try {
        pte = this.bus.read(pteAddr, 8);
      } catch (e) {
        if (e instanceof BusError) return this.fault(faultCause, vaddr);
        throw e;
      }
      if (this.debug && this.lastWalkTrace.length < 40) {
        this.lastWalkTrace.push(
          `  L${i}: vpn=${vpn} pte@0x${pteAddr.toString(16)} pte=0x${pte.toString(16)}`,
        );
      }

      const prot = Number(pte & 0xffn);
      if ((prot & 1) === 0 || ((prot & Number(PTE_W)) !== 0 && (prot & Number(PTE_R)) === 0)) {
        return this.fault(faultCause, vaddr);
      }
      const isLeaf = (pte & PTE_R) !== 0n || (pte & PTE_X) !== 0n;
      if (!isLeaf) {
        base = ((pte >> 10n) & PTE_PPN_MASK) << PAGE_SHIFT;
        continue;
      }

      // 叶子页表项：权限检查
      if (!this.checkPerm(prot, effPriv, access)) return this.fault(faultCause, vaddr);

      const ppn = (pte >> 10n) & PTE_PPN_MASK;
      if (i > 0 && (ppn & ((1n << BigInt(9 * i)) - 1n)) !== 0n) {
        // 非对齐超级页
        return this.fault(faultCause, vaddr);
      }

      // A/D 位更新（写回内存）
      let updated = pte;
      if ((pte & PTE_A) === 0n) updated |= PTE_A;
      if (access === AccessType.Store && (pte & PTE_D) === 0n) updated |= PTE_D;
      if (updated !== pte) this.bus.write(pteAddr, updated, 8);

      const shift = 12 + 9 * i;
      const paddr = (ppn << PAGE_SHIFT) | (vaddr & ((1n << BigInt(shift)) - 1n));

      if (this.tlb.size >= this.maxEntries) this.tlb.clear();
      this.tlb.set(this.tlbKey(vaddr, asid), {
        base: ppn << PAGE_SHIFT,
        mask: (1n << BigInt(shift)) - 1n,
        prot: Number(updated & 0xffn),
        global: (updated & PTE_G) !== 0n,
        asid,
      });
      return paddr;
    }
    return this.fault(faultCause, vaddr);
  }

  // ------------------------------------------------------------------
  // 对外访存接口
  // ------------------------------------------------------------------

  /**
   * 主 RAM 直读快路径：由 Machine 在挂 RAM 后注入。
   * fetch/load/store 拿到物理地址后先判断是否落在 RAM——是则直接
   * DataView 访问，绕过 bus.find 的区间查找与 BigInt 装箱（bus.read
   * 返回 bigint 再 Number() 转换，每条指令取指 1~2 次都是这个开销）。
   * 落在别的设备仍走 bus（串口/磁盘等本来就慢，不差这点）。
   */
  fastRam?: { base: number; end: number; data: Uint8Array; view: DataView };

  /** 取指令半字（16 位）；返回 null 表示异常 */
  fetch16(vaddr: bigint): number | null {
    const pa = this.translate(vaddr, AccessType.Instruction);
    if (pa === null) return null;
    const ram = this.fastRam;
    if (ram !== undefined) {
      const a = Number(pa);
      if (a >= ram.base && a < ram.end) return ram.view.getUint16(a - ram.base, true);
    }
    try {
      return Number(this.bus.read(pa, 2) & 0xffffn);
    } catch (e) {
      if (e instanceof BusError) {
        this.faultCause = Exc.InstAccessFault;
        this.faultTval = vaddr;
        return null;
      }
      throw e;
    }
  }

  /**
   * 取指令字（32 位）。
   * RVC（IALIGN=16）下 32 位指令允许 2 字节对齐，且可跨页——
   * 因此拆成两个半字分别翻译，奇数地址的对齐检查由 CPU 的取指入口负责。
   */
  fetch32(vaddr: bigint): number | null {
    const lo = this.fetch16(vaddr);
    if (lo === null) return null;
    if ((lo & 3) !== 3) return lo;
    const hi = this.fetch16(vaddr + 2n);
    if (hi === null) return null;
    return (lo | (hi << 16)) >>> 0;
  }

  load(vaddr: bigint, size: MemSize): bigint | null {
    const pa = this.translate(vaddr, AccessType.Load);
    if (pa === null) return null;
    const ram = this.fastRam;
    if (ram !== undefined) {
      const a = Number(pa) - ram.base;
      if (a >= 0 && a < ram.end - ram.base) {
        const v = ram.view;
        return size === 1 ? BigInt(ram.data[a])
          : size === 2 ? BigInt(v.getUint16(a, true))
          : size === 4 ? BigInt(v.getUint32(a, true))
          : v.getBigUint64(a, true);
      }
    }
    try {
      return this.bus.read(pa, size);
    } catch (e) {
      if (e instanceof BusError) return this.fault(Exc.LoadAccessFault, vaddr);
      throw e;
    }
  }

  store(vaddr: bigint, value: bigint, size: MemSize): boolean {
    const pa = this.translate(vaddr, AccessType.Store);
    if (pa === null) return false;
    const ram = this.fastRam;
    if (ram !== undefined) {
      const a = Number(pa) - ram.base;
      if (a >= 0 && a < ram.end - ram.base) {
        const v = ram.view;
        if (size === 1) ram.data[a] = Number(value & 0xffn);
        else if (size === 2) v.setUint16(a, Number(value & 0xffffn), true);
        else if (size === 4) v.setUint32(a, Number(value & 0xffffffffn), true);
        else v.setBigUint64(a, value & MASK64, true);
        return true;
      }
    }
    try {
      this.bus.write(pa, value, size);
      return true;
    } catch (e) {
      if (e instanceof BusError) {
        this.fault(Exc.StoreAccessFault, vaddr);
        return false;
      }
      throw e;
    }
  }

  /** 物理地址直接访问（调试器 / SBI / virtio 用） */
  physRead(addr: bigint, size: MemSize): bigint {
    return this.bus.read(addr, size);
  }

  physWrite(addr: bigint, value: bigint, size: MemSize): void {
    this.bus.write(addr, value, size);
  }
}
