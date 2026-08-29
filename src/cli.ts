#!/usr/bin/env node
/**
 * ts-riscv64 —— RISC-V 64 位模拟器命令行入口
 *
 *   tsx src/cli.ts --kernel vmlinux --disk rootfs.img --append "console=ttyS0 root=/dev/vda"
 *   tsx src/cli.ts --kernel hello.bin --trace --stats
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Machine, type MachineStats } from './machine.ts';
import { FileDisk } from './dev/disk.ts';
import { CSR } from './cpu/csr.ts';

interface Args {
  kernel?: string;
  bios?: string;
  disk?: string;
  initrd?: string;
  append: string;
  memory: bigint;
  loadAt?: bigint;
  maxInstructions: number;
  trace: boolean;
  traceFrom: bigint;
  dumpDtb?: string;
  stats: boolean;
  misaligned: 'trap' | 'slow';
  script?: string;
  interactive: boolean;
  help: boolean;
}

const HELP = `
ts-riscv64 —— 用 TypeScript 实现的 RISC-V64 (RV64GC) 全系统模拟器

用法:
  riscv64 [选项] --kernel <镜像>

选项:
  -k, --kernel <file>       内核 / 裸机程序（ELF64 或裸二进制）
  -b, --bios <file>         固件（如 OpenSBI fw_jump.bin），缺省时启用内建 SBI
  -d, --disk <file>         磁盘镜像（挂载为 VirtIO 块设备）
  -i, --initrd <file>       initrd 镜像
  -a, --append <string>     内核命令行
  -m, --memory <size>       内存大小，支持 K/M/G 后缀（默认 512M）
      --load-at <addr>      内核加载地址（默认 0x80200000）
  -n, --max <n>             最多执行的指令数
      --trace               打印指令流
      --trace-from <addr>   从指定地址开始打印
      --dump-dtb <file>     把生成的设备树写到文件
      --stats               运行结束后打印统计信息
      --script <file>        把文件中的每一行作为控制台输入逐条喂入（用于交互式固件）
      --interactive          交互模式：键盘输入接到串口接收（登录 Linux shell 后可直接敲命令）
      --misaligned <mode>   非对齐访存策略：trap（默认）或 slow
  -h, --help                显示帮助
`;

function parseSize(s: string): bigint {
  const m = /^(\d+)\s*([kmgKMG]?)(i?B?)?$/.exec(s.trim());
  if (!m) throw new Error(`无法解析内存大小: ${s}`);
  const n = BigInt(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'g' ? 1024n ** 3n : unit === 'm' ? 1024n ** 2n : unit === 'k' ? 1024n : 1n;
  return n * mult;
}

function parseNumber(s: string): bigint {
  return s.trim().toLowerCase().startsWith('0x') ? BigInt(s.trim()) & 0xffffffffffffffffn : BigInt(s.trim());
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    append: '',
    memory: 512n * 1024n * 1024n,
    maxInstructions: Number.POSITIVE_INFINITY,
    trace: false,
    traceFrom: 0n,
    stats: false,
    misaligned: 'trap',
    interactive: false,
    help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数`);
      return v;
    };
    switch (a) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-k':
      case '--kernel':
        args.kernel = next();
        break;
      case '-b':
      case '--bios':
        args.bios = next();
        break;
      case '-d':
      case '--disk':
        args.disk = next();
        break;
      case '-i':
      case '--initrd':
        args.initrd = next();
        break;
      case '-a':
      case '--append':
        args.append = next();
        break;
      case '-m':
      case '--memory':
        args.memory = parseSize(next());
        break;
      case '--load-at':
        args.loadAt = parseNumber(next());
        break;
      case '-n':
      case '--max':
        args.maxInstructions = Number(parseNumber(next()));
        break;
      case '--trace':
        args.trace = true;
        break;
      case '--trace-from':
        args.traceFrom = parseNumber(next());
        break;
      case '--dump-dtb':
        args.dumpDtb = next();
        break;
      case '--stats':
        args.stats = true;
        break;
      case '--script':
        args.script = next();
        break;
      case '--interactive':
        args.interactive = true;
        break;
      case '--misaligned': {
        const v = next();
        if (v !== 'trap' && v !== 'slow') throw new Error('--misaligned 只能是 trap 或 slow');
        args.misaligned = v;
        break;
      }
      default:
        if (a.startsWith('-')) throw new Error(`未知选项: ${a}`);
        rest.push(a);
    }
  }
  if (!args.kernel && rest.length > 0) args.kernel = rest[0];
  return args;
}

function readFile(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`文件不存在: ${path}`);
  return new Uint8Array(readFileSync(path));
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${HELP}`);
    return 2;
  }
  if (args.help || (!args.kernel && !args.bios)) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }

  let machine: Machine;
  try {
    machine = new Machine({
      memSize: args.memory,
      bios: args.bios ? readFile(args.bios) : undefined,
      disk: args.disk ? new FileDisk(args.disk) : undefined,
      initrd: args.initrd ? readFile(args.initrd) : undefined,
      kernel: args.kernel
        ? args.loadAt
          ? { data: readFile(args.kernel), loadAt: args.loadAt }
          : readFile(args.kernel)
        : undefined,
      cmdline: args.append,
      misaligned: args.misaligned,
    });
  } catch (e) {
    process.stderr.write(`初始化失败: ${(e as Error).message}\n`);
    return 2;
  }

  if (args.dumpDtb) {
    writeFileSync(args.dumpDtb, machine.generateDtb(args.append));
    process.stderr.write(`设备树已写入 ${args.dumpDtb}（${machine.dtbAddress.toString(16)}）\n`);
  }

  if (args.trace) {
    machine.cpu.traceEnabled = true;
    machine.cpu.traceFrom = args.traceFrom;
    let n = 0;
    machine.cpu.onTrace = (pc, inst, len, priv) => {
      if (n++ > 2000000) return;
      const mode = ['U', 'S', 'H', 'M'][priv];
      process.stderr.write(
        `${pc.toString(16).padStart(16, '0')}  ${inst.toString(16).padStart(len === 2 ? 4 : 8, '0')}  ${mode}\n`,
      );
    };
  }

  process.stderr.write(
    `ts-riscv64: 入口 0x${machine.cpu.pc.toString(16)}，内存 ${machine.ramSize / 1024n / 1024n} MiB，` +
      `DTB @ 0x${machine.dtbAddress.toString(16)}\n`,
  );

  const scriptLines = args.script
    ? (existsSync(args.script)
        ? ['', ...readFileSync(args.script, 'utf8')
            .split('\n')
            .map((s) => s.trimEnd())]
        : (process.stderr.write(`警告: --script 文件不存在: ${args.script}\n`), []))
    : [];
  let sentLines = 0;
  const SCRIPT_FIRST_AT = 12_000_000;
  const SCRIPT_STRIDE = 6_000_000;
  // 在 autoboot 倒计时窗口内多发几个停止键，确保固件停在交互提示符
  const AUTOBOOT_STOPS = [200_000, 600_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000];
  let stopIdx = 0;
  const feedScript = (count: number): void => {
    while (stopIdx < AUTOBOOT_STOPS.length && count >= AUTOBOOT_STOPS[stopIdx]) {
      machine.uart.pushString('\r');
      stopIdx++;
    }
    if (sentLines >= scriptLines.length) return;
    if (count >= SCRIPT_FIRST_AT + sentLines * SCRIPT_STRIDE) {
      machine.uart.pushString(scriptLines[sentLines] + '\r');
      sentLines++;
    }
  };

  let stats: MachineStats;
  if (args.interactive) {
    // 交互模式：键盘输入 → 串口接收。分块运行并在块间让出事件循环，
    // 否则同步的 run() 会阻塞事件循环，stdin 事件永远得不到处理。
    const q: number[] = [];
    let rawMode = false;
    try {
      process.stdin.setRawMode(true);
      rawMode = true;
    } catch {
      rawMode = false; // 非 TTY（如管道）退化为逐行
    }
    process.stdin.resume();
    process.stdin.on('data', (d: Buffer | string) => {
      const b = typeof d === 'string' ? Buffer.from(d, 'binary') : d;
      for (const byte of b) if (q.length < 4096) q.push(byte);
    });
    process.stderr.write(
      rawMode
        ? '交互模式：键盘输入 → 串口（Ctrl+C 交给 guest；退出可在 guest 里执行 reboot/poweroff）\n'
        : '交互模式（非 TTY，逐行输入；空行回车 = 发送换行）\n',
    );
    stats = await machine.runInteractive({
      maxInstructions: args.maxInstructions,
      chunk: 1_000_000,
      afterChunk: (count) => {
        feedScript(count);
        // UART 接收 FIFO 只有 64 字节，一次最多灌 60 字节
        let n = 0;
        while (q.length > 0 && n < 60) {
          machine.uart.pushRx(q.shift()!);
          n++;
        }
        return undefined;
      },
    });
    // stdin 处于 raw+resume 状态会挂住事件循环，结束运行后停掉
    process.stdin.pause();
    process.stdin.removeAllListeners('data');
  } else {
    stats = machine.run({
      maxInstructions: args.maxInstructions,
      onStep: (_, count) => {
        feedScript(count);
        return undefined;
      },
    });
  }

  if (args.stats || !machine.cpu.halted) {
    const mips = stats.ips / 1e6;
    process.stderr.write(
      `\n--- 统计 ---\n` +
        `指令数     : ${stats.instructions}\n` +
        `耗时       : ${stats.seconds.toFixed(3)} s\n` +
        `速度       : ${mips.toFixed(2)} MIPS\n` +
        `TLB 命中   : ${machine.cpu.mmu.stats.tlbHit} / 未命中 ${machine.cpu.mmu.stats.tlbMiss}\n` +
        `退出原因   : ${machine.exitReason || '(未停机)'}\n` +
        `退出码     : ${machine.exitCode}\n`,
    );
  }

  if (!machine.cpu.halted) {
    process.stderr.write(`\nCPU 状态:\n${machine.dumpState()}\n`);
    process.stderr.write(
      `异常: ${Machine.exceptionName(machine.cpu.csr.read(CSR.MCAUSE) ?? 0n)}\n`,
    );
    return 1;
  }
  return machine.exitCode ?? 0;
}

process.exitCode = await main();
