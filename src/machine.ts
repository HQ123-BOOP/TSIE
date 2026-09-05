/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { alignUp } from './core/bits.ts';
import { Bus } from './mem/bus.ts';
import { RAM } from './mem/ram.ts';
import { Cpu } from './cpu/cpu.ts';
import { CSR, Exc, Irq, Priv } from './cpu/csr.ts';
import { Clint } from './dev/clint.ts';
import { Plic } from './dev/plic.ts';
import { Uart } from './dev/uart.ts';
import { TestFinisher } from './dev/test.ts';
import { VirtioBlk } from './dev/virtio-blk.ts';
import { VirtioNet } from './dev/virtio-net.ts';
import { Virtio9p } from './dev/virtio-9p.ts';
import { GoldfishRtc } from './dev/rtc.ts';
import type { NetBackend } from './dev/net.ts';
import type { DiskImage } from './dev/disk.ts';
import { loadBinary, loadElf, type LoadedImage } from './loader/elf.ts';
import { FdtNode, buildDtb } from './loader/dtb.ts';
import { SbiFirmware } from './firmware/sbi.ts';

export const VIRT_RAM_BASE = 0x80000000n;
export const VIRT_TEST = 0x100000n;
export const VIRT_CLINT = 0x2000000n;
export const VIRT_PLIC = 0xc000000n;
export const VIRT_UART0 = 0x10000000n;
export const VIRT_VIRTIO = 0x10001000n;
export const VIRT_VIRTIO_NET = 0x10002000n;
export const VIRT_VIRTIO_9P = 0x10003000n;
export const VIRT_RTC = 0x101000n;
export const VIRT_FIRMWARE = 0x80000000n;
export const VIRT_KERNEL = 0x80200000n;
export const VIRT_DTB = 0x82200000n;

/** PLIC 中断源编号 */
const IRQ_VIRTIO = 1;
const IRQ_VIRTIO_NET = 2;
const IRQ_VIRTIO_9P = 3;
const IRQ_UART = 10;
const IRQ_RTC = 11;

export interface MachineOptions {
  /** 内存大小（字节），默认 512 MiB */
  memSize?: bigint;
  /** 块设备镜像 */
  disk?: DiskImage;
  /** 网络后端（提供则挂载 virtio-net 网卡） */
  net?: NetBackend;
  /** Host 共享目录（提供则挂载 virtio-9p 设备，guest 内挂载 tag=hostshare） */
  shared?: string;
  /** 9p 挂载 tag（默认 hostshare） */
  sharedTag?: string;
  /** 固件（OpenSBI fw_jump.bin 等） */
  bios?: Uint8Array;
  /** 内核 ELF / 裸机程序 */
  kernel?: Uint8Array | { data: Uint8Array; loadAt: bigint };
  /** initrd / 附加数据 */
  initrd?: Uint8Array;
  /** 内核命令行 */
  cmdline?: string;
  /** timebase 频率（Hz），默认 10 MHz */
  timebaseFrequency?: number;
  /** 每多少条指令推进一次 mtime */
  cyclesPerTick?: number;
  /** 非对齐访存策略 */
  misaligned?: 'trap' | 'slow';
  /** 串口输出回调（逐字节） */
  stdout?: (byte: number) => void;
  /** 是否启用内建 SBI（未提供 bios 时默认启用） */
  useBuiltinSbi?: boolean;
  /** 入口地址（裸机程序） */
  entry?: bigint;
}

export interface RunOptions {
  maxInstructions?: number;
  /** 每步回调，返回 false 停止 */
  onStep?: (cpu: Cpu, count: number) => boolean | void;
}

export interface RunInteractiveOptions {
  maxInstructions?: number;
  /** 每个分块执行的指令数，块与块之间让出事件循环（默认 100 万） */
  chunk?: number;
  /** 每步回调（转发给每个分块的 run），返回 false 停止当前分块 */
  onStep?: (cpu: Cpu, count: number) => boolean | void;
  /** 每个分块结束后回调；返回 false 停止。用于处理排队中的键盘输入等 */
  afterChunk?: (total: number) => boolean | void;
}

export interface MachineStats {
  instructions: number;
  seconds: number;
  ips: number;
}

/**
 * `virt` 机器模型：RAM + CLINT + PLIC + NS16550 + VirtIO 块设备 + SiFive Test。
 */
