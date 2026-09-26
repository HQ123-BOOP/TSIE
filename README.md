<div align="center">

# TSIE

<img src="https://img.shields.io/github/v/release/HQ123-BOOP/TSIE" alt="Release">
<img src="https://img.shields.io/github/license/HQ123-BOOP/TSIE" alt="License">
<img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript">

**一个 TypeScript 从零实现的 RISC-V 64 位模拟器。**

</div>

除 `ws`（浏览器实时显示用的 WebSocket 库）之外没有运行时依赖，从指令译码、特权架构、
虚拟内存到外设全部手写实现，可用于学习 RISC-V 体系结构、运行裸机程序，
或作为构建 RISC-V 工具链/操作系统的试验平台。

## 特性一览

| 模块 | 能力 |
| --- | --- |
| **指令集** | RV64I / M（乘除）/ A（原子）/ F+D（单双精度浮点）/ C（压缩）/ Zicsr / Zifencei，即 **RV64GC**；另有 Zba / Zbb / Zbs 位操作与 Zicntr 计数器（`misa` 上报 B 位） |
| **特权架构** | M / S / U 三种特权级，全套 m/s CSR、mret/sret、异常委派（medeleg/mideleg）、中断（CLINT+PLIC）、WFI |
| **虚拟内存** | Sv39 / Sv48 多级页表遍历、TLB（支持超级页）、sfence.vma、A/D 位硬件更新、SUM/MXR/MPRV 语义 |
| **外设** | NS16550 UART（中断+FIFO+回环）、CLINT（mtime/msip）、PLIC（claim/complete）、Goldfish RTC、SiFive Test |
| **VirtIO** | 块设备 / 网卡（slirp 与宿主代理两种后端）/ 9P（共享宿主目录）/ GPU / 键盘输入。**MMIO 与 PCIe 两种挂载方式**（GPU 走 PCI，对齐 EDK II 的 `IsPciDisplay`） |
| **显示** | virtio-gpu 画面可经 WebSocket 实时推到浏览器（脏矩形增量推送），浏览器键盘回传到 guest |
| **固件** | 直接运行真实固件：实测 OpenSBI 1.9 + U-Boot 2025.01 + **Debian 13 (trixie) 完整引导到 `login:`**，以及 EDK II (UEFI) 启动链（含 TianoCore logo 上屏）。**SBI 调用需外部 OpenSBI —— 内建 SBI 固件已移除** |
| **加载** | ELF64 装载（自动处理 vaddr/paddr 偏移）、裸二进制、扁平设备树（DTB）生成器（含 `rng-seed` 熵注入） |
| **工具** | 指令编码器（`tools/encoder.ts`）、指令级单元测试、CLI |

## 快速开始

```bash
npm install        # 运行时依赖只有 ws；另有 typescript / tsx / @types/node 开发依赖
npm test           # 运行 222 项单元测试
npm run demo       # 裸机 "Hello, RISC-V 64!"（直接驱动 UART，不依赖固件）
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

OpenSBI 会正确识别本模拟器（`Platform Name: tsie,virt`、`rv64imafdc`、
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


### 启动 Linux（Alpine，已验证引导到 shell ✅）

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

# 3) 启动（实测吞吐约 2–4 MIPS，随宿主负载浮动；完整引导需数亿条指令，约数分钟）
tsx src/cli.ts --bios .../fw_jump.bin \
  --kernel tmp/alpine/Image-lts --initrd tmp/alpine/initramfs.cpio.gz \
  --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 300000000 --stats
```

实测进度（Linux 6.18.44，rv64gc）：内核启动 → 内存管理（DMA32 512MB /
131072 页）→ SBI TIME/IPI/RFENCE/DBCN/HSM 全部识别 → 定时器与时钟源 →
VFS / TCP-IP / PCI / USB 子系统 → **initramfs 解包成功**。

另有更完整的一条链路已跑通：Alpine 3.24.2 的 ext4 rootfs 配精简内核
（`Image-min-7.2.3`），经 OpenSBI 直接引导，**挂载根文件系统后进入
`alpine-tsie:~#`**；`init=/bin/sh` 可跳过 OpenRC，把一轮验证压到数分钟。
virtio-gpu 也在同一条链上完成 mode-set 并出图（见下节）。

排障要点（踩过的坑，避免重复）：
- `head.S` 的 `relocate_enable_mmu` 用指令页错误当"传送门"（stvec 指向虚拟地址，
  切页表后靠 trap 进入虚拟地址空间）——**启动初期的一次指令页错误是内核设计，不是 bug**
- TLB 键必须用 bigint：Sv48 下 `Number(vaddr>>12)*65536+asid` 逼近 2^53，
  会导致不同虚拟地址碰撞 + `sfence.vma` 按地址失效失灵。更强的结论：VPN 是
  `vaddr>>12` 的**全量值**（内核半地址达 52 位），既压不进 Number，也不能与
  asid 做位拼接（内核 vpn 高位恒 1 会跨 ASID 碰撞 → 异常风暴）
