/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Device, MemSize } from '../mem/types.ts';

/**
 * CFI NOR 闪存（Intel StrataFlash P30 命令集）。
 *
 * 这是 EDK II (UEFI) 在 QEMU virt 上的**硬性前置**：RiscVVirtQemu 要求两块 pflash，
 * CODE 与 VARS 各 32MiB；RISC-V 平台不用 PCI 枚举，而是从设备树的
 * `compatible = "cfi-flash"` 节点读 `reg` 拿 flash 布局。
 *
 * 与既有设备（virtio 系列 / uart / plic / clint）的本质区别：这是**内存映射的、
 * 有状态的命令状态机**，没有队列、描述符环、中断。
 *
 * 命令语义照着 QEMU 的 hw/block/pflash_cfi01.c 实现 —— EDK2 的
 * VirtNorFlashDeviceLib 就是照着那台设备写的。
 *
 * 两个刻意的取舍：
 *  1. **按"写入的值"识别命令，地址只用于定位擦除/编程目标**（擦除按扇区对齐）。
 *     这样不必精确复刻 QEMU 里那套与 bank/device 位宽相关的 boff 换算 —— 它依赖
 *     EDK2 头文件 CREATE_NOR_ADDRESS 的具体倍数，猜错就全盘皆错。
 *  2. **一次访存就是一次事务**。EDK2 用 32 位访问，那么 32 位的数据写必须一次落完；
 *     若照 QEMU 那样把宽访问拆成两个 16 位写，第二个半字会被当成新命令。
 */

/* ---------------- 命令字节（Intel StrataFlash P30） ---------------- */
const CMD_READ_ARRAY = 0xff;
const CMD_READ_ARRAY_ALT = 0x00;
const CMD_WORD_PROGRAM = 0x40;
const CMD_BYTE_PROGRAM = 0x10;
const CMD_BUFFERED_PROGRAM = 0xe8;
const CMD_BLOCK_ERASE = 0x20;
const CMD_BLOCK_ERASE_ALT = 0x28;
const CMD_CONFIRM = 0xd0;
const CMD_READ_STATUS = 0x70;
const CMD_CLEAR_STATUS = 0x50;
const CMD_READ_ID = 0x90;
const CMD_CFI_QUERY = 0x98;
const CMD_LOCK_SETUP = 0x60;
const CMD_UNLOCK_CONFIRM = 0x01;

/** 状态寄存器就绪位。EDK2 要求 BIT7 与 BIT23 同时置位（32 位读得 0x80808080） */
const SR_READY = 0x80;
/** 擦除态 */
const ERASED = 0xff;

/**
 * 器件 ID。**两个值的 bit0 都必须是 0** —— EDK2 的 `NorFlashBlockIsLocked` 用读回的
 * bit0 判断块是否被锁，读成 1 就会拒绝写 VARS，整个 UEFI 变量存储起不来。
 * 我们无法百分百确定 EDK2 在哪个偏移上做这个判断（它的 CREATE_NOR_ADDRESS 倍数
 * 依赖 bank/device 位宽），所以让**所有**返回的 ID 值 bit0 都为 0，任何偏移都安全。
 * （所以没用 Intel 的真实厂商号 0x89 —— 那个 bit0 是 1。）
 */
const ID_MANUFACTURER = 0x1c;
const ID_DEVICE = 0x227e;

export interface FlashOptions {
  /** 区域大小（字节），EDK2 要求 32MiB */
  size: number;
  /** 初始内容；不足部分填 0xff（擦除态） */
  data?: Uint8Array;
  /** 擦除块大小，默认 256KiB（EDK2 的 QEMU_NOR_BLOCK_SIZE） */
  sectorSize?: number;
}

/** CFI 查询表（0x98）。EDK2 硬编码 P30、不查此表，只填最小可识别内容防探测误判 */
const CFI_TABLE = (() => {
  const t = new Uint8Array(0x54);
  t[0x10] = 0x51; t[0x11] = 0x52; t[0x12] = 0x59; // "QRY"
  t[0x13] = 0x01; // 主命令集：Intel
  t[0x1b] = 0x27; // 器件大小 2^27
  t[0x20] = 0x07; t[0x21] = 0x07; // 单字写
  t[0x26] = 0x04;                 // 单字写超时
  t[0x28] = 0x01;                 // 擦除块区域数
  t[0x2c] = 0x02; t[0x2d] = 0x00; // 块大小 2^16 × 256B = 256KiB
  t[0x2e] = 0x00; t[0x2f] = 0x01;
  return t;
})();

export class CfiFlash implements Device {
  readonly name = 'cfi-flash';
  readonly size: bigint;
  /** 闪存阵列本身（可直接读，便于测试与取证） */
  readonly storage: Uint8Array;
  readonly sectorSize: number;

  private cmd = 0x00;
  /** 命令写周期：0=空闲，≥1=等数据/确认 */
  private wcycle = 0;
  private status = SR_READY;
  private buf: Uint8Array | null = null;
  private bufFill = 0;
  private bufAddr = 0;
  private lockPending = false;

