# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE

<#
.SYNOPSIS
  引导路 ②：U-Boot 拉内核（PowerShell 孪生）。

.DESCRIPTION
  OpenSBI fw_jump  ──▶  U-Boot（S 模式负载）──从 FAT 盘 fatload──▶  内核 Image + initramfs

  比直接跳转多一层真实的引导器：U-Boot 自己去 virtio 盘上按**文件**读内核与 initramfs
  （fatload），再用 booti 交接（命令行走 bootargs）。产物比 ① 多两样：U-Boot 固件，
  以及一块装了内核与 initramfs 的 FAT16 盘（含 U-Boot 的命令脚本 uboot-cmd.txt）。

  盘由项目自己的 tools/mkfat.ts 手写生成 —— 不借 mtools / mkfs.vfat，Windows 上也没有它们。
  行为与 tools/bootstrap-uboot.sh 逐项对齐，机制与文案在 tools/lib/bootstrap-common.ps1
  （三个入口共用的唯一一份）。用法文本在 tools/i18n/usage.uboot.<语言>.txt。

  素材按发行版分岔（-Distro）：
    alpine（默认）  内核 + initramfs 放进我们自己做的 FAT16 盘，booti 交接
    debian          官方 generic 云镜像整盘（GPT：p1 rootfs ext4、p15 ESP + GRUB），
                    -Disk 指向它，命令脚本用 bootefi bootmgr 让 U-Boot 的 EFI 启动管理器
                    去起镜像自带 ESP 上的 GRUB，之后内核/initrd/root= 全由 GRUB 自己解析
                    （所以脚本不必在宿主侧读 ext4）。已下载过镜像可用 -DebianImage 复用；
                    这条路只写命令脚本，不做盘。

  设计约定（照着改之前先读）：
    * 版本号一律动态发现。U-Boot 取自 Debian 的 u-boot-qemu 包（池目录里取最新版本），
      包里有两份 ELF，要的是 qemu-riscv64_smode/uboot.elf（由 SBI 固件引导的那份）。
    * 所有产物落在 gitignored 目录（firmware/、tmp/），不得入库：U-Boot 是 GPL-2.0，
      本项目是 Apache-2.0。
    * 下载全部带重试；GitHub release 资产直连不通时用镜像，用之前先征求同意。

.EXAMPLE
  pwsh tools/bootstrap-uboot.ps1
  pwsh tools/bootstrap-uboot.ps1 -Help                  # 也可以 --help / -h / -?
  pwsh tools/bootstrap-uboot.ps1 -Mirror -NoDecompress
  pwsh tools/bootstrap-uboot.ps1 -Decompress            # 无人值守时预先同意解压 initramfs
  pwsh tools/bootstrap-uboot.ps1 -Alpine v3.24 -Dir tmp/boot-pinned
  pwsh tools/bootstrap-uboot.ps1 -Distro debian         # 用官方 Debian 13 整盘镜像
  pwsh tools/bootstrap-uboot.ps1 -DebianImage G:/tslinux/debian13.raw   # 复用已下载的镜像
  pwsh tools/bootstrap-uboot.ps1 -Lang en               # 英文输出（默认跟随系统区域）
  pwsh tools/bootstrap-uboot.ps1 --lang en --help       # 英文用法文本

.NOTES
  需要 PowerShell 7+（`pwsh`，不是 Windows 自带的 `powershell.exe` 5.1）。
  脚本启动时会检测版本：5.1 会打印一段安装提示、等 5 秒后以退出码 1 结束。

  本文件刻意带 UTF-8 BOM，别把它删掉：5.1 按 ANSI/GBK 读无 BOM 的 UTF-8 脚本，
  会直接抛一堆语法错误 —— 那样它连上面那段"请装 7+"的提示都读不到，用户只会看到乱码报错。
  CI 的 hygiene 作业会检查这个 BOM 还在不在。

  依赖（缺失时的后果已注明）：
    必需  curl.exe              Windows 10 1803+ 自带，或装 Git for Windows
    必需  tar.exe               必须是 Windows 自带的那个 bsdtar，不是 Git 的 GNU tar：
                                U-Boot 的 .deb 是 ar 归档，GNU tar 解不了。共享库里显式取
                                System32\tar.exe，因为 PATH 里 Git 的 tar.exe 排在前面。
    必需  node + tsx            打 initramfs（tools/initramfs.ts）、生成 FAT 盘
                                （tools/mkfat.ts）都走项目自己的 TypeScript 工具，tsx 是
                                devDependency（先 npm install）。
    可选  7-Zip                 解 .deb 的兜底候选；bsdtar 可用时用不到它。
    不需要 xz                   OpenSBI 是 .tar.xz，但 tar/bsdtar 自己经 liblzma 解压。

  传 -Dir 时用正斜杠或相对路径：PowerShell 会把双引号里的 `\t`、`\n` 当转义序列，
  写 `-Dir G:\tmp\ps-test` 会静默变成 `G:tmpps-test`（`\t` = 制表符）。
  已知坑：本机 dl-cdn 会重定向且速度在 45 KB/s~5 KB/s 间摆动，故下载走 -C - 断点续传
  并按最终响应的 Content-Length 判完成；`.part` 还记录来源 URL，换源即重下。
