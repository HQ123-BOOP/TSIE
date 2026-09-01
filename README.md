<div align="center">

# TSIE

<img src="https://img.shields.io/github/v/release/HQ123-BOOP/TSIE" alt="Release">
<img src="https://img.shields.io/github/license/HQ123-BOOP/TSIE" alt="License">
<img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript">

**一个 TypeScript 从零实现的 RISC-V 64 位模拟器。**

</div>

零运行时依赖（仅 Node.js 标准库），从指令译码、特权架构、虚拟内存到外设全部手写实现，
可用于学习 RISC-V 体系结构、运行裸机程序，或作为构建 RISC-V 工具链/操作系统的试验平台。

## 特性一览

| 模块 | 能力 |
| --- | --- |
| **指令集** | RV64I / M（乘除）/ A（原子）/ F+D（单双精度浮点）/ C（压缩）/ Zicsr / Zifencei，即 **RV64GC** |
| **特权架构** | M / S / U 三种特权级，全套 m/s CSR、mret/sret、异常委派（medeleg/mideleg）、中断（CLINT+PLIC）、WFI |
| **虚拟内存** | Sv39 / Sv48 多级页表遍历、TLB（支持超级页）、sfence.vma、A/D 位硬件更新、SUM/MXR/MPRV 语义 |
| **外设** | NS16550 UART（中断+FIFO+回环）、CLINT（mtime/msip）、PLIC（claim/complete）、VirtIO-MMIO 块设备、SiFive Test |
| **固件** | **内建 SBI v0.2**（console/timer/rfence/HSM/SRST/BASE），无需外部 OpenSBI 即可启动 Linux |
| **加载** | ELF64 装载（自动处理 vaddr/paddr 偏移）、裸二进制、扁平设备树（DTB）生成器 |
| **工具** | 指令编码器（`tools/encoder.ts`）、指令级单元测试、CLI |

## 快速开始

```bash
npm install        # 仅安装 typescript / tsx / @types/node 开发依赖
npm test           # 运行 98 项单元测试
npm run demo       # 裸机 "Hello, RISC-V 64!"（经内建 SBI 输出）
npm run bench      # 性能基准
```

### 启动 OpenSBI（已验证 ✅）

模拟器可以直接运行真实的 OpenSBI 固件（v1.9 实测通过）：

```bash
# 下载预编译固件（约 30 MB，包含所有平台）
curl -L -o firmware/opensbi.tar.xz \
  https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz
# 解压出 firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin

# 仅运行固件（打印 OpenSBI banner 与平台信息）
tsx src/cli.ts --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin

# 固件 + 内核（fw_jump 默认跳转到 0x80200000，DTB 期望位于 0x82200000，与本模拟器一致）
tsx src/cli.ts --bios .../fw_jump.bin --kernel hello-sbi.bin
```

OpenSBI 会正确识别本模拟器（`Platform Name: ts-riscv64,virt`、`rv64imafdc`、
ACLINT 定时器、8250 串口、16 个 PMP），并把控制权移交给 S 模式内核。

源码与编译方式见官方仓库：<https://github.com/riscv-software-src/opensbi>（国内可用
<https://gitee.com/tinylab/qemu-opensbi.git> 镜像）。

### 命令行

```bash
# 运行裸机镜像
tsx src/cli.ts --kernel hello.bin --stats

# 运行 Linux（需要内核镜像与根文件系统）
tsx src/cli.ts \
  --kernel Image \
  --disk rootfs.ext4 \
  --append "console=ttyS0 root=/dev/vda" \
  --memory 1G

# 可选：外接 OpenSBI（缺省用内建 SBI）
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux

# 导出设备树、指令跟踪
tsx src/cli.ts --kernel hello.bin --dump-dtb virt.dtb --trace --trace-from 0x80200000
```

## 内存映射（QEMU virt 兼容）

| 地址 | 设备 |
| --- | --- |
| `0x0000_1000` | （保留） |
| `0x0010_0000` | SiFive Test（写 `0x5555` 退出 0 / `0x3333` 退出 1） |
| `0x0200_0000` | CLINT（msip / mtimecmp / mtime） |
| `0x0C00_0000` | PLIC |
| `0x1000_0000` | NS16550 UART0 |
| `0x1000_1000` | VirtIO-MMIO 块设备 |
| `0x8000_0000` | RAM（默认 512 MiB，`-m` 可调） |
| `0x8020_0000` | 默认内核加载地址 |
| `0x8060_0000` | 默认 DTB 存放地址 |

PLIC 中断源：1 = VirtIO 块设备，10 = UART0（与 QEMU virt 相同）。

## 编程接口

```ts
import { Machine, MemoryDisk } from './src/index.ts';

const machine = new Machine({
  memSize: 128n * 1024n * 1024n,
  kernel: kernelBytes,           // ELF64 或裸二进制
  disk: MemoryDisk.zero(2048),   // 1 MiB 空盘（VirtIO）
  cmdline: 'console=ttyS0',
  stdout: (byte) => process.stdout.write(Buffer.from([byte])),
});

const stats = machine.run({ maxInstructions: 1e9 });
console.log(stats.ips);          // 每秒指令数
console.log(machine.dumpState()); // PC / mstatus / satp 等现场
```

