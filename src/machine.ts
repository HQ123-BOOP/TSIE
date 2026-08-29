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
export const VIRT_FIRMWARE = 0x80000000n;
export const VIRT_KERNEL = 0x80200000n;
export const VIRT_DTB = 0x82200000n;

/** PLIC 中断源编号 */
const IRQ_VIRTIO = 1;
const IRQ_UART = 10;

export interface MachineOptions {
  /** 内存大小（字节），默认 512 MiB */
  memSize?: bigint;
  /** 块设备镜像 */
  disk?: DiskImage;
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
  readonly clint = new Clint();
  readonly plic: Plic;
  readonly virtio?: VirtioBlk;
  readonly test: TestFinisher;
  readonly sbi?: SbiFirmware;

  readonly ramBase = VIRT_RAM_BASE;
  readonly ramSize: bigint;
  readonly timebaseFrequency: number;
  readonly cyclesPerTick: number;

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

    if (opts.disk) {
      this.virtio = new VirtioBlk(this.bus, opts.disk, (level) => this.plic.setIrq(IRQ_VIRTIO, level));
      this.bus.addDevice(VIRT_VIRTIO, this.virtio);
    }

    this.cpu = new Cpu(this.bus, { misaligned: opts.misaligned ?? 'trap' });
    this.cpu.timeSource = () => this.clint.mtime;
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
    // 有固件时 DTB 放在 OpenSBI 期望的位置，否则紧跟镜像之后
    const dtbAddr = this.firmwareEntry !== 0n ? VIRT_DTB : alignUp(this.imageEnd, 0x200000n) + 0x200000n;
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
    plicNode.propU32('interrupts-extended', [1, Irq.SExternal, 1, Irq.MExternal]);
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

    const testNode = soc.addChild(`test@${VIRT_TEST.toString(16)}`);
    testNode.propStr('compatible', 'sifive,test0');
    testNode.propReg('reg', [[VIRT_TEST, 0x1000n]]);

    return buildDtb(root);
  }

  // ------------------------------------------------------------------
  // 中断同步与执行
  // ------------------------------------------------------------------

  /** 把 CLINT / PLIC 的挂起状态同步到 CPU 中断线（带变化检测，可逐指令调用） */
  syncIrqs(): void {
    let lines = 0n;
    if (this.clint.timerPending) lines |= 1n << BigInt(Irq.MTimer);
    if (this.clint.softwarePending) lines |= 1n << BigInt(Irq.MSoftware);
    if (this.plicLevelM) lines |= 1n << BigInt(Irq.MExternal);
    if (this.plicLevelS) lines |= 1n << BigInt(Irq.SExternal);
    if (lines === this.irqLinesValue) return;
    this.irqLinesValue = lines;
    this.cpu.setIrqLines(lines);
  }

  private irqLinesValue = 0n;

  /** PLIC 两个上下文（0=M，1=S）的中断输出电平 */
  private plicLevelM = false;
  private plicLevelS = false;

  /**
   * mtime 抖动源：固定种子的 xorshift32。
   * 真实硬件上 mtime 是自由运行计数器，与指令流不同步（存在抖动）；
   * 若 mtime 与指令数严格线性，jitterentropy 等依赖时间抖动的子系统
   * （如内核 CRNG 的 jent_mod_init）会因采样恒定 delta 而死循环。
   * 固定种子保证仿真可复现。
   */
  private mtimeJitterState = 0x9e3779b9;

  private mtimeJitter(): bigint {
    let x = this.mtimeJitterState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.mtimeJitterState = x;
    // 映射到 [-8, +7]，相对 64 条指令一档的 tick 约 ±12%
    return BigInt((x & 0xf) - 8);
  }

  /** 推进设备状态（mtime 等） */
  private tick(instructions: number): void {
    this.clint.mtime += BigInt(instructions * this.cyclesPerTick) + this.mtimeJitter();
    this.syncIrqs();
  }

  /** 运行若干条指令 */
  run(opts: RunOptions = {}): MachineStats {
    const limit = opts.maxInstructions ?? Number.POSITIVE_INFINITY;
    const started = performance.now();
    let count = 0;
    const cpu = this.cpu;
    const TICK_MASK = 0x3f;

    while (count < limit && !cpu.halted) {
      // 逐指令同步中断线：定时器/软件中断可能在任意时刻到期
      this.syncIrqs();
      cpu.step();
      count++;
      if ((count & TICK_MASK) === 0) {
        this.tick(TICK_MASK + 1);
        if (opts.onStep && opts.onStep(cpu, count) === false) break;
      }
      if (cpu.wfi) {
        // 空闲等待时加速时间推进，避免无意义空转
        this.clint.mtime += 16n;
      }
    }
    this.tick(count & TICK_MASK);

    const seconds = (performance.now() - started) / 1000;
    return {
      instructions: count,
      seconds,
      ips: seconds > 0 ? count / seconds : count,
    };
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