  /** 调试：命令序列追踪 */
  cmdTrace = false;
  readonly cmdTraceLog: string[] = [];

  constructor(opts: FlashOptions) {
    this.size = BigInt(opts.size);
    this.sectorSize = opts.sectorSize ?? 0x40000;
    this.storage = new Uint8Array(opts.size);
    this.storage.fill(ERASED);
    if (opts.data) {
      this.storage.set(opts.data.subarray(0, Math.min(opts.data.length, opts.size)), 0);
    }
  }

  private trace(s: string): void {
    if (!this.cmdTrace || this.cmdTraceLog.length >= 200) return;
    this.cmdTraceLog.push(s);
  }

  /** 把字节按访问宽度逐字节复制（QEMU 对每个器件返回同一字节） */
  private replicate(byte: number, size: MemSize): bigint {
    let v = 0n;
    for (let i = 0; i < size; i++) v |= BigInt(byte & 0xff) << BigInt(8 * i);
    return v;
  }

  private readArray(off: number, size: MemSize): bigint {
    let v = 0n;
    for (let i = 0; i < size; i++) {
      const idx = off + i;
      const b = idx >= 0 && idx < this.storage.length ? this.storage[idx] : ERASED;
      v |= BigInt(b) << BigInt(8 * i);
    }
    return v;
  }

  /** 全 1（未处理命令态下的读回值） */
  private allOnes(size: MemSize): bigint {
    let v = 0n;
    for (let i = 0; i < size; i++) v |= 0xffn << BigInt(8 * i);
    return v;
  }

  read(offset: bigint, size: MemSize): bigint {
    const off = Number(offset);
    switch (this.cmd) {
      // 读阵列就是"无命令态"：0xff 与 0x00 都归到这里（0x00 是静止态）
      case CMD_READ_ARRAY:
      case CMD_READ_ARRAY_ALT:
        return this.readArray(off, size);
      case CMD_READ_STATUS:
        return this.replicate(this.status, size);
      case CMD_READ_ID: {
        const boff = off >> 2;
        const id = boff === 0 ? ID_MANUFACTURER : boff === 1 ? ID_DEVICE : 0;
        return this.replicate(id, size);
      }
      case CMD_CFI_QUERY: {
        const boff = off >> 2;
        const b = boff >= 0 && boff < CFI_TABLE.length ? CFI_TABLE[boff] : 0;
        return this.replicate(b, size);
      }
      default:
        // 其他命令态（0x40 字编程 setup、0xE8 缓冲编程 setup、0x20 擦除、0x60 锁）
        // 下，读回**全 1**。这是 QEMU pflash_read 的 default 分支行为（返回 -1），
        // 而且 EDK2 依赖它：
        //
        //   NorFlashWriteBuffer() 发完 0xE8 后会回读同一地址，把返回值当状态寄存器，
        //   检查 (v & (BIT7<<16|BIT7)) == (BIT7<<16|BIT7) 来判断缓冲是否可用。
        //   若这里返回的是阵列数据，检查就失败，EDK2 会带着
        //   MAX_BUFFERED_PROG_ITERATIONS(=1000 万) 的重试上限空转；更要命的是
        //   连续的 0xE8 会被状态机误当成"字数"（0xE8=232 → 233 个字），
        //   于是缓冲编程彻底跑偏（实机表现就是 BUF_ABORT 无限重复）。
        //   返回全 1 后该检查通过，EDK2 才会继续发字数与数据。
        return this.allOnes(size);
    }
  }

  write(offset: bigint, value: bigint, size: MemSize): void {
    const off = Number(offset);
    // 读 ID / CFI 查询模式下任意写入即离场
    if (this.cmd === CMD_READ_ID || this.cmd === CMD_CFI_QUERY) {
      this.cmd = 0x00;
      this.wcycle = 0;
    }
    if (this.wcycle === 0) {
      this.command(off, Number(value & 0xffn));
      return;
    }
    this.data(off, value, size);
  }