- cpio-newc 的 name 填充按 `110 + len(name+\0)` 对齐（内核 `N_ALIGN(len)=(((len+1)&~3)+2)`，
  `+2` 补偿 header 110%4=2），且 name 必须以 NUL 结尾，否则分别报
  "broken padding" 与 "name without nulterm"

### 启动 Debian 13（完整发行版，已验证到 login: ✅）

真实发行版全链路：OpenSBI → U-Boot `bootefi` → EFI stub 内核（6.12.101+deb13）
→ initramfs → switch_root → systemd → `serial-getty@ttyS0` → **`localhost login:`**。

需要的三个关键配置（其余坑见上文排障要点）：

1. **磁盘**：Debian 13 generic riscv64 镜像（GPT：p1=rootfs ext4、p15=ESP），
   U-Boot 经 VirtIO 从 p1 直接 `load` 内核与 initrd（不需要 GRUB/ESP 内容）。
   内核是 MZ+PE EFI stub 格式，`booti` 不认，必须走 `bootefi`。
2. **熵**：模拟器时序确定，jitter entropy 采不出熵，内核 RNG 初始化会无限
   自旋（udev 起不来）。本模拟器在 DTB `/chosen/rng-seed` 注入 4096 字节
   `crypto.getRandomValues()` 真随机——内核极早期即 `random: crng init done`。
3. **虚拟时钟**：`timebaseFrequency` 设 100 MHz（模拟器约 2–4 MIPS，真机 ~100 倍，
   默认 10 MHz 下 10M 指令 = 1 虚拟秒，内核 soft lockup 与 systemd 各服务超时
   会按虚拟时间冤杀慢任务）。WFI 快进已随 timebase 折算，睡眠收敛不受影响。

实测数据（512 MiB 内存、未压缩 initrd 66 MB）：18.24B 条指令 / 约 3.9 小时 /
平均 1.31 MIPS，虚拟时间约 90 秒走到 login:（与真机数量级一致）。
另外两个提速要点：用未压缩 cpio initrd 跳过 zstd 解压瓶颈（压缩段在
<1 MIPS 下要烧 1B+ 指令）；引导脚本见 `tmp/debian-uboot.ts`（含 fdt set
cell 写法等细节，模板可复用）。

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

# 挂载 OpenSBI 固件。启动 Linux 必需 —— 内建 SBI 固件已移除，
# 不带 --bios 时只能跑不依赖 SBI 调用的裸机程序
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux

# 交互模式：键盘输入接到串口接收（登录 Linux shell 后可直接敲命令）
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --initrd initramfs.cpio \
  --append "console=ttyS0 rdinit=/init" --interactive

# 图形：挂 virtio-gpu，画面实时推到浏览器；在网页里点一下画面聚焦后
# 敲键即可回传给 guest（走 virtio-input）。--pci 让 GPU 改挂 PCIe，
# 这样 EDK II 会按 PCI 显示设备自行枚举，不需要给固件打补丁
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --disk rootfs.ext4 \
  --append "console=ttyS0 root=/dev/vda rw" --gpu 1024x768 --pci \
  --display 8094 --input

# 跑 UEFI 固件（EDK II）：CFI flash 必须 CODE / VARS 成对提供
tsx src/cli.ts --flash-code RISCV_VIRT_CODE.fd --flash-vars RISCV_VIRT_VARS.fd

# 把宿主目录共享给 guest（virtio-9p，guest 侧 mount -t 9p ... hostshare /mnt）
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --disk rootfs.ext4 \
  --append "console=ttyS0 root=/dev/vda rw" --9p /path/to/share

# 导出设备树、指令跟踪
tsx src/cli.ts --kernel hello.bin --dump-dtb virt.dtb --trace --trace-from 0x80200000
```

完整选项见 `tsx src/cli.ts --help`。

## 内存映射（QEMU virt 兼容）

| 地址 | 设备 |
| --- | --- |
| `0x0000_1000` | （保留） |
| `0x0010_0000` | SiFive Test（写 `0x5555` 退出 0 / `0x3333` 退出 1） |
| `0x0010_1000` | Goldfish RTC |
| `0x0200_0000` | CLINT（msip / mtimecmp / mtime） |
| `0x0C00_0000` | PLIC |
| `0x1000_0000` | NS16550 UART0 |
| `0x1000_1000` | VirtIO-MMIO 块设备 |
| `0x1000_2000` | VirtIO-MMIO 网卡 |
| `0x1000_3000` | VirtIO-MMIO 9P |
| `0x1000_4000` | VirtIO-MMIO GPU（加 `--pci` 时改挂 PCIe） |
| `0x1000_5000` | VirtIO-MMIO 键盘输入 |
| `0x2000_0000` | CFI NOR flash（各 32 MiB，EDK II 的 CODE / VARS） |
| `0x3000_0000` | PCIe ECAM（256 MiB） |
| `0x4000_0000` | PCIe MMIO32（1 GiB） |
| `0x8000_0000` | RAM（默认 512 MiB，`-m` 可调） |
| `0x8020_0000` | 默认内核加载地址 |
| 镜像尾端 | DTB 实际动态放置（2MB 对齐，紧跟内核/initrd 之后——固定地址会被大 initrd 覆盖） |

PLIC 中断源：1 = VirtIO 块设备、2 = 网卡、3 = 9P、4 = GPU、5 = 键盘输入、
10 = UART0、11 = RTC、32–35 = PCIe INTx（与 QEMU virt 一致）。

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
import { li, sd, sw } from './tools/encoder.ts';
import { VIRT_TEST } from './src/index.ts';

const program = [
  ...li(1, 0x80200000n),
  ...li(2, 0x1234n),
  sd(1, 2, 0),
  ...li(3, VIRT_TEST),
  ...li(4, 0x5555n),
  sw(3, 4, 0),      // 写 SiFive Test，正常退出
];
```

