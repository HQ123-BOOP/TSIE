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
 * 虚拟页快路径表项：把一个已翻译的 4KB 虚拟页固定到 RAM 的 DataView 切片上。
 * 命中后 fetch/load/store 只需 1 次 BigInt 移位 + 1 次 BigInt AND + Number 键
 * Map 查找，完全绕开 isCanonical/tlbKey/checkPerm 的 BigInt 流水线。
 */
interface FastPage {
  /** RAM 的 DataView（来自 fastRam） */
  view: DataView;
  /** 该虚拟页首字节在 DataView 中的偏移 */
  off: number;
  /** PTE 低 8 位（含 walk 时回写的 A/D） */
  prot: number;
  asid: number;
  global: boolean;
}

/**
 * MMU：支持 Bare / Sv39 / Sv48，带可配置 TLB。
 * 故障信息通过 `faultCause` / `faultTval` 返回给 CPU。
 */
export class Mmu {
  /** 当前特权级（由 CPU 同步）；setter 顺带重算快路径权限位 */
  get priv(): PrivLevel {
    return this._priv;
  }
  set priv(v: PrivLevel) {
    this._priv = v;
    this.recalcFastPerms();
  }
  private _priv: PrivLevel = Priv.M;

  /** mstatus（由 CPU 同步）；setter 顺带重算快路径权限位 */
  get mstatus(): bigint {
    return this._mstatus;
  }
  set mstatus(v: bigint) {
    this._mstatus = v;
    this.recalcFastPerms();
  }
  private _mstatus = 0n;

  readonly bus: Bus;

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
    if (v === this._satp) return; // syncMmu 每次脏同步都赋值，等值直接短路
    this._satp = v;
    this._mode = Number((v >> 60n) & 0xfn);
    this._asid = Number((v >> 44n) & 0xffffn);
    this._vaBits = this._mode === 8 ? 39 : this._mode === 9 ? 48 : 0;
    this._enabled = this._mode !== 0;
    // 切换到当前 asid 的快缓存桶（get-or-create）
    let m = this.fastBy.get(this._asid);
    if (m === undefined) {
      m = new Map<number, FastPage>();
      this.fastBy.set(this._asid, m);
    }
    this.fastCur = m;
    this.recalcFastPerms();
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

  // ------------------------------------------------------------------
  // 虚拟页快缓存（Number 键）
  //
  // 外层按 asid 分桶（与 TLB 的 asid 语义对齐），内层键 = Number(vaddr >> 12)。
  // 内核 VA 的 vpn 有 44+ 位，Number 仍精确（< 2^53），且 Map 对 Number 键的
  // 哈希远快于 BigInt。仅在 walk 成功且 4KB 切片完整落在 fastRam 时填充，
  // 所以命中即可直读 DataView，不再经过 isCanonical/tlbKey/checkPerm。
  // ------------------------------------------------------------------
  private fastBy = new Map<number, Map<number, FastPage>>();
  private fastCur: Map<number, FastPage> = new Map();

  /**
   * 快路径权限判定用的预计算位（由 recalcFastPerms 在
   * priv/mstatus/satp 变化时刷新）：
   *  - fOnI / fOnL：快路径总开关（翻译启用且有效特权级非 M；
   *    L 含 MPRV 语义）
   *  - fUokI/fSokI、fUokL/fSokL：U 页 / 非 U 页在对应有效特权级
   *    下是否可访问（SUM 语义）
   *  - fMxrL：MXR（加载允许 X 页）
   */
  private fOnI = false;
  private fOnL = false;
  private fUokI = false;
  private fSokI = false;
  private fUokL = false;
  private fSokL = false;
  private fMxrL = false;
  /** 取指快路径的 MXR（MXR=1 时取指可走可读页） */
  private fMxrI = false;