export class Machine {
  readonly bus = new Bus();
  readonly ram: RAM;
  readonly cpu: Cpu;
  readonly uart: Uart;
  /** 慢指令统计（调试）：单条 step >1ms 的 pc → 次数 */
  slowSteps = new Map<number, number>();
  readonly clint = new Clint();
  readonly plic: Plic;
  readonly virtio?: VirtioBlk;
  readonly netdev?: VirtioNet;
  readonly test: TestFinisher;
  readonly rtc: GoldfishRtc;
  readonly virtio9p?: Virtio9p;
  readonly sbi?: SbiFirmware;

  readonly ramBase = VIRT_RAM_BASE;
  readonly ramSize: bigint;
  readonly timebaseFrequency: number;
  readonly cyclesPerTick: number;
  /** WFI 快进：每条空闲指令推进的 tick 数（1.6µs × timebase/10MHz） */
  private readonly wfiFastForward: number;

  /** DTB 在物理内存中的地址 */
  dtbAddress = 0n;
  /** 已加载镜像的结束地址（DTB 之后放置） */
  private imageEnd = VIRT_RAM_BASE;
  kernelEntry = 0n;
  firmwareEntry = 0n;
  initrdStart = 0n;
  initrdEnd = 0n;

  exitCode: number | null = null;
  exitReason = '';

  private kernelImage?: LoadedImage;

  constructor(opts: MachineOptions = {}) {
    this.ramSize = opts.memSize ?? 512n * 1024n * 1024n;
    this.timebaseFrequency = opts.timebaseFrequency ?? 10_000_000;
    this.cyclesPerTick = opts.cyclesPerTick ?? 1;
    // WFI 快进速率：每条空闲指令推进 1.6µs 虚拟时间（10MHz 时 = 16 tick，
    // 与历史行为一致；timebase 变更时按比例缩放，收敛速度与频率无关）
    this.wfiFastForward = Math.max(1, Math.round(this.timebaseFrequency / 625_000));

    this.ram = new RAM(this.ramSize);
    this.bus.addDevice(this.ramBase, this.ram);
    this.bus.addDevice(VIRT_CLINT, this.clint);
    this.plic = new Plic(32, 2);
    this.bus.addDevice(VIRT_PLIC, this.plic);

    this.uart = new Uart({
      onTx:
        opts.stdout ??
        ((b: number) => {
          this.uart.txLog.push(b);
          process.stdout.write(Buffer.from([b]));
        }),
      irq: (level) => this.plic.setIrq(IRQ_UART, level),
    });
    this.bus.addDevice(VIRT_UART0, this.uart);

    this.test = new TestFinisher((code, reason) => this.shutdown(code, reason));
    this.bus.addDevice(VIRT_TEST, this.test);

    // Goldfish RTC：给 guest 真实墙钟（RTC_HCTOSYS 启动时校准系统时钟）。
    // 闹钟中断未实现，无需接 PLIC——DTB 仍声明 IRQ 11 以匹配 QEMU virt。
    this.rtc = new GoldfishRtc();
    this.bus.addDevice(VIRT_RTC, this.rtc);

    if (opts.disk) {
      this.virtio = new VirtioBlk(this.bus, opts.disk, (level) => this.plic.setIrq(IRQ_VIRTIO, level));
      this.bus.addDevice(VIRT_VIRTIO, this.virtio);
    }

    if (opts.net) {
      this.netdev = new VirtioNet(this.bus, opts.net, (level) => this.plic.setIrq(IRQ_VIRTIO_NET, level));
      this.bus.addDevice(VIRT_VIRTIO_NET, this.netdev);
    }

    if (opts.shared) {
      this.virtio9p = new Virtio9p(this.bus, (level) => this.plic.setIrq(IRQ_VIRTIO_9P, level), opts.shared, opts.sharedTag);
      this.bus.addDevice(VIRT_VIRTIO_9P, this.virtio9p);
    }

    this.cpu = new Cpu(this.bus, { misaligned: opts.misaligned ?? 'trap' });
    // MMU 直读快路径：指令/数据访问命中 RAM 时绕过 bus 分发与 BigInt 装箱
    this.cpu.mmu.fastRam = {
      base: Number(this.ramBase),
      end: Number(this.ramBase + this.ramSize),
      data: this.ram.data,
      view: this.ram.view,
    };
    // 含未结算子刻度：使 mtime 抖动对 guest 的 rdtime 保持逐指令粒度
    this.cpu.timeSource = () => this.currentTime();
    this.plic.bindContext(0, (level) => {
      this.plicLevelM = level;
      this.syncIrqs();
    });
    this.plic.bindContext(1, (level) => {
      this.plicLevelS = level;
      this.syncIrqs();
    });

    if (opts.useBuiltinSbi ?? opts.bios === undefined) {
      this.sbi = new SbiFirmware({
        clint: this.clint,
        uart: this.uart,
        shutdown: (reason) => this.shutdown(0, reason),
      });
      this.cpu.sbi = this.sbi;
    }

    // 加载顺序：固件 → 内核 → initrd → DTB
    if (opts.bios) this.loadFirmware(opts.bios);
    if (opts.kernel) {
      const data = opts.kernel instanceof Uint8Array ? opts.kernel : opts.kernel.data;
      const loadAt = opts.kernel instanceof Uint8Array ? undefined : opts.kernel.loadAt;
      this.loadKernel(data, loadAt);
    }
    if (opts.initrd) this.loadInitrd(opts.initrd);

    const cmdline = opts.cmdline ?? '';
    this.placeDtb(cmdline);

    const entry = opts.entry ?? (this.firmwareEntry !== 0n ? this.firmwareEntry : this.kernelEntry);
    this.cpu.reset(entry);
    if (this.sbi) this.setupDefaultMmodeState();
    // RISC-V 启动约定：a0 = hartid，a1 = DTB 物理地址
    this.cpu.x[10] = BigInt(this.cpu.hartId);
    this.cpu.x[11] = this.dtbAddress;
  }