（`halt()` 是 `tests/harness.ts` 里的测试辅助，不在 `tools/encoder.ts` 中。）

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
├── dev/                  设备模型
│   ├── uart.ts / clint.ts / plic.ts / rtc.ts / test.ts
│   ├── virtio.ts         VirtIO 传输无关的基类
│   ├── virtio-mmio.ts    VirtIO MMIO 传输
│   ├── pci/ecam.ts       PCIe 主机桥（ECAM）
│   ├── pci/virtio-pci.ts VirtIO PCI 传输
│   ├── virtio-blk.ts / net.ts / net-slirp.ts / net-proxy.ts
│   ├── ninep.ts / virtio-9p.ts
│   └── virtio-gpu.ts / virtio-input.ts / flash.ts / disk.ts / bmp.ts
├── display/web.ts        virtio-gpu 画面推送到浏览器（WebSocket + 脏矩形增量）
├── loader/               ELF64 装载 + DTB 生成
├── machine.ts            virt 机器组装与主循环
├── index.ts              公共 API 导出
└── cli.ts                命令行入口
tools/encoder.ts          RISC-V 指令编码器（测试与示例用）
tests/                    222 项单元测试（node:test）
```

## 测试

```bash
npm test                              # 全部 222 项（25 个文件）
npx tsx --test tests/mmu.test.ts      # 单个模块
npm run typecheck                     # 类型检查（当前 0 错误）
```

覆盖范围：RV64I 全部整数指令与访存、M 扩展（含除零/溢出）、A 扩展（LR/SC/AMO）、
F/D 扩展（舍入模式、NaN 装箱、FCLASS）、RVC 压缩指令、Zba/Zbb/Zbs/Zicntr、
CSR/陷阱/中断委派、Sv39/Sv48 翻译与权限、严格 NX（X=0 页取指必须 fault）、
全部外设协议（UART / virtio-blk / net / 9p / gpu / input / PCI）、
以及整机端到端（定时器中断、WFI、计数器进位护栏）。

## 性能与设计取舍

- **数据通路使用 `bigint`**：语义与硬件完全一致（无 2^53 精度陷阱），可读性好；
  代价是速度，解释执行天然慢于 JIT 模拟器。
- 热路径已做多层优化（Linux 引导实测）：satp 派生值缓存、TLB 键 bigint 精简、
  RAM 直读（绕总线分发与装箱）、中断状态合并、`performance.now()` 批采样、
  定时器到期检测挪到 64 条节拍、icache 条目池化、立即数用整数移位做符号扩展。
  当前吞吐：裸机基准 **3–6 MIPS**、Linux guest **约 2 MIPS**。
  ⚠️ 绝对值对宿主负载非常敏感（同一份代码在安静时段能到 6 MIPS，宿主另跑着
  多个 node 进程时掉到 3.2），**只有同机背靠背的 A/B 对比才有意义**；
  跨时段的绝对值不要拿来下结论。下文各启动章节里的历史数字是当时那次跑的
  真实记录，不代表当前最优。
- 若需要更高性能，可按以下路线继续（接口已预留）：
  1. 64 位值改用 hi/lo 两个 32 位 `number` 分量表示。算术层本身已用
     `tools/bench-hilo.ts` 量过：单项合计 **4.4x**、一条指令的混合运算
     **8.35x** —— 假设成立，但净收益还会更低（要扣掉与 MMU/总线交界处的
     重新合成、mul/div 代码变长、execute 全线重写），且是 all-or-nothing 的改动；
  2. 取指路径引入代码缓存（basic-block cache）；
  3. 终极方案是 WASM JIT。
- **非对齐访存默认逐字节模拟（宽容）**，与真实 RISC-V virt 硬件及 QEMU 的行为一致。
  这是跑 Linux 的必要条件：内核模块重定位（`apply_r_riscv_64_rela`）会做非对齐 8 字节
  存储，若按规范抛异常会直接 Oops。要规范精确的行为请加 `--misaligned trap`
  （单元测试即在此模式下验证规范语义）。

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

本程序以 **Apache-2.0** 授权，请参阅LICENSE以了解许可证下的具体权利和限制。**在适用法律允许的范围内，本程序按原样(AS IS) 提供，不附带任何明示和暗示的担保。**