#>

# PositionalBinding = $false 是故意的，别去掉。
# 默认情况下没人认领的参数会被当成"第一个位置参数"静默绑给 $Alpine ——
# 实测 `./bootstrap-uboot.ps1 --help` 在加上 -Help 之前会变成"Alpine 分支: --help"，
# 然后一路跑到下载失败。拼错的参数应当当场报错，而不是悄悄变成别的意思。
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Help,        # 显示帮助。`-Help` / `-h` / `--help` 三种写法都行
  [switch]$Mirror,      # 预先授权镜像（无人值守）
  [switch]$NoMirror,    # 禁止镜像
  [switch]$Decompress,  # 预先同意解压 initramfs（无人值守）
  [switch]$NoDecompress,# U-Boot 从盘上读的那份 initramfs 不要解压
  [string]$Alpine,      # Alpine 分支（默认 latest-stable 别名，在共享库里）
  [string]$Distro,      # 素材发行版 alpine|debian（默认 alpine；-DebianImage 会自动切到 debian）
  [string]$DebianImage, # 本地已有的 Debian generic .raw：给了就按 debian 走，且不下载
  [string]$Dir,         # 换输出目录（默认 tmp/boot）
  [string]$Lang,        # 输出语言 zh|en（默认跟随系统区域；也可用 TSIE_LANG）
  # 接住没人认领的位置参数。PowerShell 不认 `--name` 这种写法（只认 `-name`），
  # 所以 `--help` 到不了 -Help 开关上，会原样落进这里（实测；它不是被拆成 `help`）。
  # 拼错的 `-X` 同样落进来 —— 于是两种写法都能用选定的语言报错，而不是让
  # PowerShell 用它自己的语言抛绑定错误。
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

# 与 .sh 一致：BOOT_PATH 在 source/点源共享库**之前**设好（决定打印哪一份用法文本）。
$BootPath = 'uboot'
. "$PSScriptRoot\lib\bootstrap-common.ps1"

# 这条路自己的选项（公共选项由 Initialize-BsArgs 处理）。
# 与 .sh 的 DECOMPRESS 一样是三态：ask 时 Install-Alpine 会问一句。
$script:DecompressMode = if ($Decompress) { 'yes' } elseif ($NoDecompress) { 'no' } else { 'ask' }

Initialize-BsArgs -Extra @{
  '--decompress'    = { $script:DecompressMode = 'yes' }
  '--no-decompress' = { $script:DecompressMode = 'no' }
}
Initialize-BsEnv

# 编号写在调用处，不进文案表（.sh 侧同样：`log "① $(msg stage.opensbi)"`）
Show-BsBanner
Write-Host ''
Write-LogRaw "① $(Msg 'stage.opensbi')"
Install-OpenSbi
Write-Host ''
if ($script:DistroSel -eq 'debian') {
  Write-LogRaw "② $(Msg 'stage.debian')"
  Install-Debian
} else {
  Write-LogRaw "② $(Msg 'stage.alpine')"
  Install-Alpine
}
Write-Host ''
Write-LogRaw "③ $(Msg 'stage.uboot')"
Install-Uboot
Write-Host ''
if ($script:DistroSel -eq 'debian') {
  Write-LogRaw "④ $(Msg 'stage.ubootCmds')"
  Install-UbootCmds
} else {
  Write-LogRaw "④ $(Msg 'stage.disk')"
  Install-UbootDisk
}
Show-BsArtifacts
Show-TailUboot
