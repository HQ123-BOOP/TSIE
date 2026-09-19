#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * TSIE (TSIE Is an Emulator) —— RISC-V 64 位模拟器命令行入口
 *
 *   tsx src/cli.ts --kernel vmlinux --disk rootfs.img --append "console=ttyS0 root=/dev/vda"
 *   tsx src/cli.ts --kernel hello.bin --trace --stats
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Machine, type MachineStats } from './machine.ts';
import { FileDisk } from './dev/disk.ts';
import { LoopbackBackend } from './dev/net.ts';
import { ProxyBackend } from './dev/net-proxy.ts';
import { SlirpBackend } from './dev/net-slirp.ts';
import { encodeBmp } from './dev/bmp.ts';
import type { GpuFramebuffer } from './dev/virtio-gpu.ts';
import { DisplayServer } from './display/web.ts';
import { CSR } from './cpu/csr.ts';

interface Args {
  kernel?: string;
  bios?: string;
  disk?: string;
  netdev?: 'loopback' | 'proxy' | 'slirp';
  /** virtio-gpu 显示设备分辨率 */
  gpu?: { width: number; height: number };
  /** 把 virtio-gpu 的画面写成 BMP 文件 */
  fbDump?: string;
  /** 在浏览器实时显示 virtio-gpu 画面（HTTP+WS 端口） */
  display?: number;
  /** 挂载 virtio-input 键盘（配合 --display 时把浏览器按键透传给 guest） */
  input: boolean;
  /** 挂载 PCIe 主机桥，virtio-gpu 改走 virtio-pci */
  pci: boolean;
  /** pflash 固件卷（EDK2 的 RISCV_VIRT_CODE.fd），给出即挂载一对 CFI NOR flash */
  flashCode?: string;
  /** pflash 变量存储（EDK2 的 RISCV_VIRT_VARS.fd） */
  flashVars?: string;
  /** virtio-9p 共享目录 */
  shared9p?: string;
  proxyHost?: string;
  proxyPort?: number;
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
  moo?: boolean;
}