更底层可以直接操作 `Cpu`（配合 `Bus` + `RAM` 搭建自定义地址空间），
或用 `tools/encoder.ts` 的指令编码器手写机器码：

```ts
import { addi, li, sd, ecall, halt } from './tools/encoder.ts';

const program = [
  ...li(1, 0x80200000n),
  ...li(2, 0x1234n),
  sd(1, 2, 0),
  ...halt(),
];
```

## 目录结构

```
src/
├── core/bits.ts          64 位位运算工具（立即数提取、符号扩展等）
├── mem/                  物理地址空间：Bus / RAM / 设备接口
├── cpu/
│   ├── cpu.ts            取指-译码-执行、陷阱与中断
│   ├── csr.ts            CSR 寄存器文件（WARL / 只读 / 别名）
│   ├── mmu.ts            Sv39/Sv48 页表遍历 + TLB
│   └── fpu.ts            IEEE754 浮点（NaN 装箱、舍入模式、异常标志）
├── dev/                  UART / CLINT / PLIC / VirtIO / Test
├── firmware/sbi.ts       内建 SBI v0.2 固件
├── loader/               ELF64 装载 + DTB 生成
├── machine.ts            virt 机器组装与主循环
└── cli.ts                命令行入口
tools/encoder.ts          RISC-V 指令编码器（测试与示例用）
tests/                    98 项单元测试（node:test）
```

## 测试

```bash
npm test            # 全部 98 项
npx tsx --test tests/mmu.test.ts      # 单个模块
```

覆盖范围：RV64I 全部整数指令与访存、M 扩展（含除零/溢出）、A 扩展（LR/SC/AMO）、
F/D 扩展（舍入模式、NaN 装箱、FCLASS）、RVC 压缩指令、CSR/陷阱/中断委派、
Sv39/Sv48 翻译与权限、全部外设协议、以及整机端到端（SBI、定时器中断、WFI）。

## 性能与设计取舍

- **数据通路使用 `bigint`**：语义与硬件完全一致（无 2^53 精度陷阱），可读性好；
  代价是速度 —— 解释执行约 **1 MIPS** 量级。
- 若需要更高性能，可按以下路线优化（接口已预留）：
  1. 64 位值改用 hi/lo 两个 32 位 `number` 分量表示（约 5-10 倍提速）；
  2. TLB / 取指路径已做 `number` 化，可进一步引入代码缓存（basic-block cache）；
  3. 终极方案是 WASM JIT。
- 非对齐访存默认按规范抛异常（`--misaligned slow` 可切换为逐字节模拟）。

## 已知限制

- 单 hart（多核与 hartip 暂未实现）
- PMP 寄存器可读写但不做权限强制（对 Linux 启动无影响）
- 浮点舍入在极端边界情况下可能有 1 ulp 差异（JS 双精度中间值所致）
- 未实现 H 扩展（hypervisor）、向量扩展与调试模块（dcsr 等）

## Star History

<a href="https://www.star-history.com/?repos=HQ123-BOOP%2FTSIE&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=HQ123-BOOP/TSIE&type=date&theme=dark&legend=top-left&sealed_token=v94MairdUk4jnM8mfWsW1p3dX7b0CfKu9uspWf6vHw8TMfTbYpgbRzBrmrlDPezVolxNiYs8WoKczfi1MV1vIpL8R684HIms1T16d6rhC19W0CCoJANQuRMQ77gF21_rcY4ZPshh15ti77dx1QYGriDz3Ylzedx53DZvs0zq2ij7g2pWUbHAOlhZ2WsD" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=HQ123-BOOP/TSIE&type=date&legend=top-left&sealed_token=v94MairdUk4jnM8mfWsW1p3dX7b0CfKu9uspWf6vHw8TMfTbYpgbRzBrmrlDPezVolxNiYs8WoKczfi1MV1vIpL8R684HIms1T16d6rhC19W0CCoJANQuRMQ77gF21_rcY4ZPshh15ti77dx1QYGriDz3Ylzedx53DZvs0zq2ij7g2pWUbHAOlhZ2WsD" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=HQ123-BOOP/TSIE&type=date&legend=top-left&sealed_token=v94MairdUk4jnM8mfWsW1p3dX7b0CfKu9uspWf6vHw8TMfTbYpgbRzBrmrlDPezVolxNiYs8WoKczfi1MV1vIpL8R684HIms1T16d6rhC19W0CCoJANQuRMQ77gF21_rcY4ZPshh15ti77dx1QYGriDz3Ylzedx53DZvs0zq2ij7g2pWUbHAOlhZ2WsD" />
 </picture>
</a>

## License

Apache-2.0

# Disclaimer

本程序的主体(除firmware目录以外的部分)以** Apache-2.0 **授权，请参阅LICENSE以了解许可证下的具体权利和限制。firmware内包含有OpenSBI、U-Boot、系统镜像 等，TSIE 模拟器所附带的firmware均为自由软件；具体分发条款请参见内含的/firmware/*/copyright。**在适用法律允许的范围内，TSIE 本体以及附带的软件均为 按原样(AS IS) 提供，不附带任何明示和暗示的担保。**
