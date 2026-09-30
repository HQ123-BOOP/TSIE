# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE

<#
.SYNOPSIS
  引导路 ③：EDK II (UEFI) 里把 Linux 拉起来（PowerShell 孪生）。

.DESCRIPTION
  EDK II 固件（CFI flash 里的 CODE + VARS）──BDS──▶  UEFI Shell
      └─ 自动执行 ESP 上的 startup.nsh：先 initrd，再启动内核的 EFI stub

  这条路**不下载任何第三方引导器**。Debian 的 qemu-efi-riscv64 固件里自带：

    * UEFI Shell（没有可引导项时 BDS 会落到它）；
    * `initrd` 命令（OvmfPkg/LinuxInitrdDynamicShellCommand）—— 把盘上的文件注册成
      Linux initrd 的 device path，内核的 EFI stub 便会去读它；
    * 于是内核命令行可以像普通参数一样跟在 EFI 程序后面传进去。

  ESP（EFI 系统分区）是一块 FAT16 盘（分区类型 0xEF），上面三样东西：startup.nsh、
  Image（Alpine 内核，它带 EFI stub）、initramfs。盘由项目自己的 tools/mkfat.ts 生成。

  这条路也要 OpenSBI（产物里的 fw_jump.bin）：一是模拟器的 CLI 要求 --kernel 或 --bios
  至少有一个，二是 EDK II 在 RISC-V 上要用 SBI 的定时器/IPI/复位，没有 SBI 固件根本走不到
  UEFI 引导界面。另外还产出一段 8 字节跳板 edk2-tramp.bin：CLI 把 --kernel 装在
  0x80200000，而固件在 pflash 0x20000000，中间差一次跳转。

  行为与 tools/bootstrap-edk2.sh 逐项对齐，机制与文案在 tools/lib/bootstrap-common.ps1
  （三个入口共用的唯一一份）。用法文本在 tools/i18n/usage.edk2.<语言>.txt。

  素材按发行版分岔（-Distro）：
    alpine（默认）  内核 + initramfs 放进我们自己做的 ESP，BDS 落到 UEFI Shell 后由
                    startup.nsh 先 initrd 再启动内核
    debian          官方 generic 云镜像整盘：ESP 与 GRUB 都是镜像自带的（p15），固件的
                    BDS 按"可移动介质"规则直接起来 \EFI\BOOT\BOOTRISCV64.EFI，之后
                    内核/initrd/root= 由 GRUB 自己解析 —— 所以这条路不再做 ESP，
                    脚本也不需要在宿主侧读 ext4。已下载过镜像可用 -DebianImage 复用。

  设计约定（照着改之前先读）：
    * 版本号一律动态发现（EDK II 取自 Debian 的 qemu-efi-riscv64 包，Alpine 取自官方目录）。
    * 所有产物落在 gitignored 目录（firmware/、tmp/），不得入库：EDK II 是第三方二进制，
      本项目是 Apache-2.0。
    * 两块 flash 各 32 MiB 是 EDK II 的硬要求，尺寸不对它会拒绝加载，脚本会核对。
    * 固件卷里压着一层 LZMA，默认先剥掉（tools/uncompress-fv.ts）：不剥的话固件自己解压
      要十分钟，纯属白烧指令。剥出来的那份叫 RISCV_VIRT_CODE.nocomp.fd，引导命令用它。

.EXAMPLE
  pwsh tools/bootstrap-edk2.ps1
  pwsh tools/bootstrap-edk2.ps1 -Help                  # 也可以 --help / -h / -?
  pwsh tools/bootstrap-edk2.ps1 -Mirror
  pwsh tools/bootstrap-edk2.ps1 -NoEsp                 # 只要固件，不建 ESP
  pwsh tools/bootstrap-edk2.ps1 -FirmwareOnly          # 同上（等价写法，语义更直白）
  pwsh tools/bootstrap-edk2.ps1 -NoStrip               # 不剥 LZMA（产物与上游一致，但慢）
  pwsh tools/bootstrap-edk2.ps1 -Alpine v3.24 -Dir tmp/boot-pinned
  pwsh tools/bootstrap-edk2.ps1 -Distro debian          # 用官方 Debian 13 整盘镜像
  pwsh tools/bootstrap-edk2.ps1 -DebianImage G:/tslinux/debian13.raw   # 复用已下载的镜像
  pwsh tools/bootstrap-edk2.ps1 -Lang en               # 英文输出（默认跟随系统区域）
  pwsh tools/bootstrap-edk2.ps1 --lang en --help       # 英文用法文本