  /** 内建 SBI 时初始化 M 模式状态（中断委派等） */
  private setupDefaultMmodeState(): void {
    // 把 S 模式的软件/定时器/外部中断委派给 S 模式
    this.cpu.csr.writeRaw(CSR.MIDELEG, (1n << 1n) | (1n << 5n) | (1n << 9n));
    // 常规异常委派给 S 模式；S 模式 ECALL（SBI 调用）保留在 M 模式
    this.cpu.csr.writeRaw(CSR.MEDELEG, 0xfdffn);
    // 与 OpenSBI 一致：M 模式打开定时器与软件中断，再由 SBI 转发给 S 模式
    this.cpu.csr.writeRaw(CSR.MIE, (1n << BigInt(Irq.MTimer)) | (1n << BigInt(Irq.MSoftware)));
    // M 模式异常入口：指向 RAM 起始（正常不会到达）
    this.cpu.csr.writeRaw(CSR.MTVEC, this.ramBase);
    this.cpu.csr.writeRaw(CSR.MSCRATCH, 0n);
  }

  private shutdown(code: number, reason: string): void {
    this.exitCode = code;
    this.exitReason = reason;
    this.cpu.halt(reason, code);
  }

  // ------------------------------------------------------------------
  // 镜像加载
  // ------------------------------------------------------------------

  private loadFirmware(data: Uint8Array): void {
    const base = VIRT_FIRMWARE;
    try {
      const img = loadElf(this.bus, data, { ramBase: this.ramBase, ramSize: this.ramSize });
      this.firmwareEntry = img.entry;
      this.imageEnd = img.physEnd;
    } catch {
      // 非 ELF：按裸二进制加载
      this.bus.writeBytes(base, data);
      this.firmwareEntry = base;
      this.imageEnd = base + BigInt(data.length);
    }
  }

  private loadKernel(data: Uint8Array, loadAt?: bigint): void {
    const dest = loadAt ?? VIRT_KERNEL;
    try {
      const img = loadElf(this.bus, data, {
        ramBase: this.ramBase,
        ramSize: this.ramSize,
        loadAt: dest,
      });
      this.kernelEntry = img.entry;
      this.imageEnd = img.physEnd;
      this.kernelImage = img;
    } catch {
      const r = loadBinary(this.bus, data, dest);
      this.kernelEntry = r.entry;
      this.imageEnd = r.physEnd;
    }
  }

