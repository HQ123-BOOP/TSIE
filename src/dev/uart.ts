/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Device, MemSize } from '../mem/types.ts';

/** 中断线回调：level=true 表示拉高 */
export type IrqLine = (level: boolean) => void;

export interface UartOptions {
  /** 发送字节的接收端（默认写到 stdout） */
  onTx?: (byte: number) => void;
  /** 中断线 */
  irq?: IrqLine;
  /** 寄存器地址间隔的移位量，QEMU virt 为 0 */
  regShift?: number;
  /** 输入源（可选，模拟键盘输入） */
  rxBuffer?: number[];
}

const REG_RBR_THR_DLL = 0;
const REG_IER_DLM = 1;
const REG_IIR_FCR = 2;
const REG_LCR = 3;
const REG_MCR = 4;
const REG_LSR = 5;
const REG_MSR = 6;
const REG_SCR = 7;

const LSR_DR = 0x01; // 接收数据就绪
const LSR_THRE = 0x20; // 发送保持寄存器空
const LSR_TEMT = 0x40; // 发送移位寄存器空

const IER_RDAI = 0x01; // 接收中断
const IER_THREI = 0x02; // 发送空中断

const IIR_NO_INT = 0x01;
const IID_THRE = 0x02;
const IID_RX = 0x04;
const IID_FIFO = 0xc0;

/**
 * NS16550A 兼容串口。支持轮询和中断两种模式，带 64 字节接收 FIFO；
 * FIFO 写满后溢出到内部无限队列，guest 每读一个字节自动回流补位——
 * 任意长度的输入（如粘贴长命令）都不会丢失。
 */
export class Uart implements Device {
  readonly name = 'uart';
  readonly size = 0x100n;

  private dll = 0;
  private dlm = 0;
  private ier = 0;
  private lcr = 0x03; // 8N1
  private mcr = 0;
  private msr = 0xb0; // CTS/DSR/CD 就绪
  private scr = 0;
  private fcr = 0;
  private rxFifo: number[] = [];
  /** FIFO 满时溢出的输入队列，guest 读取时回流进 FIFO */
  private rxQueue: number[] = [];

  private readonly onTx: (byte: number) => void;
  private readonly irq?: IrqLine;
  private readonly regShift: number;

  /** 接收到的所有输出（便于测试与调试） */
  readonly txLog: number[] = [];
  /** 直接以字符串形式取回输出 */
  get output(): string {
    return Buffer.from(this.txLog).toString('utf8');
  }

  constructor(opts: UartOptions = {}) {
    this.onTx =
      opts.onTx ??
      ((b: number) => {
        this.txLog.push(b);
        process.stdout.write(Buffer.from([b]));
      });
    this.irq = opts.irq;
    this.regShift = opts.regShift ?? 0;
    if (opts.rxBuffer) {
      for (const b of opts.rxBuffer) this.pushRx(b);
    }
  }

  private get dlab(): boolean {
    return (this.lcr & 0x80) !== 0;
  }

  /** 外部向串口输入一个字节（模拟键盘/串口输入）；FIFO 满则排队，永不丢失 */
  pushRx(byte: number): void {
    if (this.rxFifo.length < 64) this.rxFifo.push(byte & 0xff);
    else this.rxQueue.push(byte & 0xff);
    this.updateIrq();
  }

  /** 把溢出队列的字节回流进 FIFO（guest 每读一个字节调用一次） */
  private refillRx(): void {
    while (this.rxFifo.length < 64 && this.rxQueue.length > 0) {
      this.rxFifo.push(this.rxQueue.shift()!);
    }
  }

  pushString(s: string): void {
    for (const ch of s) this.pushRx(ch.charCodeAt(0));
  }

  /** 当前是否有待发送中断 */
  private irqLevel = false;
  private updateIrq(): void {
    let level = false;
    if ((this.ier & IER_RDAI) !== 0 && this.rxFifo.length > 0) level = true;
    if ((this.ier & IER_THREI) !== 0) level = true; // THRE 恒为空
    if (level !== this.irqLevel) {
      this.irqLevel = level;
      this.irq?.(level);
    }
  }

  private get iir(): number {
    let id = IIR_NO_INT;
    if ((this.ier & IER_RDAI) !== 0 && this.rxFifo.length > 0) id = IID_RX;
    else if ((this.ier & IER_THREI) !== 0) id = IID_THRE;
    return id | ((this.fcr & 0x01) !== 0 && this.fcr !== 0 ? IID_FIFO : 0);
  }

  private get lsr(): number {
    return (this.rxFifo.length > 0 ? LSR_DR : 0) | LSR_THRE | LSR_TEMT;
  }

  read(offset: bigint, _size: MemSize): bigint {
    let reg = Number((offset >> BigInt(this.regShift)) & 0xffn);
    if (this.regShift === 0) reg = Number(offset & 0xffn);
    switch (reg) {
      case REG_RBR_THR_DLL:
        if (this.dlab) return BigInt(this.dll);
        if (this.rxFifo.length === 0) return 0n;
        // 取走字节后必须重算中断线：FIFO 排空时"接收数据可用"这条物理信号要撤掉，
        // 否则电平敏感的 PLIC 会在 complete 之后立刻重新挂起（虚假中断风暴）。
        {
          const b = this.rxFifo.shift()!;
          this.refillRx(); // 溢出队列回流，FIFO 保持有数据则中断保持
          this.updateIrq();
          return BigInt(b);
        }
      case REG_IER_DLM:
        return BigInt(this.dlab ? this.dlm : this.ier);
      case REG_IIR_FCR:
        return BigInt(this.iir);
      case REG_LCR:
        return BigInt(this.lcr);
      case REG_MCR:
        return BigInt(this.mcr);
      case REG_LSR:
        return BigInt(this.lsr);
      case REG_MSR: {
        // 环回模式：MSR 反映 MCR 的回环位
        if ((this.mcr & 0x10) !== 0) {
          const loop = ((this.mcr & 0x01) << 4) | ((this.mcr & 0x02) << 5) | ((this.mcr & 0x04) << 3) | ((this.mcr & 0x08) << 6);
          return BigInt(loop | 0x10 | 0x20 | 0x80);
        }
        return BigInt(this.msr);
      }
      case REG_SCR:
        return BigInt(this.scr);
      default:
        return 0n;
    }
  }

  write(offset: bigint, value: bigint, _size: MemSize): void {
    let reg = Number((offset >> BigInt(this.regShift)) & 0xffn);
    if (this.regShift === 0) reg = Number(offset & 0xffn);
    const v = Number(value & 0xffn);
    switch (reg) {
      case REG_RBR_THR_DLL:
        if (this.dlab) {
          this.dll = v;
        } else {
          this.onTx(v);
          this.updateIrq();
        }
        return;
      case REG_IER_DLM:
        if (this.dlab) this.dlm = v;
        else this.ier = v & 0x0f;
        this.updateIrq();
        return;
      case REG_IIR_FCR:
        this.fcr = v;
        if ((v & 0x02) !== 0) {
          this.rxFifo.length = 0;
          this.rxQueue.length = 0; // FIFO 复位连同溢出队列一起清空
        }
        this.updateIrq();
        return;
      case REG_LCR:
        this.lcr = v;
        return;
      case REG_MCR:
        this.mcr = v;
        return;
      case REG_LSR:
      case REG_MSR:
        return;
      case REG_SCR:
        this.scr = v;
        return;
      default:
        return;
    }
  }
}
