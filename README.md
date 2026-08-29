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

### 启动 U-Boot（已验证 ✅）

可以直接运行真实的 U-Boot（作为 S 模式负载），并让它操作 VirtIO 块设备：

```bash
# 从 Debian 的 u-boot-qemu 包解出 qemu-riscv64_smode/uboot.elf（放 tmp/，GPL-2.0 不入库）
# 挂一块 raw 磁盘，用 --script 往 U-Boot 控制台注入命令：
tsx src/cli.ts --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin \
  --kernel tmp/uboot/uboot.elf --disk tmp/disk.raw --script <cmd-file> -n 60000000
```

`--script` 会把文件里每行当作控制台命令逐条喂入（带 autoboot 停止键，
用于交互式固件）。实测输出：

```
=> virtio scan
=> virtio info
Device 0: QEMU VirtIO Block Device
            Capacity: 8.0 MB = 0.0 GB (16384 x 512)
=> virtio write 0x80200000 0 1      # 写盘
1 blocks written: OK
=> virtio read 0x80300000 0 1       # 读盘
1 blocks read: OK
```

VirtIO 块设备按 virtio-v1.x MMIO 规范实现（寄存器布局与 U-Boot `virtio_mmio.h`
逐一核对），并声明 `VIRTIO_F_VERSION_1`，因此 modern 驱动可以直接识别。
U-Boot 下载：Debian 包 `u-boot-qemu`（`ftp.debian.org/debian/pool/main/u/u-boot/`），
源码：<https://github.com/u-boot/u-boot>（GPL-2.0，产物勿提交入 Apache-2.0 仓库）。


### 启动 Linux（Alpine，实测引导中 ✅）

配套工具：`tools/make-initramfs.py`（Windows 上自制 cpio-newc initramfs）、
`tools/verify-cpio.py`（校验归档结构）。

```bash
# 1) 下载 Alpine riscv64 内核与最小根文件系统
curl -O https://dl-cdn.alpinelinux.org/alpine/v3.24/main/riscv64/linux-lts-6.18.44-r0.apk
curl -O https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/riscv64/alpine-minirootfs-3.24.1-riscv64.tar.gz
# apk 本质是 tar.gz：解出 boot/vmlinuz-lts，再 gzip -dc 得到扁平 Image
mkdir rootfs && tar -xzf alpine-minirootfs-*.tar.gz -C rootfs/

# 2) 自制 initramfs（含 /init 与 dev/console 等控制台设备节点）
python tools/make-initramfs.py rootfs initramfs.cpio.gz
python tools/verify-cpio.py initramfs.cpio.gz        # 结构校验

# 3) 启动（约 0.5 MIPS，完整引导需数亿条指令、十几分钟）
tsx src/cli.ts --bios .../fw_jump.bin \
  --kernel tmp/alpine/Image-lts --initrd tmp/alpine/initramfs.cpio.gz \
  --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 300000000 --stats
```

实测进度（Linux 6.18.44，rv64gc）：内核启动 → 内存管理（DMA32 512MB /
131072 页）→ SBI TIME/IPI/RFENCE/DBCN/HSM 全部识别 → 定时器与时钟源 →
VFS / TCP-IP / PCI / USB 子系统 → **initramfs 解包成功**。

排障要点（踩过的坑，避免重复）：
- `head.S` 的 `relocate_enable_mmu` 用指令页错误当"传送门"（stvec 指向虚拟地址，
  切页表后靠 trap 进入虚拟地址空间）——**启动初期的一次指令页错误是内核设计，不是 bug**
- TLB 键必须用 bigint：Sv48 下 `Number(vaddr>>12)*65536+asid` 逼近 2^53，
  会导致不同虚拟地址碰撞 + `sfence.vma` 按地址失效失灵
- cpio-newc 的 name 填充按 `110 + len(name+\0)` 对齐（内核 `N_ALIGN(len)=(((len+1)&~3)+2)`，
  `+2` 补偿 header 110%4=2），且 name 必须以 NUL 结尾，否则分别报
  "broken padding" 与 "name without nulterm"

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

# 交互模式：键盘输入接到串口接收（登录 Linux shell 后可直接敲命令）
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --initrd initramfs.cpio \
  --append "console=ttyS0 rdinit=/init" --interactive

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

本程序的主体(除firmware目录以外的部分)以 **Apache-2.0** 授权，请参阅LICENSE以了解许可证下的具体权利和限制。firmware内包含有OpenSBI、U-Boot、系统镜像 等，TSIE 模拟器所附带的firmware均为自由软件；具体分发条款请参见内含的/firmware/*/copyright。**在适用法律允许的范围内，TSIE 本体以及附带的软件均为 按原样(AS IS) 提供，不附带任何明示和暗示的担保。**