.NOTES
  需要 PowerShell 7+（`pwsh`，不是 Windows 自带的 `powershell.exe` 5.1）。
  脚本启动时会检测版本：5.1 会打印一段安装提示、等 5 秒后以退出码 1 结束。

  本文件刻意带 UTF-8 BOM，别把它删掉：5.1 按 ANSI/GBK 读无 BOM 的 UTF-8 脚本，
  会直接抛一堆语法错误 —— 那样它连上面那段"请装 7+"的提示都读不到，用户只会看到乱码报错。
  CI 的 hygiene 作业会检查这个 BOM 还在不在。

  依赖（缺失时的后果已注明）：
    必需  curl.exe              Windows 10 1803+ 自带，或装 Git for Windows
    必需  tar.exe               必须是 Windows 自带的那个 bsdtar，不是 Git 的 GNU tar：
                                EDK II 的 .deb 是 ar 归档，GNU tar 解不了。共享库里显式取
                                System32\tar.exe，因为 PATH 里 Git 的 tar.exe 排在前面。
    必需  node + tsx            打 initramfs（tools/initramfs.ts）、生成 ESP
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
# 实测 `./bootstrap-edk2.ps1 --help` 在加上 -Help 之前会变成"Alpine 分支: --help"，
# 然后一路跑到下载失败。拼错的参数应当当场报错，而不是悄悄变成别的意思。
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Help,        # 显示帮助。`-Help` / `-h` / `--help` 三种写法都行
  [switch]$Mirror,      # 预先授权镜像（无人值守）
  [switch]$NoMirror,    # 禁止镜像
  [switch]$NoEsp,       # 只要固件，不建 ESP（内核/initramfs 也就不必取）
  [switch]$FirmwareOnly,# 同上（等价写法，语义更直白）
  [switch]$Strip,       # 剥掉固件卷里的 LZMA 层（默认就剥，引导快约 5 倍）
  [switch]$NoStrip,     # 不剥 LZMA：产物与上游一致，但每次引导要多烧十分钟
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
$BootPath = 'edk2'
. "$PSScriptRoot\lib\bootstrap-common.ps1"

# 这条路自己的选项（公共选项由 Initialize-BsArgs 处理）。
# 注意这条路**没有**解压 initramfs 的开关：与 .sh 的 bootstrap-edk2.sh 一样，
# Install-Alpine 会用默认的 ask 问一句（EDK II 自己认得 initrd，解不解压只是快慢）。
$script:DoEsp = $true
$script:DoAlpine = $true
if ($NoEsp) { $script:DoEsp = $false }
if ($FirmwareOnly) { $script:DoEsp = $false; $script:DoAlpine = $false }
# 剥 LZMA 默认开着（与 .sh 的 DO_STRIP=1 一致）：固件自己解压要十分钟，纯属白烧指令
if ($NoStrip) { $script:DoStrip = $false } elseif ($Strip) { $script:DoStrip = $true }

Initialize-BsArgs -Extra @{
  '--no-esp'        = { $script:DoEsp = $false }
  '--firmware-only' = { $script:DoEsp = $false; $script:DoAlpine = $false }
  '--no-strip'      = { $script:DoStrip = $false }
  '--strip'         = { $script:DoStrip = $true }
}
Initialize-BsEnv

# 编号写在调用处，不进文案表（.sh 侧同样：`log "① $(msg stage.opensbi)"`）。
# 这条路也要 OpenSBI：一是 CLI 要求 --kernel 或 --bios 至少有一个，二是 EDK II 在
# RISC-V 上要用 SBI 的定时器/IPI/复位，没有 SBI 固件走不到 UEFI 引导界面。
# 不要 ESP 时内核/initramfs 根本不必取，编号也就跟着挪 —— 与 .sh 的分支一一对应。
Show-BsBanner
Write-Host ''
Write-LogRaw "① $(Msg 'stage.opensbi')"
Install-OpenSbi
Write-Host ''
# 第二条要的东西按发行版分岔：Alpine 是内核 + initramfs，Debian 是它自己的整盘镜像。
# -FirmwareOnly 两边一样，都表示"不要素材，只要固件"。
if ($script:DoAlpine) {
  if ($script:DistroSel -eq 'debian') {
    Write-LogRaw "② $(Msg 'stage.debian')"
    Install-Debian
  } else {
    Write-LogRaw "② $(Msg 'stage.alpine')"
    Install-Alpine
  }
  Write-Host ''
  Write-LogRaw "③ $(Msg 'stage.edk2')"
} else {
  Write-LogRaw "② $(Msg 'stage.edk2')"
}
Install-Edk2
# ESP 只有 Alpine 那条路要做：Debian 镜像的 p15 上就是它自己的 ESP，上面是 GRUB，
# 固件的 BDS 会按"可移动介质"规则去 \EFI\BOOT\BOOTRISCV64.EFI 把它起来。
if ($script:DoEsp -and $script:DistroSel -ne 'debian') {
  Write-Host ''
  Write-LogRaw "④ $(Msg 'stage.esp')"
  Install-Esp
}
Show-BsArtifacts
Show-TailEdk2