const HELP = `
TSIE is a TypeScript® RISC-V® Emulator. The full name is "TSIE Is an Emulator".
It can run Linux® distributions (e.g., Debian® GNU/Linux®, Alpine Linux®) or
FreeBSD® (not yet tested).

用法:
  tsie [选项] --kernel <镜像>

选项:
  -k, --kernel <file>       内核 / 裸机程序（ELF64 或裸二进制）
  -b, --bios <file>         固件（如 OpenSBI fw_jump.bin）；启动 Linux 必需，裸机程序可不带
  -d, --disk <file>         磁盘镜像（挂载为 VirtIO 块设备 /dev/vda）
  -i, --initrd <file>       initrd 镜像
  -a, --append <string>     内核命令行（如 "console=ttyS0 root=/dev/vda rw"）
  -m, --memory <size>       内存大小，支持 K/M/G 后缀（默认 512M）
      --netdev <backend>    网卡后端：
                            loopback  TX 帧回注 RX（自发自收，无外部依赖）
                            slirp     用户态 NAT，guest 直连外网
                                      （ICMP 仅网关应答；DNS 请配公网服务器）
                            proxy     经 UDP 转发到外部桥接守护（真实链路，
                                      配合 VM 上的 TAP 桥 + MASQUERADE）
      --proxy-host <ip>     proxy 后端的桥接守护地址（配合 --netdev proxy）
      --proxy-port <n>      proxy 后端的桥接守护 UDP 端口（默认 7777）
      --gpu <WxH>           挂载 virtio-gpu 显示设备（如 --gpu 1024x768）。
                            guest 侧由内核 virtio_gpu 驱动接管，经 fbdev 控制台输出画面
      --pci                 挂载 PCIe 主机桥，virtio-gpu 改走 virtio-pci
                            （EDK2/Linux 按 PCI 显示设备枚举，无需平台补丁）
      --flash-code <file>   挂载一对 CFI NOR flash（各 32MiB）并载入固件卷，
                            如 EDK2 的 RISCV_VIRT_CODE.fd（UEFI 固件）
      --flash-vars <file>   同上，载入 UEFI 变量存储（RISCV_VIRT_VARS.fd）。
                            EDK2 要求 CODE/VARS 成对提供，缺一会报错
      --fb-dump <file>      把 virtio-gpu 的画面写成 BMP（配合 --gpu）。
                            每次画面刷新写入同一个文件（限流 250ms），运行结束时再落最后一帧
      --display <port>      在浏览器实时显示 virtio-gpu 画面（配合 --gpu）。
                            启动后打开 http://127.0.0.1:<port>，帧经 WebSocket 推送
      --input               挂载 virtio-input 键盘。与 --display 同用时，网页里点一下
                            画面聚焦后敲键即可透传给 guest（UEFI 阶段无驱动，进 Linux 后可用）
      --9p, --shared9p <dir> 把目录经 virtio-9p 导出给 guest（tag: hostshare；
                            guest 侧 mount -t 9p -o trans=virtio,version=9p2000.L
                            hostshare /mnt）
      --load-at <addr>      内核加载地址（默认 0x80200000）
      --misaligned <mode>   非对齐访存策略：trap（默认，语义精确）或 slow（慢但宽容）
      --script <file>       把文件中的每一行作为控制台输入逐条喂入（无人值守验证）
      --interactive         交互模式：键盘直连串口（登录 shell 后可直接敲命令；
                            退出请在 guest 里执行 poweroff/reboot，Ctrl+C 会交给 guest）
      --trace               打印指令流（调试用，极慢）
      --trace-from <addr>   从指定地址开始打印指令流
      --dump-dtb <file>     把生成的设备树写到文件（检查 DTB 用）
      --stats               运行结束后打印统计信息
  -n, --max <n>             最多执行的指令数（防止跑飞）
  -h, --help                显示本帮助

This TSIE not has Super Cow Powers.
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
    input: false,
    pci: false,
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
      case '--9p':
      case '--shared9p':
        args.shared9p = next();
        break;
      case '--netdev': {
        const v = next();
        if (v !== 'loopback' && v !== 'proxy' && v !== 'slirp')
          throw new Error(`未知网卡后端: ${v}（当前支持 loopback/proxy/slirp）`);
        args.netdev = v;
        break;
      }
      case '--proxy-host':
        args.proxyHost = next();
        break;
      case '--proxy-port':
        args.proxyPort = Number(parseNumber(next()));
        break;
      case '--gpu': {
        const m = /^(\d+)x(\d+)$/.exec(next());
        if (!m) throw new Error('--gpu 需要 WxH 形式，例如 --gpu 1024x768');
        args.gpu = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      case '--fb-dump':
        args.fbDump = resolve(next());
        break;
      case '--display':
        args.display = Number(parseNumber(next()));
        break;
      case '--flash-code':
        args.flashCode = resolve(next());
        break;
      case '--flash-vars':
        args.flashVars = resolve(next());
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
      case '--pci':
        args.pci = true;
        break;
      case '--input':
        args.input = true;
        break;
      case 'moo':
      case '--moo':
        args.moo = true;
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
  if (args.display !== undefined && !args.gpu) throw new Error('--display 需要配合 --gpu 使用');
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
  if (args.moo) {
    process.stdout.write(
      [
        '        (__)',
        '        (- -)',
        '  /------\\/',
        ' / |    ||',
        '*  /\\---/\\',
        '   ~~  ~~',
        '"This cow has no strength..."',
        '',
      ].join('\n'),
    );
    return 0;
  }
  if (args.help || (!args.kernel && !args.bios)) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }

  let gpuReported = false;
  let lastFrame: GpuFramebuffer | undefined;
  let lastDumpAt = 0;
  let dumpCount = 0;
  /** 把当前画面写成 BMP。limit=true 时限流 —— guest 刷屏时画面刷新很快，不限流会把磁盘写爆 */
  const dumpFrame = (fb: GpuFramebuffer, limit: boolean): void => {
    if (!args.fbDump) return;
    const now = Date.now();
    if (limit && now - lastDumpAt < 250) return;
    lastDumpAt = now;
    try {
      writeFileSync(args.fbDump, encodeBmp(fb));
      dumpCount++;
      if (dumpCount === 1 || dumpCount % 20 === 0) {
        process.stderr.write(`显示: 已写出画面 ${fb.width}x${fb.height} → ${args.fbDump}（第 ${dumpCount} 帧）\n`);
      }
    } catch (e) {
      process.stderr.write(`显示: 写画面失败: ${(e as Error).message}\n`);
    }
  };
  let machine: Machine;
  try {
    machine = new Machine({
      memSize: args.memory,
      bios: args.bios ? readFile(args.bios) : undefined,
      disk: args.disk ? new FileDisk(args.disk) : undefined,
      flash:
        args.flashCode || args.flashVars
          ? {
              code: args.flashCode ? new Uint8Array(readFile(args.flashCode)) : undefined,
              vars: args.flashVars ? new Uint8Array(readFile(args.flashVars)) : undefined,
            }
          : undefined,
      pci: args.pci ? {} : undefined,
      input: args.input ? {} : undefined,
      gpu: args.gpu
        ? {
            width: args.gpu.width,
            height: args.gpu.height,
            onFlush: (fb) => {
              lastFrame = fb;
              if (!gpuReported) {
                gpuReported = true;
                process.stderr.write(`显示: virtio-gpu 首帧就绪 ${fb.width}x${fb.height}（format ${fb.format}）\n`);
              }
              dumpFrame(fb, true);
            },
          }
        : undefined,
      net:
        args.netdev === 'loopback'
          ? new LoopbackBackend()
          : args.netdev === 'proxy'
            ? new ProxyBackend({ host: args.proxyHost ?? '127.0.0.1', port: args.proxyPort ?? 7777 })
            : args.netdev === 'slirp'
              ? new SlirpBackend()
              : undefined,
      shared: args.shared9p ? resolve(args.shared9p) : undefined,
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

  let display: DisplayServer | undefined;
  if (args.display !== undefined) {
    const gpu = machine.gpu;
    if (gpu) {
      display = new DisplayServer({
        port: args.display,
        getFramebuffer: () => gpu.getFramebuffer(),
        getFrameCount: () => gpu.stats().flushes,
        // 增量推送：设备侧知道每次 TRANSFER 的矩形，只推变化区域（整屏 3MB → 常见是一行 78KB）
        getDirtyRect: () => gpu.dirtyRect(),
        clearDirty: () => gpu.clearDirty(),
        // 只有挂了 virtio-input 才开反向通道：否则页面不必发键盘
        onInput: machine.input
          ? (ev) => {
              machine.input!.sendBrowserKey(ev.code, ev.down);
            }
          : undefined,
      });
      try {
        await display.ready;
      } catch (e) {
        process.stderr.write(`显示: 监听端口 ${args.display} 失败: ${(e as Error).message}\n`);
        display.close();
        return 2;
      }
      process.stderr.write(`显示: 浏览器打开 http://127.0.0.1:${args.display} 查看实时画面\n`);
    } else {
      // --gpu 校验在 parseArgs，这里只可能是构造机器时没挂上
      process.stderr.write('显示: --display 需要 --gpu（机器上未挂载显示设备）\n');
      return 2;
    }
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
    `TSIE: 入口 0x${machine.cpu.pc.toString(16)}，内存 ${machine.ramSize / 1024n / 1024n} MiB，` +
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
  } else if (display) {
    // 显示模式：同步 run() 会阻塞事件循环，浏览器连不上也收不到帧。
    // 分块跑并在块间让出事件循环（同交互模式的机制）。
    // 块取 5 万条 ≈ 本项目 1~3 MIPS 下的 20~50ms，即帧推送节拍。
    stats = await machine.runInteractive({
      maxInstructions: args.maxInstructions,
      chunk: 50_000,
      afterChunk: (count) => {
        feedScript(count);
        display!.pump();
        return undefined;
      },
    });
  } else {
    stats = machine.run({
      maxInstructions: args.maxInstructions,
      onStep: (_, count) => {
        feedScript(count);
        return undefined;
      },
    });
  }

  // 收尾：限流可能刚好跳过最后一帧，这里强制再落一张，保证磁盘上是最新画面
  if (lastFrame) dumpFrame(lastFrame, false);
  display?.close();

  if (args.stats || !machine.cpu.halted) {
    const mips = stats.ips / 1e6;
    process.stderr.write(
      `\n--- 统计 ---\n` +
        `指令数     : ${stats.instructions}\n` +
        `耗时       : ${stats.seconds.toFixed(3)} s\n` +
        `速度       : ${mips.toFixed(2)} MIPS\n` +
        `TLB 命中   : ${machine.cpu.mmu.stats.tlbHit} / 未命中 ${machine.cpu.mmu.stats.tlbMiss}\n` +
        // 显示推送：按脏矩形推增量，实发帧数与累计字节数是"是否真的省下来"的直接凭据
        (display
          ? `显示推送   : 实发 ${display.stats().sent} 帧 / ${(
              display.stats().bytes / 1048576
            ).toFixed(1)} MB` + `（内容未变跳过 ${display.stats().deduped} 帧）\n`
          : '') +
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