  private loadInitrd(data: Uint8Array): void {
    const base = alignUp(this.imageEnd + 0x100000n, 0x100000n);
    this.bus.writeBytes(base, data);
    this.initrdStart = base;
    this.initrdEnd = base + BigInt(data.length);
    this.imageEnd = this.initrdEnd;
  }

  private placeDtb(cmdline: string): void {
    // DTB 紧跟镜像（内核+initrd）之后、2MB 对齐放置，并由 a1 直接传给 OpenSBI/内核。
    // 不能再用固定 VIRT_DTB：大 initrd（Debian 42MB）会把它覆盖成垃圾，
    // 内核读到的 FDT 无效导致启动即卡死。DTB 本身只有几十 KB，放镜像尾端最安全。
    const dtbAddr = alignUp(this.imageEnd, 0x200000n) + 0x200000n;
    const blob = this.generateDtb(cmdline);
    this.bus.writeBytes(dtbAddr, blob);
    this.dtbAddress = dtbAddr;
    this.imageEnd = dtbAddr + BigInt(blob.length);
  }

  /** 生成设备树 */
  generateDtb(cmdline: string): Uint8Array {
    const root = new FdtNode('');
    root.propU32('#address-cells', [2]);
    root.propU32('#size-cells', [2]);
    root.propStr('compatible', 'riscv-virtio');
    root.propStr('model', 'ts-riscv64,virt');

    const chosen = root.addChild('chosen');
    chosen.propStr('bootargs', cmdline);
    chosen.propStr('stdout-path', '/soc/serial@10000000');
    if (this.initrdStart !== 0n) {
      chosen.propU64('linux,initrd-start', [this.initrdStart]);
      chosen.propU64('linux,initrd-end', [this.initrdEnd]);
    }
    // rng-seed：内核极早期（early_init_dt_scan_chosen → add_bootloader_randomness）
    // 就把它加进熵池，读完自动 NOP 掉该属性。没有它，模拟器时序确定、
    // jitter entropy 采不出熵，内核 RNG 初始化会无限自旋（Debian 13 实测
    // Run /init 后 blake2s/chacha 自检烧光 4B 指令预算）。
    {
      const seed = new Uint8Array(4096);
      crypto.getRandomValues(seed);
      chosen.prop('rng-seed', seed);
    }

    const cpus = root.addChild('cpus');
    cpus.propU32('#address-cells', [1]);
    cpus.propU32('#size-cells', [0]);
    cpus.propU32('timebase-frequency', [this.timebaseFrequency]);

    const cpu0 = cpus.addChild('cpu@0');
    cpu0.propStr('device_type', 'cpu');
    cpu0.propU32('reg', [0]);
    cpu0.propStr('status', 'okay');
    cpu0.propStr('compatible', 'riscv');
    cpu0.propStr('riscv,isa', 'rv64imafdcsu');
    cpu0.propStr('mmu-type', 'riscv,sv48');
    const intc = cpu0.addChild('interrupt-controller');
    intc.propU32('#address-cells', [0]);
    intc.propU32('#interrupt-cells', [1]);
    intc.propEmpty('interrupt-controller');
    intc.propStr('compatible', 'riscv,cpu-intc');
    intc.propU32('phandle', [1]);

    const mem = root.addChild(`memory@${this.ramBase.toString(16)}`);
    mem.propStr('device_type', 'memory');
    mem.propReg('reg', [[this.ramBase, this.ramSize]]);

    const soc = root.addChild('soc');
    soc.propU32('#address-cells', [2]);
    soc.propU32('#size-cells', [2]);
    soc.propStr('compatible', 'simple-bus');
    soc.propEmpty('ranges');

    const clintNode = soc.addChild(`clint@${VIRT_CLINT.toString(16)}`);
    clintNode.propStr('compatible', 'riscv,clint0');
    clintNode.propU32('interrupts-extended', [1, Irq.MSoftware, 1, Irq.MTimer]);
    clintNode.propReg('reg', [[VIRT_CLINT, 0x10000n]]);

    const plicNode = soc.addChild(`plic@${VIRT_PLIC.toString(16)}`);
    plicNode.propU32('#address-cells', [0]);
    plicNode.propU32('#interrupt-cells', [1]);
    plicNode.propEmpty('interrupt-controller');
    plicNode.propStr('compatible', 'riscv,plic0');
    plicNode.propU32('riscv,ndev', [32]);
    // 顺序必须与 PLIC 的上下文编号一致：上下文 0 = hart0 M 模式，
    // 上下文 1 = hart0 S 模式（QEMU virt 的 "MS" 配置）。
    // 曾把 SExternal 写在前面，导致 Linux 把 S 模式上下文认成 index 0，
    // 于是外设中断的使能位被写进 M 模式上下文：mip.MEIP 置起但 mip.SEIP 恒为 0，
    // 而 S 模式内核在 U 态下 mstatus.MIE=0，中断永远进不来 ——
    // 表现就是用户态 write() 全部成功、串口一个字节都不吐（printk 走轮询故不受影响）。
    plicNode.propU32('interrupts-extended', [1, Irq.MExternal, 1, Irq.SExternal]);
    plicNode.propReg('reg', [[VIRT_PLIC, 0x4000000n]]);
    plicNode.propU32('phandle', [2]);

    const uartNode = soc.addChild(`serial@${VIRT_UART0.toString(16)}`);
    uartNode.propStr('compatible', 'ns16550a');
    uartNode.propU32('clock-frequency', [3686400]);
    uartNode.propReg('reg', [[VIRT_UART0, 0x100n]]);
    uartNode.propU32('interrupts', [IRQ_UART]);
    uartNode.propU32('interrupt-parent', [2]);

    if (this.virtio) {
      const vioNode = soc.addChild(`virtio_mmio@${VIRT_VIRTIO.toString(16)}`);
      vioNode.propStr('compatible', 'virtio,mmio');
      vioNode.propReg('reg', [[VIRT_VIRTIO, 0x1000n]]);
      vioNode.propU32('interrupts', [IRQ_VIRTIO]);
      vioNode.propU32('interrupt-parent', [2]);
    }

    if (this.netdev) {
      const netNode = soc.addChild(`virtio_mmio@${VIRT_VIRTIO_NET.toString(16)}`);
      netNode.propStr('compatible', 'virtio,mmio');
      netNode.propReg('reg', [[VIRT_VIRTIO_NET, 0x1000n]]);
      netNode.propU32('interrupts', [IRQ_VIRTIO_NET]);
      netNode.propU32('interrupt-parent', [2]);
    }

    if (this.virtio9p) {
      const p9Node = soc.addChild(`virtio_mmio@${VIRT_VIRTIO_9P.toString(16)}`);
      p9Node.propStr('compatible', 'virtio,mmio');
      p9Node.propReg('reg', [[VIRT_VIRTIO_9P, 0x1000n]]);
      p9Node.propU32('interrupts', [IRQ_VIRTIO_9P]);
      p9Node.propU32('interrupt-parent', [2]);
    }

    const testNode = soc.addChild(`test@${VIRT_TEST.toString(16)}`);
    testNode.propStr('compatible', 'sifive,test0');
    testNode.propReg('reg', [[VIRT_TEST, 0x1000n]]);

    // Goldfish RTC（QEMU virt 同款：0x101000 / PLIC 源 11）
    const rtcNode = soc.addChild(`rtc@${VIRT_RTC.toString(16)}`);
    rtcNode.propStr('compatible', 'google,goldfish-rtc');
    rtcNode.propReg('reg', [[VIRT_RTC, 0x1000n]]);
    rtcNode.propU32('interrupts', [IRQ_RTC]);
    rtcNode.propU32('interrupt-parent', [2]);

    return buildDtb(root);
  }