  /** wcycle=0：只认最低字节作命令（EDK2 用 32 位写发命令） */
  private command(off: number, v: number): void {
    switch (v) {
      case CMD_READ_ARRAY:
      case CMD_READ_ARRAY_ALT:
        this.cmd = 0x00;
        this.wcycle = 0;
        this.trace('READ_ARRAY');
        return;
      case CMD_CLEAR_STATUS:
        this.status = 0x00;
        this.cmd = 0x00;
        this.wcycle = 0;
        this.trace('CLEAR_STATUS');
        return;
      case CMD_READ_STATUS:
        this.cmd = CMD_READ_STATUS;
        this.trace('READ_STATUS');
        return;
      case CMD_READ_ID:
        this.cmd = CMD_READ_ID;
        this.trace('READ_ID');
        return;
      case CMD_CFI_QUERY:
        this.cmd = CMD_CFI_QUERY;
        this.trace('CFI_QUERY');
        return;
      case CMD_WORD_PROGRAM:
      case CMD_BYTE_PROGRAM:
        this.cmd = CMD_WORD_PROGRAM;
        this.wcycle = 1;
        this.status |= SR_READY;
        this.trace(`PROGRAM_SETUP @${off}`);
        return;
      case CMD_BLOCK_ERASE:
      case CMD_BLOCK_ERASE_ALT: {
        const base = off - (off % this.sectorSize);
        this.storage.fill(ERASED, base, Math.min(base + this.sectorSize, this.storage.length));
        this.status |= SR_READY;
        this.cmd = CMD_BLOCK_ERASE;
        this.wcycle = 1;
        this.trace(`ERASE_SETUP @${off} → sector ${base}`);
        return;
      }
      case CMD_BUFFERED_PROGRAM:
        this.cmd = CMD_BUFFERED_PROGRAM;
        this.wcycle = 1;
        this.status |= SR_READY;
        this.buf = null;
        this.bufFill = 0;
        this.trace(`BUF_PROGRAM_SETUP @${off}`);
        return;
      case CMD_LOCK_SETUP:
        this.lockPending = true;
        this.wcycle = 1;
        this.trace('LOCK_SETUP');
        return;
      default:
        this.trace(`UNKNOWN cmd=0x${v.toString(16)} @${off}`);
        this.wcycle = 0;
        return;
    }
  }

  /** wcycle≥1：数据或确认，按访问宽度整笔处理 */
  private data(off: number, value: bigint, size: MemSize): void {
    if (this.cmd === CMD_WORD_PROGRAM) {
      // NOR 只能把 1 变 0
      for (let i = 0; i < size; i++) {
        const idx = off + i;
        const b = Number((value >> BigInt(8 * i)) & 0xffn);
        if (idx >= 0 && idx < this.storage.length) this.storage[idx] &= b;
      }
      this.trace(`PROGRAM_DATA @${off} width=${size} = 0x${value.toString(16)}`);
      this.status |= SR_READY;
      this.wcycle = 0;
      this.cmd = 0x00;
      return;
    }

    if (this.cmd === CMD_BLOCK_ERASE) {
      const v = Number(value & 0xffn);
      if (v === CMD_CONFIRM) {
        this.status |= SR_READY;
        this.trace('ERASE_CONFIRM');
      } else if (v === CMD_READ_ARRAY) {
        this.trace('ERASE_ABORT');
      }
      this.wcycle = 0;
      this.cmd = 0x00;
      return;
    }

    if (this.cmd === CMD_BUFFERED_PROGRAM) {
      if (this.wcycle === 1) {
        // EDK2 传 Count-1，故字数为 value+1
        const words = Number(value & 0xffffn) + 1;
        this.buf = new Uint8Array(words * 4);
        this.bufFill = 0;
        this.bufAddr = off;
        this.wcycle = 2;
        this.trace(`BUF_COUNT words=${words} @${off}`);
        return;
      }
      if (this.wcycle === 2) {
        const v = Number(value & 0xffn);
        if (v === CMD_CONFIRM && this.bufFill > 0) {
          this.commitBuffer();
          return;
        }
        if (this.buf && this.bufFill < this.buf.length) {
          for (let i = 0; i < size && this.bufFill < this.buf.length; i++) {
            this.buf[this.bufFill++] = Number((value >> BigInt(8 * i)) & 0xffn);
          }
        }
        if (this.buf && this.bufFill >= this.buf.length) this.wcycle = 3;
        return;
      }
      if (this.wcycle === 3) {
        if (Number(value & 0xffn) === CMD_CONFIRM) {
          this.commitBuffer();
        } else {
          this.trace('BUF_ABORT');
          this.buf = null;
          this.bufFill = 0;
          this.wcycle = 0;
          this.cmd = 0x00;
        }
        return;
      }
      return;
    }

    if (this.lockPending) {
      const v = Number(value & 0xffn);
      if (v === CMD_CONFIRM || v === CMD_UNLOCK_CONFIRM) this.trace('LOCK_CONFIRM(no-op)');
      else if (v === CMD_READ_ARRAY) this.trace('LOCK_ABORT');
      this.lockPending = false;
      this.wcycle = 0;
      this.cmd = 0x00;
      this.status |= SR_READY;
      return;
    }

    // 兜底
    this.wcycle = 0;
    this.cmd = 0x00;
  }

  private commitBuffer(): void {
    if (this.buf) {
      for (let i = 0; i < this.buf.length; i++) {
        const idx = this.bufAddr + i;
        if (idx >= 0 && idx < this.storage.length) this.storage[idx] &= this.buf[i];
      }
      this.trace(`BUF_COMMIT @${this.bufAddr} bytes=${this.buf.length}`);
    }
    this.buf = null;
    this.bufFill = 0;
    this.wcycle = 0;
    this.cmd = 0x00;
    this.status |= SR_READY;
  }

  /** 当前状态寄存器（调试/测试） */
  get statusRegister(): number {
    return this.status;
  }

  reset(): void {
    this.cmd = 0x00;
    this.wcycle = 0;
    this.status = SR_READY;
    this.buf = null;
    this.bufFill = 0;
    this.lockPending = false;
  }
}
