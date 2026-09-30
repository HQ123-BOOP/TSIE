# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE

<#
.SYNOPSIS
  引导路 ①：OpenSBI fw_jump 直接跳转内核（PowerShell 孪生）。

.DESCRIPTION
  OpenSBI fw_jump.bin  ──跳转──▶  内核 Image（+ initramfs）

  最短的一条路：没有中间固件。fw_jump 按约定跳到 0x80200000，内核就在那儿等着，
  initramfs 由 CLI 的 --initrd 交给内核。要的东西最少（OpenSBI + Alpine 内核/initramfs），
  引导也最快。

  这条路只跑 Alpine：Debian 的 riscv64 内核是 EFI stub 的 PE 镜像（文件开头是 MZ），
  fw_jump 直跳过去第一条指令就是非法指令 —— 必须由固件按 EFI 方式加载，也就是必须走
  另外两条路。所以 -Distro debian / -DebianImage 在这里直接报错退出。

  行为与 tools/bootstrap-direct.sh 逐项对齐，机制与文案在 tools/lib/bootstrap-common.ps1
  （三个入口共用的唯一一份）。用法文本在 tools/i18n/usage.direct.<语言>.txt。

  设计约定（照着改之前先读）：
    * 版本号一律动态发现，不硬编码。Alpine 的包更新很快，写死的 URL 会 404
      （README 里那个 linux-lts-6.18.44 在 2026-09-26 就已经是 404）。
    * 所有产物落在 gitignored 目录（firmware/、tmp/），不得入库：
      这些是 GPL-2.0 / 第三方产物，本项目是 Apache-2.0。
    * 下载全部带重试。本机网络对 dl-cdn / deb.debian.org 是间歇性可达的，
      同一个域名前一刻成功、后一刻 21 秒超时，不带重试必然随机失败。
    * GitHub release 资产直连不通（github.com 能到，但 302 之后的
      objects.githubusercontent.com 超时），所以需要镜像。镜像属代理转发，
      脚本会先征求同意（-Mirror 可预先授权）。

.EXAMPLE
  pwsh tools/bootstrap-direct.ps1
  pwsh tools/bootstrap-direct.ps1 -Help                  # 也可以 --help / -h / -?
  pwsh tools/bootstrap-direct.ps1 -Mirror -NoDecompress
  pwsh tools/bootstrap-direct.ps1 -Decompress            # 无人值守时预先同意解压 initramfs
  pwsh tools/bootstrap-direct.ps1 -Alpine v3.24 -Dir tmp/boot-pinned
  pwsh tools/bootstrap-direct.ps1 -Lang en               # 英文输出（默认跟随系统区域）
  pwsh tools/bootstrap-direct.ps1 --lang en --help       # 英文用法文本

.NOTES
  需要 PowerShell 7+（`pwsh`，不是 Windows 自带的 `powershell.exe` 5.1）。
  脚本启动时会检测版本：5.1 会打印一段安装提示、等 5 秒后以退出码 1 结束。

  本文件刻意带 UTF-8 BOM，别把它删掉：5.1 按 ANSI/GBK 读无 BOM 的 UTF-8 脚本，
  会直接抛一堆语法错误 —— 那样它连上面那段"请装 7+"的提示都读不到，用户只会看到乱码报错。
  CI 的 hygiene 作业会检查这个 BOM 还在不在。

  依赖（缺失时的后果已注明）：
    必需  curl.exe              Windows 10 1803+ 自带，或装 Git for Windows
    必需  tar.exe               必须是 Windows 自带的那个 bsdtar，不是 Git 的 GNU tar。
                                两者同名但能力不同：共享库里显式取 System32\tar.exe，
                                因为 PATH 里 Git 的 tar.exe 排在前面且不支持 ar。
    必需  node + tsx            打 initramfs 用 tools/initramfs.ts，tsx 是 devDependency
                                （先 npm install）。这一步不经过磁盘：直接从 tar 头里
                                读 mode/linkname 组装 cpio，所以 "Windows 建不了符号链接、
                                存不住执行位" 都不影响它。已不再需要 Python。
    不需要 xz                   OpenSBI 是 .tar.xz，但 tar/bsdtar 自己经 liblzma 解压。

  传 -Dir 时用正斜杠或相对路径：PowerShell 会把双引号里的 `\t`、`\n` 当转义序列，
  写 `-Dir G:\tmp\ps-test` 会静默变成 `G:tmpps-test`（`\t` = 制表符）。
  已知坑：本机 dl-cdn 会重定向且速度在 45 KB/s~5 KB/s 间摆动，故下载走 -C - 断点续传
  并按最终响应的 Content-Length 判完成；`.part` 还记录来源 URL，换源即重下。
#>

# PositionalBinding = $false 是故意的，别去掉。
# 默认情况下没人认领的参数会被当成"第一个位置参数"静默绑给 $Alpine ——
# 实测 `./bootstrap-direct.ps1 --help` 在加上 -Help 之前会变成"Alpine 分支: --help"，
# 然后一路跑到下载失败。拼错的参数应当当场报错，而不是悄悄变成别的意思。
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Help,        # 显示帮助。`-Help` / `-h` / `--help` 三种写法都行
  [switch]$Mirror,      # 预先授权镜像（无人值守）
  [switch]$NoMirror,    # 禁止镜像；OpenSBI 只从本地已有文件取
  [switch]$Decompress,  # 预先同意解压 initramfs（无人值守）
  [switch]$NoDecompress,# 不要解压，只留 .cpio.gz
  [string]$Alpine,      # Alpine 分支（默认 latest-stable 别名，在共享库里）
  [string]$Distro,      # 素材发行版 alpine|debian（这条路只认 alpine，见 -DebianImage）
  [string]$DebianImage, # 本地已有的 Debian generic .raw（这条路用不上，给了会报错）
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
$BootPath = 'direct'
. "$PSScriptRoot\lib\bootstrap-common.ps1"

# 这条路自己的选项（公共选项由 Initialize-BsArgs 处理）。
# 与 .sh 的 DECOMPRESS 一样是三态：ask 时 Install-Alpine 会问一句。
$script:DecompressMode = if ($Decompress) { 'yes' } elseif ($NoDecompress) { 'no' } else { 'ask' }

Initialize-BsArgs -Extra @{
  '--decompress'    = { $script:DecompressMode = 'yes' }
  '--no-decompress' = { $script:DecompressMode = 'no' }
}
# Debian 在这条路上没有任何可行做法（见 .DESCRIPTION 里的说明），所以不下载、不生成，
# 直接说清楚退出去 —— 而不是下一个到 0x80200000 也起不来的镜像。
if ($script:DistroSel -ne 'alpine') { Write-Die 'distro.directNoDebian' }
Initialize-BsEnv

# 编号写在调用处，不进文案表（.sh 侧同样：`log "① $(msg stage.opensbi)"`）
Show-BsBanner
Write-Host ''
Write-LogRaw "① $(Msg 'stage.opensbi')"
Install-OpenSbi
Write-Host ''
Write-LogRaw "② $(Msg 'stage.alpine')"
Install-Alpine
Show-BsArtifacts
Show-TailDirect