  // ------------------------------------------------------------------
  // 中断同步与执行
  // ------------------------------------------------------------------

  /**
   * 把 CLINT / PLIC 的挂起状态同步到 CPU 中断线（带变化检测，可逐指令调用）。
   * 热路径优化：先用 Number 位掩码做变化检测，只有真正变化时才构造 BigInt
   * （原实现每条指令都执行 `1n << BigInt(...)`，BigInt 分配是主要瓶颈之一）。
   */
  syncIrqs(): void {
    let n = 0;
    if (this.clint.timerPending) n |= 1;
    if (this.clint.softwarePending) n |= 2;
    if (this.plicLevelM) n |= 4;
    if (this.plicLevelS) n |= 8;
    if (n === this.irqLinesNum) return;
    this.irqLinesNum = n;
    let lines = 0n;
    if (n & 1) lines |= this.irqMaskMTimer;
    if (n & 2) lines |= this.irqMaskMSoft;
    if (n & 4) lines |= this.irqMaskMExt;
    if (n & 8) lines |= this.irqMaskSExt;
    this.cpu.setIrqLines(lines);
  }

  /**
   * 定时器到期检测（mtime 只在 settleTime 推进，两次结算之间比较结果不变）。
   * run() 每 64 条指令调用一次——比逐指令 BigInt 比较省 64 倍。
   * 其他中断线（软件/PLIC）本来就是事件驱动：设备回调 syncIrqs 即时下发。
   * 注意顺序：先同步线，CPU 才能在后续 step 里看到 pending。
   */
  private tickTimerIrq(): void {
    if (this.clint.timerPending !== !!(this.irqLinesNum & 1)) this.syncIrqs();
  }