  private recalcFastPerms(): void {
    const m = this._mstatus;
    const mprv = (m & SR_MPRV) !== 0n;
    const eL = mprv ? ((Number((m >> 11n) & 3n)) as PrivLevel) : this._priv;
    const sum = (m & SR_SUM) !== 0n;
    this.fOnI = this._enabled && this._priv !== Priv.M;
    this.fOnL = this._enabled && eL !== Priv.M;
    this.fUokI = this._priv === Priv.U || (this._priv === Priv.S && sum);
    this.fSokI = this._priv !== Priv.U;
    this.fUokL = eL === Priv.U || (eL === Priv.S && sum);
    this.fSokL = eL !== Priv.U;
    this.fMxrL = (m & SR_MXR) !== 0n;
    this.fMxrI = (m & SR_MXR) !== 0n;
  }

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
    for (const m of this.fastBy.values()) m.clear();
  }

  /** sfence.vma：按 asid / vaddr 失效 */
  flushBy(vaddr?: bigint, asid?: number): void {
    if (vaddr === undefined && asid === undefined) {
      this.flush();
      return;
    }
    // 快缓存同步失效：vpn 精确匹配（超级页只填了访问到的 4K 切片，键即 vpn）
    if (vaddr !== undefined) {
      const vpn = Number(vaddr >> PAGE_SHIFT);
      for (const m of this.fastBy.values()) m.delete(vpn);
    } else {
      // 仅按 asid：清该 asid 的桶；全局页（各桶里都可能有）一并清
      for (const [a, m] of this.fastBy) {
        if (a === asid) m.clear();
        else for (const [k, e] of m) if (e.global) m.delete(k);
      }
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
    const mxr = (this.mstatus & SR_MXR) !== 0n;
    if (access === AccessType.Instruction) {
      // RISC-V 规范 §4.3.1：取指在「页可执行」**或**「MXR=1 且页可读」时允许。
      //
      // ⚠️ 早先这里硬要求 X 位、完全忽略 MXR，是个真 bug：
      // OpenBSD/riscv64 的内核映射用 R+W / X=0 的页配 mstatus.MXR=1 来取指，
      // 于是 EFI→内核交接跳进 0x84200000（PTE=0x210800e7，R=1 W=1 X=0）时，
      // 我们抛 EXCEPT_RISCV_INST_ACCESS_PAGE_FAULT(cause 12)。
      // 而**加载路径本来就有 MXR 支持**（见 fMxrL），只有取指漏了 —— 典型的
      // 「一个消费者没覆盖到」。U-Boot 那条路径不开分页，所以从没暴露。
      const executable = (prot & Number(PTE_X)) !== 0;
      const readableViaMxr = mxr && (prot & Number(PTE_R)) !== 0;
      return executable || readableViaMxr;
    }
    if (access === AccessType.Load) {
      const readable = (prot & Number(PTE_R)) !== 0;
      const executable = (prot & Number(PTE_X)) !== 0 && mxr;
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
    // ⚠️ 必须在这里清空：早先只在 fault() 里清，导致**成功的 walk 会累积残留**，
    // 于是故障记录附带的是上一次成功 walk 的轨迹（地址对不上，会把人带偏）。
    this.lastWalkTrace.length = 0;

    for (let i = levels - 1; i >= 0; i--) {
      const vpn = Number((vaddr >> BigInt(12 + 9 * i)) & 0x1ffn);
      const pteAddr = base + BigInt(vpn * 8);
      let pte: bigint;
      try {
        pte = this.bus.read(pteAddr, 8);
      } catch (e) {
        if (e instanceof BusError) {
          this.lastWalkTrace.push(`  !! 读 PTE 越界（BUSERR）@L${i}`);
          return this.fault(faultCause, vaddr);
        }
        throw e;
      }
      if (this.debug && this.lastWalkTrace.length < 40) {
        this.lastWalkTrace.push(
          `  L${i}: vpn=${vpn} pte@0x${pteAddr.toString(16)} pte=0x${pte.toString(16)}`,
        );
      }

      const prot = Number(pte & 0xffn);
      if ((prot & 1) === 0 || ((prot & Number(PTE_W)) !== 0 && (prot & Number(PTE_R)) === 0)) {
        if (this.lastWalkTrace.length < 40) {
          this.lastWalkTrace.push(
            `  !! L${i} PTE 非法：V=${prot & 1} W=${(prot >> 2) & 1} R=${(prot >> 1) & 1}`,
          );
        }
        return this.fault(faultCause, vaddr);
      }
      const isLeaf = (pte & PTE_R) !== 0n || (pte & PTE_X) !== 0n;
      if (!isLeaf) {
        base = ((pte >> 10n) & PTE_PPN_MASK) << PAGE_SHIFT;
        continue;
      }

      // 叶子页表项：权限检查
      if (!this.checkPerm(prot, effPriv, access)) {
        if (this.lastWalkTrace.length < 40) {
          this.lastWalkTrace.push(
            `  !! L${i} 权限不足：prot=0x${prot.toString(16)} U=${(prot >> 4) & 1} ` +
              `R=${(prot >> 1) & 1} W=${(prot >> 2) & 1} X=${(prot >> 3) & 1} ` +
              `effPriv=${effPriv} access=${access} mstatus=0x${this._mstatus.toString(16)}`,
          );
        }
        return this.fault(faultCause, vaddr);
      }

      const ppn = (pte >> 10n) & PTE_PPN_MASK;
      if (i > 0 && (ppn & ((1n << BigInt(9 * i)) - 1n)) !== 0n) {
        // 非对齐超级页
        if (this.lastWalkTrace.length < 40) {
          this.lastWalkTrace.push(
            `  !! L${i} 非对齐超级页：ppn=0x${ppn.toString(16)} 需低 ${9 * i} 位为 0`,
          );
        }
        return this.fault(faultCause, vaddr);
      }

      // A/D 位更新（写回内存）
      let updated = pte;
      if ((pte & PTE_A) === 0n) updated |= PTE_A;
      if (access === AccessType.Store && (pte & PTE_D) === 0n) updated |= PTE_D;
      if (updated !== pte) this.bus.write(pteAddr, updated, 8);

      const shift = 12 + 9 * i;
      const paddr = (ppn << PAGE_SHIFT) | (vaddr & ((1n << BigInt(shift)) - 1n));

      if (this.tlb.size >= this.maxEntries) {
        this.tlb.clear();
        for (const m of this.fastBy.values()) m.clear();
      }
      this.tlb.set(this.tlbKey(vaddr, asid), {
        base: ppn << PAGE_SHIFT,
        mask: (1n << BigInt(shift)) - 1n,
        prot: Number(updated & 0xffn),
        global: (updated & PTE_G) !== 0n,
        asid,
      });

      // 填虚拟页快缓存：仅当该 4KB 切片完整落在 fastRam（MMIO 页走慢路径）
      const ram = this.fastRam;
      if (ram !== undefined) {
        const pb = Number(paddr & ~0xfffn);
        if (pb >= ram.base && pb + 4096 <= ram.end) {
          let m = this.fastBy.get(asid);
          if (m === undefined) {
            m = new Map<number, FastPage>();
            this.fastBy.set(asid, m);
            if (asid === this._asid) this.fastCur = m;
          }
          m.set(Number(vaddr >> PAGE_SHIFT), {
            view: ram.view,
            off: pb - ram.base,
            prot: Number(updated & 0xffn),
            asid,
            global: (updated & PTE_G) !== 0n,
          });
        }
      }
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
    // 虚拟页快路径：命中则零 BigInt 直读（取指有效特权级 = 当前 priv）
    if (this.fOnI) {
      const fp = this.fastCur.get(Number(vaddr >> PAGE_SHIFT));
      if (fp !== undefined) {
        const p = fp.prot;
        // 取指：X 位满足，或 MXR=1 且 R 位满足（规范 §4.3.1）
        const okExec = (p & 8) !== 0 || (this.fMxrI && (p & 2) !== 0);
        if (okExec && ((p & 16) !== 0 ? this.fUokI : this.fSokI)) {
          return fp.view.getUint16(fp.off + Number(vaddr & 0xfffn), true);
        }
        // 权限不满足 → 落慢路径产生正确的 page fault（不能静默放行）
      }
    }
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
    // 虚拟页快路径（有效特权级已折算 MPRV，见 fOnL/fUokL/fMxrL）
    if (this.fOnL) {
      const fp = this.fastCur.get(Number(vaddr >> PAGE_SHIFT));
      if (fp !== undefined) {
        const p = fp.prot;
        if (((p & 2) !== 0 || (this.fMxrL && (p & 8) !== 0)) && ((p & 16) !== 0 ? this.fUokL : this.fSokL)) {
          const a = fp.off + Number(vaddr & 0xfffn);
          const v = fp.view;
          return size === 1 ? BigInt(v.getUint8(a))
            : size === 2 ? BigInt(v.getUint16(a, true))
            : size === 4 ? BigInt(v.getUint32(a, true))
            : v.getBigUint64(a, true);
        }
      }
    }
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
    // 虚拟页快路径：存储额外要求 D=1（D=0 时慢路径会回写 PTE）
    if (this.fOnL) {
      const fp = this.fastCur.get(Number(vaddr >> PAGE_SHIFT));
      if (fp !== undefined) {
        const p = fp.prot;
        if ((p & 4) !== 0 && (p & 128) !== 0 && ((p & 16) !== 0 ? this.fUokL : this.fSokL)) {
          const a = fp.off + Number(vaddr & 0xfffn);
          const v = fp.view;
          if (size === 1) v.setUint8(a, Number(value & 0xffn));
          else if (size === 2) v.setUint16(a, Number(value & 0xffffn), true);
          else if (size === 4) v.setUint32(a, Number(value & 0xffffffffn), true);
          else v.setBigUint64(a, value & MASK64, true);
          return true;
        }
      }
    }
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