  /** 中断线掩码常量（构造一次，避免热路径重复分配 BigInt） */
  private readonly irqMaskMTimer = 1n << BigInt(Irq.MTimer);
  private readonly irqMaskMSoft = 1n << BigInt(Irq.MSoftware);
  private readonly irqMaskMExt = 1n << BigInt(Irq.MExternal);
  private readonly irqMaskSExt = 1n << BigInt(Irq.SExternal);

  /** Number 形式的中断线缓存（-1 = 尚未初始化，保证首次必定下发） */
  private irqLinesNum = -1;

  /** PLIC 两个上下文（0=M，1=S）的中断输出电平 */
  private plicLevelM = false;
  private plicLevelS = false;

  /**
   * PLIC 各上下文当前的中断输出电平（诊断用，下标即上下文号：0=M、1=S）。
   * 排查「外设中断进不了 CPU」时，先对比它和 DTB 里 interrupts-extended
   * 声明的顺序是否一致。
   */
  get plicContextLevels(): readonly boolean[] {
    return [this.plicLevelM, this.plicLevelS];
  }

  /**
   * mtime 抖动：每条指令推进时叠加确定性伪随机增量。
   * 真实硬件上 mtime 是自由运行计数器，与指令流异步（存在抖动）；
   * 若 mtime 与指令数严格线性，jitterentropy 等依赖时间抖动的子系统
   * （如内核 CRNG 的 jent_mod_init）会因采样到恒定 delta 而死循环。
   * 抖动以绝对指令计数为种子（xorshift32），循环每迭代一次采样窗口就沿
   * 伪随机序列滑动一格 → 各次采样 delta 不同，能产出真实熵；固定种子
   * 保证仿真可复现。
   */
  private mtimeJitterState = 0x9e3779b9;

  /**
   * 自上次结算以来累计的 mtime 增量（Number，含逐指令抖动）。
   * 热路径只做 Number 加法，避免每条指令分配 BigInt；
   * guest 读 time CSR 时会把它加进去（见 timeSource 接线），
   * 因此**抖动对 rdtime 而言仍是逐指令粒度**，与直接改 BigInt 完全等价。
   */
  private timeSub = 0;

  /**
   * mtime 逐指令增量查表（16 项，总和 16 → 均值严格 1.0）。
   *
   * 早期版本用 {0,1,1,2}（仅 ±1 波动），幅度太窄：jitterentropy 判定「stuck」
   * 的依据是采样 delta 的一阶/二阶/三阶差分只要有一个为 0 就作废，而窄分布下
   * 相邻 delta 极易相等 → 绝大多数采样被丢弃 → jent 反复重采，在 keccak 置换上
   * 白烧上亿条指令。
   *
   * 这里改为「多数微增 + 偶发大跳」的宽分布（0/1/2/8，1/16 概率跳 8），
   * delta 的取值空间显著变宽，二阶、三阶差分几乎不可能归零，
   * 同时长期均值仍为 1.0，虚拟时间流速不失真。
   */
  private static readonly MTIME_JITTER_TABLE = new Int32Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, // 9 × 0
    1, 1, 1, 1,                // 4 × 1
    2, 2,                      // 2 × 2
    8,                         // 1 × 8（偶发大跳，拉宽 delta 分布）
  ]);

  /** 每条指令累计 mtime 增量，叠加宽幅抖动（均值 1，整体速率≈cyclesPerTick） */
  private advanceTimeSub(): void {
    let x = this.mtimeJitterState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.mtimeJitterState = x;
    const extra = Machine.MTIME_JITTER_TABLE[(x >>> 11) & 15]!;
    let inc = this.cyclesPerTick - 1 + extra;
    if (inc < 0) inc = 0;
    this.timeSub += inc;
  }

  /** 把累计的子刻度结算进 clint.mtime（每 64 条指令一次，摊薄 BigInt 开销） */
  private settleTime(): void {
    if (this.timeSub !== 0) {
      this.clint.mtime += BigInt(this.timeSub);
      this.timeSub = 0;
    }
  }

  /** guest 可见的当前时间（含尚未结算的子刻度） */
  currentTime(): bigint {
    return this.timeSub === 0 ? this.clint.mtime : this.clint.mtime + BigInt(this.timeSub);
  }

  /** 运行若干条指令 */
  run(opts: RunOptions = {}): MachineStats {
    const limit = opts.maxInstructions ?? Number.POSITIVE_INFINITY;
    const started = performance.now();
    let count = 0;
    const cpu = this.cpu;
    const TICK_MASK = 0x3f;

    // 性能关键：performance.now() 在 Windows 是 QPC 系统调用，
    // 每条指令调 2 次（看门狗计时）会吃掉可观吞吐。改为每 64 条
    // （TICK_MASK 节拍）采一次时间：批均值超过 2000ms*64 才判死循环
    // ——单条巨慢指令（virtio 大请求）会被批均值稀释，因此阈值按
    // 「单条 2s」语义换算为批总耗时 > 128s 仍会拦截；慢指令统计同理
    // 按批均值归到批首 PC（定位足够用）。
    let batchStart = performance.now();

    while (count < limit && !cpu.halted) {
      // 定时器到期检测（内部有变化才走完整同步，常态一次 BigInt 比较）；
      // 软件/PLIC 中断线由设备回调即时下发，无需逐指令轮询
      this.tickTimerIrq();
      cpu.step();
      this.advanceTimeSub();
      count++;
      if ((count & TICK_MASK) === 0) {
        const batchMs = performance.now() - batchStart;
        const perInst = batchMs / 64;
        // 慢指令统计（调试）：折算单条 >1ms 记录批首 pc
        if (perInst > 1) {
          this.slowSteps.set(Number(cpu.pc), (this.slowSteps.get(Number(cpu.pc)) ?? 0) + 1);
        }
        // 看门狗：折算单条 >2s 说明卡死（正常指令微秒级），立即抛出
        // 避免 ENOSPC 级静默挂起。注意阈值不能太小：U-Boot ext4load
        // 单笔 31~42MB virtio 请求在单步内同步完成磁盘读+写内存，
        // 冷缓存下 ~300-500ms（曾以 200ms 阈值误杀 31MB 内核加载）。
        if (perInst > 2000) {
          throw new Error(`step() 疑似死循环: pc=0x${cpu.pc.toString(16)} priv=${cpu.priv} count=${count}`);
        }
        batchStart = performance.now();
        this.settleTime();
        if (opts.onStep && opts.onStep(cpu, count) === false) break;
      }
      if (cpu.wfi) {
        // 空闲等待时加速时间推进：每条空闲指令推进 1.6µs 虚拟时间
        // （默认 10MHz → 16 tick；timebase 提到 100MHz 后按比例放大，
        // 保证「10ms 虚拟睡眠 ≈ 6 千条空闲指令收敛」与频率无关）
        this.timeSub += this.wfiFastForward;
      }
    }
    this.settleTime();
    this.syncIrqs();

    const seconds = (performance.now() - started) / 1000;
    return {
      instructions: count,
      seconds,
      ips: seconds > 0 ? count / seconds : count,
    };
  }

  /**
   * 交互式运行：分块执行，块与块之间让出事件循环，
   * 使 stdin 等异步输入能被处理（同步 run() 会一直阻塞事件循环）。
   * 每个分块结束调用 afterChunk（返回 false 停止），
   * 之后 `await setImmediate()` 让排队的输入事件落地。
   */
  async runInteractive(opts: RunInteractiveOptions = {}): Promise<MachineStats> {
    const chunk = opts.chunk ?? 1_000_000;
    const limit = opts.maxInstructions ?? Number.POSITIVE_INFINITY;
    const started = performance.now();
    let total = 0;
    // 关键：run() 的 count 每个分块从 0 开始，直接把 onStep 透传会导致回调拿到
    // 的是「块内计数」—— 依赖 count 做定时（注入间隔/心跳）的逻辑会在跨块后失效
    // （曾导致 U-Boot 长命令的第二块永不推送、load 永不开始、心跳只打一次）。
    // 包装成全局计数：total + 块内偏移。
    const onStep = opts.onStep;
    const wrappedOnStep = onStep ? (cpu: Cpu, count: number) => onStep(cpu, total + count) : undefined;
    while (total < limit && !this.cpu.halted) {
      const left = Math.min(chunk, limit - total);
      const s = this.run({ maxInstructions: left, onStep: wrappedOnStep });
      if (s.instructions === 0) break; // 已停机或卡死
      total += s.instructions;
      if (opts.afterChunk && opts.afterChunk(total) === false) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const seconds = (performance.now() - started) / 1000;
    return { instructions: total, seconds, ips: seconds > 0 ? total / seconds : total };
  }

  /** 调试信息：CPU 状态 + 关键 CSR */
  dumpState(): string {
    const c = this.cpu;
    const privName = ['U', 'S', 'H', 'M'][c.priv];
    const lines = [
      `pc       = 0x${c.pc.toString(16).padStart(16, '0')}`,
      `priv     = ${privName}`,
      `instret  = ${c.instret}`,
      `mstatus  = 0x${(c.csr.read(CSR.MSTATUS) ?? 0n).toString(16).padStart(16, '0')}`,
      `mcause   = 0x${(c.csr.read(CSR.MCAUSE) ?? 0n).toString(16)}`,
      `mepc     = 0x${(c.csr.read(CSR.MEPC) ?? 0n).toString(16)}`,
      `mtval    = 0x${(c.csr.read(CSR.MTVAL) ?? 0n).toString(16)}`,
      `satp     = 0x${(c.csr.read(CSR.SATP) ?? 0n).toString(16)}`,
      `scause   = 0x${(c.csr.read(CSR.SCAUSE) ?? 0n).toString(16)}`,
      `sepc     = 0x${(c.csr.read(CSR.SEPC) ?? 0n).toString(16)}`,
      `mip/mie  = 0x${(c.csr.read(CSR.MIP) ?? 0n).toString(16)} / 0x${(c.csr.read(CSR.MIE) ?? 0n).toString(16)}`,
      `mtime    = ${this.clint.mtime}`,
      `exit     = ${this.exitReason} (${this.exitCode})`,
    ];
    return lines.join('\n');
  }

  /** 当前异常名称（调试用） */
  static exceptionName(cause: bigint): string {
    const code = Number(cause & ~0x8000000000000000n);
    const isInt = (cause & 0x8000000000000000n) !== 0n;
    const names: Record<number, string> = {
      [Exc.InstAddrMisaligned]: 'instruction-address-misaligned',
      [Exc.InstAccessFault]: 'instruction-access-fault',
      [Exc.IllegalInstruction]: 'illegal-instruction',
      [Exc.Breakpoint]: 'breakpoint',
      [Exc.LoadAddrMisaligned]: 'load-address-misaligned',
      [Exc.LoadAccessFault]: 'load-access-fault',
      [Exc.StoreAddrMisaligned]: 'store-address-misaligned',
      [Exc.StoreAccessFault]: 'store-access-fault',
      [Exc.EnvCallFromU]: 'ecall-u',
      [Exc.EnvCallFromS]: 'ecall-s',
      [Exc.EnvCallFromM]: 'ecall-m',
      [Exc.InstPageFault]: 'instruction-page-fault',
      [Exc.LoadPageFault]: 'load-page-fault',
      [Exc.StorePageFault]: 'store-page-fault',
    };
    return `${isInt ? 'irq' : 'exc'}:${names[code] ?? code}`;
  }

  /** CPU 当前是否处于 M 模式（供调试脚本判断） */
  get inMachineMode(): boolean {
    return this.cpu.priv === Priv.M;
  }

  get kernelEnd(): bigint {
    return this.kernelImage?.physEnd ?? 0n;
  }
}
