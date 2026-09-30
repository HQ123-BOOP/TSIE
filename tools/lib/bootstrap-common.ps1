# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
#
# 三个 PowerShell 引导脚本的共享实现（**不是**可执行入口，只被点源）：
#
#   tools/bootstrap-direct.ps1   OpenSBI fw_jump 直接跳转内核
#   tools/bootstrap-uboot.ps1    OpenSBI → U-Boot → 内核（U-Boot 自己从 FAT 盘上拉）
#   tools/bootstrap-edk2.ps1     EDK II (UEFI) 固件 + ESP（UEFI 里把 Linux 拉起来）
#
# 入口脚本只负责：声明这条引导路要哪些素材、按什么顺序取、最后打印哪几条引导命令。
# 取素材的机制（下载重试 / 镜像 / ar 拆包 / cpio / FAT）与文案都写在这里，只有一份。
#
# 这是 tools/lib/bootstrap-common.sh 的孪生：函数一一对应
# （log/warn/die → Write-Log/Write-Warn/Write-Die，fetch → Invoke-Fetch，
#   bootstrap_uboot_disk → Install-UbootDisk …），行为也逐项对齐。
#
# 素材有两种发行版可选（-Distro）：
#   alpine（默认）  内核 + minirootfs 打成的 initramfs，三条路都能跑，体积小、引导快
#   debian          官方 generic 云镜像整盘，只有两条带 UEFI 的路能跑
# 与 .sh 侧同规则；Debian 为什么跑不了路 ① 见那边的文件头（内核是 EFI stub 的 PE 镜像，
# 开头是 MZ，直跳过去第一条指令就是非法指令）。
#
# 设计约定（照着改之前先读）：
#   * 版本号一律动态发现，不硬编码。Alpine 的包更新很快，写死的 URL 会 404
#     （README 里那个 linux-lts-6.18.44 在 2026-09-26 就已经是 404）。
#   * 所有产物落在 gitignored 目录（firmware/、tmp/），不得入库：
#     这些是 GPL-2.0 / 第三方产物，本项目是 Apache-2.0。
#   * 下载全部带重试。本机网络对 dl-cdn / deb.debian.org 是间歇性可达的，
#     同一个域名前一刻成功、后一刻 21 秒超时，不带重试必然随机失败。
#   * GitHub release 资产直连不通（github.com 能到，但 302 之后的
#     objects.githubusercontent.com 超时），所以需要镜像。镜像属代理转发，
#     脚本会先征求同意（-Mirror 可预先授权）。
#   * 文案与 .sh 共用同一张表 tools/i18n/messages.tsv（key<TAB>中文<TAB>English），
#     -Help 打印的是 tools/i18n/usage.<路>.<语言>.txt；两者都跟随 -Lang / TSIE_LANG / 系统区域。
#
# 与 .sh 侧**故意不同**的地方（不是漏了，是 Windows 上不存在那个问题）：
#   * 没有"借一份静态 bsdtar"那一档。.sh 侧那一档是为 macOS / FreeBSD 准备的
#     （系统既没 bsdtar 也没 7-Zip 时），而 Windows 10 1803+ 自带
#     C:\Windows\System32\tar.exe，那本身就是 bsdtar（libarchive）。
#     本机连 7-Zip 都不需要，只是多一个候选。所以这里只有"系统里已有的工具"一档：
#     谁真能解 ar 一律由实读一次 .deb 判定（见 Test-ArTool），不看名字。
#   * 下载统一走 curl.exe（Windows 自带的就够），这样与 .sh 版本共用同一套旗标语义
#     （--retry / --noproxy / -4 / -C -），避免 Invoke-WebRequest 的差异。
#   * sha256 不依赖 sha256sum（Windows 没有），用 Get-FileHash。
#   * gzip 解压不走外部命令（Git Bash 才有 gzip），用 .NET 的 GZipStream。
#
# 依赖（缺失时的后果已注明）：
#   必需  curl.exe              Windows 10 1803+ 自带，或装 Git for Windows
#   必需  tar.exe               必须是 Windows 自带的那个 bsdtar，不是 Git 的 GNU tar。
#                               两者同名但能力不同：这里显式取 System32\tar.exe，
#                               因为 PATH 里 Git 的 tar.exe 排在前面且不支持 ar。
#   必需  node + tsx            打 initramfs（tools/initramfs.ts）、生成 FAT 盘
#                               （tools/mkfat.ts）都用项目自己的工具链，tsx 是 devDependency
#                               （先 npm install）。initramfs 这一步不经过磁盘：直接从 tar
#                               头里读 mode/linkname 组装 cpio，所以 "Windows 建不了符号链接、
#                               存不住执行位" 都不影响它。已不再需要 Python。
#   可选  7-Zip                 解 .deb（ar 归档）的兜底候选，bsdtar 不可用时才轮到它。
#   不需要 xz                   OpenSBI 是 .tar.xz，但 tar/bsdtar 自己经 liblzma 解压。
#
# 本文件在 tools/lib/ 下，仓库根是再上两级。注意被点源时 $PSScriptRoot 指的是**本文件**
# 所在目录（tools/lib），不是入口脚本的目录 —— 与 .sh 侧 ${BASH_SOURCE[0]} 的语义一致。
$script:BsLibPath = $MyInvocation.MyCommand.Path
if (-not $script:BsLibPath) { $script:BsLibPath = $PSCommandPath }
$script:RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $script:BsLibPath))
$script:OutDir = Join-Path $script:RepoRoot 'tmp\boot'
$script:FwDir  = Join-Path $script:RepoRoot 'firmware'
# Alpine 分支：默认用 latest-stable 别名 —— 语义正确，且不会随发行版推进而失效。
# （曾想自己算"最高版本号"，但那既多余又有 bug：v4.0 编码成 4000 会小于 v3.24 的 3024。）
# 需要固定分支时用 -Alpine v3.24。
$script:AlpineBranch = 'latest-stable'
$script:Arch = 'riscv64'
# 官方 dl-cdn 是本机唯一稳定可用的 Alpine 源；国内镜像对 v3.24 普遍未同步（实测
# 清华 403、阿里/南大/上交/华为 404）。所以镜像只作为官方源失败时的兜底，
# 不指望它更快。多一个源就自动获得"换源重试"，且校验值仍取自官方 manifest。
$script:AlpineMirror = 'https://mirrors.ustc.edu.cn/alpine'

# 发行版：alpine | debian（见文件头的"素材有两种发行版可选"）
$script:DistroSel = 'alpine'
# Debian 素材：官方 cloud 镜像（GPT：p1 = rootfs(ext4)、p15 = ESP(FAT16)，ESP 上是
# Debian 自己的 GRUB）。不按"内核 + initramfs 两件套"抓，理由是 .sh 侧文件头里写的那些。
$script:DebianBase  = 'https://cdimage.debian.org/images/cloud/trixie/latest'
$script:DebianTar   = 'debian-13-generic-riscv64.tar.xz'
$script:DebianImagePath = ''      # -DebianImage：本地已有的 .raw，给了就不下载
$script:DebianRaw   = ''      # Install-Debian 定下来的那份镜像（要交给模拟器的路径）

$script:MirrorMode = 'ask'          # ask | yes | no
$script:MirrorOk   = $false         # 本轮是否已就"用镜像"取得同意（问过一次就不再问）
# 名字不叫 $script:Decompress：入口的 -Decompress 是个 [switch] 参数，而参数变量就在入口的
# 脚本作用域里 —— 同名赋值会被判成「把字符串塞进 SwitchParameter」（实测，启动即报错）。
$script:DecompressMode = 'ask'      # ask | yes | no：是否额外产出一份未压缩 initramfs
$script:DoEdk2     = $true          # 只有 edk2 那条路的入口会用到 EDK II
$script:DoEsp      = $true
$script:DoAlpine   = $true
$script:InitrdFile = 'initramfs.cpio.gz'   # 最终推荐用哪一份引导（解压成功则换成 .cpio）
# EDK II 那条路用哪份 CODE 固件（剥过 LZMA 则换成 .nocomp.fd）。入口打印引导命令时用它。
$script:Edk2CodeFile = 'RISCV_VIRT_CODE.fd'
$script:DoStrip = $true             # 剥掉固件卷里的 LZMA 层（引导快约 5 倍；-NoStrip 可关）
$script:BootPath   = if ($BootPath) { $BootPath } else { 'direct' }   # 决定打印哪份用法文本
$script:BsDoHelp   = $false

# ---------------------------------------------------------------- 语言 / i18n
#
# 文案表是**单一来源**：tools/i18n/messages.tsv（key<TAB>zh<TAB>en）。
# 选 TSV 而不是 JSON 是被 bash 逼的：bash 没有内置 JSON 解析器，为了这个引 jq 就多一个
# 依赖；而 TSV 三种语言都能零依赖读，成对维护两份内联文案则迟早漂移。
#
# 这一段刻意只用在 PowerShell 5.1 里也合法的语法，并且放在版本守卫**之前** ——
# 守卫自己也要按当前语言说话（本文件带 UTF-8 BOM，5.1 才读得进来）。
$script:MsgFile = Join-Path $script:RepoRoot 'tools\i18n\messages.tsv'
$script:MsgTable = @{}
$script:MsgLoaded = $false

# 中文 Windows 的控制台默认是 GBK/936，而本文件里的文案是 UTF-8。这里**最早**就把输出
# 编码定成 UTF-8，理由有两个：
#   * 参数解析阶段的报错（拼错的开关、-Lang fr、-Distro 给了别的值）也走 Write-Die，
#     那时 Initialize-BsEnv 还没跑；不定的话这些行会按 GBK 编出去 —— 重定向到文件或管给
#     grep 时就是乱码，CI 里那条"非法 TSIE_LANG 要报错"的检查正是这样读的。
#   * 之后所有子进程（node / tsx / curl）的输出也是 UTF-8，解码必须与之一致。
#     Initialize-BsEnv 里那一次保留着：同一件事，谁先跑到都不吃亏。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 跟随系统区域：明确是英文才算英文，其余（含认不出来）一律中文 —— 与 .sh 的
# detect_lang 同规则，理由也一样：本项目的文档与注释以中文为主，中文是更合理的默认。
function Get-SystemLang {
  $loc = "$($env:LC_ALL)$($env:LC_MESSAGES)$($env:LANG)"
  if ($loc) { if ($loc -imatch 'en') { return 'en' } else { return 'zh' } }
  $c = ''
  try { $c = [string][System.Globalization.CultureInfo]::CurrentUICulture.Name } catch { $c = '' }
  if (-not $c) { try { $c = [string]$PSUICulture } catch { $c = '' } }
  # 界面语言取不到时退回区域格式。两者不总是一致：.NET Framework 的 CurrentUICulture
  # 跟 Windows 显示语言走，实测本机 5.1 上是 en-US 而 CurrentCulture 是 zh-CN。
  if (-not $c) { try { $c = [string][System.Globalization.CultureInfo]::CurrentCulture.Name } catch { $c = '' } }
  if ($c -imatch '^en') { return 'en' }
  return 'zh'
}

function Test-LangValue { param([string]$v) return ($v -ieq 'zh' -or $v -ieq 'en') }

function Import-Messages {   # Import-Messages <zh|en>
  param([string]$L)
  $script:MsgTable = @{}
  $script:MsgLoaded = $false
  if (-not (Test-Path -LiteralPath $script:MsgFile)) { return }   # 表不在就退回键名，至少不崩
  foreach ($raw in @(Get-Content -LiteralPath $script:MsgFile -Encoding utf8)) {
    $line = ([string]$raw).TrimEnd([char]13)   # TSV 是 LF，但别让 CR 混进英文列
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }
    $parts = $line -split "`t"
    if ($parts.Count -lt 2) { continue }
    $key = $parts[0]; $zh = $parts[1]; $en = ''
    if ($parts.Count -ge 3) { $en = $parts[2] }
    if (-not $en) { $en = $zh }                # 英文缺失时退回中文，不打印空行
    if (-not $key) { continue }
    if ($L -eq 'en') { $script:MsgTable[$key] = $en } else { $script:MsgTable[$key] = $zh }
  }
  $script:MsgLoaded = $true
}

# Msg <key> [参数...]：取当前语言的文案，把字面 \n 换成真换行，再替换 {0}{1}…
# 键不存在时原样返回键名（与 .sh 的 msg 一致：宁可打印出裸 key，也不打印空字符串）。
function Msg {
  param([string]$Key, [object[]]$Fmt = @())
  $s = $Key
  if ($script:MsgTable.ContainsKey($Key)) { $s = $script:MsgTable[$Key] }
  $s = $s -replace '\\n', "`n"
  $i = 0
  foreach ($a in @($Fmt)) { $s = $s.Replace("{$i}", [string]$a); $i++ }
  return $s
}

# 输出层。Pad 是子条目缩进（与 .sh 的 `log "  $(msg …)"` 对齐，缩进不写进文案表）。
function Write-Log  { param([string]$Key, [object[]]$Fmt = @(), [int]$Pad = 0)
                      Write-Host ('==> ' + (' ' * $Pad) + (Msg $Key $Fmt)) -ForegroundColor Cyan }
function Write-Warn { param([string]$Key, [object[]]$Fmt = @(), [int]$Pad = 0)
                      Write-Host ((Msg 'warn.prefix') + ' ' + (' ' * $Pad) + (Msg $Key $Fmt)) -ForegroundColor Yellow }
function Write-Die  { param([string]$Key, [object[]]$Fmt = @(), [int]$Pad = 0)
                      Write-Host ((Msg 'error.prefix') + ' ' + (' ' * $Pad) + (Msg $Key $Fmt)) -ForegroundColor Red
                      exit 1 }
function Write-Ok   { param([string]$Key, [object[]]$Fmt = @())
                      Write-Host ('    ' + (Msg $Key $Fmt)) -ForegroundColor Green }
# 纯文件名 + 尺寸/路径这类没有语言成分的行不走文案表（与 .sh 的 `log "  $f  ($sz B)"` 一致），
# 但仍要有同样的前缀与颜色，否则输出会跟别的行错位。
function Write-LogRaw { param([string]$Text, [int]$Pad = 0)
                        Write-Host ('==> ' + (' ' * $Pad) + $Text) -ForegroundColor Cyan }
function Write-OkRaw  { param([string]$Text)
                        Write-Host ('    ' + $Text) -ForegroundColor Green }

# 语言值非法：报错并以 1 结束整个进程。**不能**用 `exit 1` —— 下面那段判断在本文件的
# 顶层跑（点源阶段），而点源文件里的 exit 只结束那一次点源：入口会接着往下跑，
# 因为函数还没定义而报一串 CommandNotFound，最后以 0 退出（在 5.1 与 pwsh 7 上都实测过）。
# 函数体里的 exit 没有这个问题（Write-Die 就是那样用的），顶层才有。
function Stop-BsBadLang {
  param([string]$Value)
  Write-Host ((Msg 'error.prefix') + ' ' + (Msg 'i18n.badLang' $Value)) -ForegroundColor Red
  [Environment]::Exit(1)
}

# 语言来源优先级：-Lang > TSIE_LANG > 系统区域（与 .sh 的 --lang > TSIE_LANG > 区域一致）。
# 显式给错值时报错退出，而不是静默退回中文 —— 否则 `-Lang fr` 看起来"成功了"。
# 入口的 -Lang 参数在这里可见，理由与 .sh 侧 BOOT_PATH 一样：入口先设好变量再点源本文件。
$script:LangSel = ''
if ($Lang) {
  if (Test-LangValue $Lang) { $script:LangSel = $Lang.ToLower() }
  else {
    $script:LangSel = Get-SystemLang; Import-Messages $script:LangSel
    Stop-BsBadLang $Lang
  }
} elseif ($env:TSIE_LANG) {
  if (Test-LangValue $env:TSIE_LANG) { $script:LangSel = $env:TSIE_LANG.ToLower() }
  else {
    $script:LangSel = Get-SystemLang; Import-Messages $script:LangSel
    Stop-BsBadLang $env:TSIE_LANG
  }
} else {
  $script:LangSel = Get-SystemLang
}
Import-Messages $script:LangSel

# ---------------------------------------------------------------- 版本守卫
#
# 只支持 PowerShell 7+。5.1 在这个脚本依赖的几处行为上都不一样：
#   * `$null` 传给原生命令的语义不同（见下面 curl 的 `-o NUL` 注释）；
#   * 它按 ANSI/GBK 读无 BOM 的 UTF-8 脚本 —— 本文件因此刻意带 UTF-8 BOM：
#     不是为了"支持 5.1"，而是为了让它能读懂这段提示。否则 5.1 会在解析阶段
#     抛出一堆语法错误，用户根本看不到下面这句话。
# 本文件（连同入口）只用 5.1 也认得的语法，就是为了让这个守卫真的能跑到。
if ($PSVersionTable.PSVersion.Major -lt 7) {
  # 文案表读不到时（比如只拷了这一个文件）退回内置中文：不能让 5.1 用户什么都看不到。
  if ($script:MsgLoaded) { Write-Host (Msg 'ps.needs7') }
  else {
    Write-Host '本工具不支持PowerShell 5，请参阅https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows 获取PowerShell 7+。然后重试'
  }
  Start-Sleep -Seconds 5
  # 这里**不能**写 `exit 1`：本文件是被入口点源的，而点源文件里的 exit 只结束那一次
  # 点源 —— 控制权随后回到入口，入口会在"函数一个都没定义"的状态下继续往下跑，
  # 最后以 0 退出（在 5.1 上实测过：守卫的提示后面还跟着一堆 CommandNotFound）。
  # [Environment]::Exit 才是真的结束进程，退出码就是 1。
  [Environment]::Exit(1)
}

# 与 .sh 顶部的 `set -euo pipefail` 对应：后面的每一步都假设"出错就停"，
# 不然残缺的下载/解包结果会被当成成品交给下一步。
$ErrorActionPreference = 'Stop'
# 但原生命令**不**按这条规则抛异常：本脚本处处靠 $LASTEXITCODE 判断成败
# （curl 的重试、tar/7z 的能力探测都要看到非 0 退出），而 PowerShell 7.3+ 有一条
# `$PSNativeCommandUseErrorActionPreference` 能把"非 0 退出"变成异常 ——
# 用户在 profile 里可能开着它，那样重试逻辑会在第一次超时就炸。这里显式关掉。
$PSNativeCommandUseErrorActionPreference = $false

# ---------------------------------------------------------------- 参数解析
#
# 公共参数：入口在自己的 param 块里声明 -Name 写法（-Mirror / -Alpine / -Dir / -Lang / -Help），
# 认不出来的 token（`--name` 写法、拼错的 `-X`）落到 $Rest，交给下面两个函数 ——
# 与 .sh 侧「入口的 case 认不出来就调 bs_arg_common」的结构一一对应。
# PowerShell 不认 `--name`（它不是 `-name` 的别名），所以两种写法都要照顾。
#
# Read-BsCommonArg 的返回值就是 .sh 的 BS_CONSUMED：0 = 不是公共参数、1/2 = 用掉几个。
# 用返回值而不是在函数里 shift，理由与 .sh 侧相同：函数改不了调用方的位置参数。
function Read-BsCommonArg {
  param([string[]]$Argv, [hashtable]$Extra = @{})
  if ($Argv.Count -eq 0) { return 0 }
  $one = $Argv[0]
  # 入口自己的选项（--decompress / --no-esp …）：由入口在调用处用 hashtable 注册，
  # 全是"认出来就没收一个 token"的开关，与 .sh 侧入口 case 里那几行等价。
  if ($Extra.ContainsKey($one)) { & $Extra[$one]; return 1 }
  switch -Regex ($one) {
    '^--mirror$'    { $script:MirrorMode = 'yes'; return 1 }
    '^--no-mirror$' { $script:MirrorMode = 'no';  return 1 }
    '^--alpine$'    { if ($Argv.Count -lt 2) { Write-Die 'ps.unknownArg' $one }
                      $script:AlpineBranch = $Argv[1]; return 2 }
    '^--distro$'    { if ($Argv.Count -lt 2) { Write-Die 'ps.unknownArg' $one }
                      if ($Argv[1] -in @('alpine', 'debian')) { $script:DistroSel = $Argv[1] }
                      else { Write-Die 'distro.bad' $Argv[1] }
                      return 2 }
    # 给了本地镜像就按 debian 走：单给一个"哪儿来的镜像"却没换发行版，没有第二种解释
    '^--debian-image$' { if ($Argv.Count -lt 2) { Write-Die 'ps.unknownArg' $one }
                      $script:DebianImagePath = $Argv[1]; $script:DistroSel = 'debian'; return 2 }
    '^--dir$'       { if ($Argv.Count -lt 2) { Write-Die 'ps.unknownArg' $one }
                      $script:OutDir = $Argv[1]; return 2 }
    '^--lang$'      {
                      # 立即校验并重载：这样「--lang en 后面跟个错参数」报的也是英文
                      if ($Argv.Count -lt 2) { Write-Die 'ps.unknownArg' $one }
                      if (Test-LangValue $Argv[1]) { $script:LangSel = $Argv[1].ToLower(); Import-Messages $script:LangSel }
                      else { Write-Die 'i18n.badLang' $Argv[1] }
                      return 2
                    }
    # 真打印在语言确定之后（否则 `--lang en --help` 会打成中文）
    '^(-h|\?|/\?|--h|--help)$' { $script:BsDoHelp = $true; return 1 }
  }
  return 0
}

# 参数解析收尾。入口处理完自己的选项后调用一次（与 .sh 的 bs_args_done + 入口循环等价）。
function Initialize-BsArgs {
  param([hashtable]$Extra = @{})

  # param 块的开关 → 共享状态（.sh 侧公共选项是直接解析进自己变量的，这里是同一件事）
  if ($Mirror)   { $script:MirrorMode = 'yes' }
  if ($NoMirror) { $script:MirrorMode = 'no' }
  if ($Alpine)   { $script:AlpineBranch = $Alpine }
  if ($Distro) {
    if ($Distro -in @('alpine', 'debian')) { $script:DistroSel = $Distro }
    else { Write-Die 'distro.bad' $Distro }
  }
  # 与 .sh 侧一致：给了本地镜像就按 debian 走（-Distro alpine -DebianImage x 时后者赢）
  if ($DebianImage) { $script:DebianImagePath = $DebianImage; $script:DistroSel = 'debian' }
  if ($Dir)      { $script:OutDir = $Dir }
  if ($Help)     { $script:BsDoHelp = $true }

  # 认不出来的参数：当场报错，不要静默变成别的意思。
  # （实测：拼错的 `-Nope` 与 `--nope` 都会落进 $Rest，而不是在绑定阶段炸掉 ——
  #   所以两种写法都能用**选定的语言**报错，这是 CI 里那条语言开关检查要的。）
  $i = 0
  while ($i -lt $Rest.Count) {
    $n = Read-BsCommonArg -Argv @($Rest[$i..($Rest.Count - 1)]) -Extra $Extra
    if ($n -eq 0) { Write-Die 'ps.unknownArg' $Rest[$i] }
    $i += $n
  }

  # 语言在这一步已经定好了（点源本文件时就按 -Lang / TSIE_LANG / 区域选过，
  # --lang 又在上面即时重载过），与 .sh 的 bs_args_done 收尾一致。

  # 导给子进程（tools/initramfs.ts、tools/mkfat.ts）：它们按同一张表输出，免得中英混着打。
  # 这里也顺带覆盖掉用户环境里可能已有的 TSIE_LANG —— 以本次选定的语言为准。
  $env:TSIE_LANG = $script:LangSel

  if ($script:BsDoHelp) { Show-BsUsage }   # 打印完 exit 0，不会走回来
}

# 用法文本也是双语的，每个入口各一份（长文本塞进 TSV 的单元格里可读性太差）。
# $BootPath 由入口脚本在点源之前设好（direct / uboot / edk2）。
function Show-BsUsage {
  $f = Join-Path $script:RepoRoot "tools\i18n\usage.$($script:BootPath).$($script:LangSel).txt"
  if (-not (Test-Path -LiteralPath $f)) { Write-Die 'common.noUsage' $f }
  # -NoNewline：与 .sh 的 `cat "$f"` 一致，原样吐出文件内容，不再补一个空行
  Write-Host -NoNewline (Get-Content -Raw -LiteralPath $f -Encoding utf8)
  exit 0
}

# 依赖检查与目录准备。入口解析完参数、确定要干活之后调用一次（与 .sh 的 bs_init 对应）。
function Initialize-BsEnv {
  # 注意：不检查 xz。OpenSBI 是 .tar.xz，但 tar 自己会经 liblzma 解压（Windows 自带的
  # bsdtar 同理），不需要独立的 xz 命令。.sh 侧也一样。
  $script:Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
  if (-not $script:Curl) { $script:Curl = (Get-Command curl -ErrorAction SilentlyContinue).Source }
  if (-not $script:Curl) { Write-Die 'ps.missingCurl' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Die 'common.missingCmd' 'node' }

  # tar 有两个可能来源，能力不同，必须分清：
  #   * Windows 自带的 C:\Windows\System32\tar.exe = bsdtar（libarchive）→ 支持 ar
  #   * Git 的 C:\Git\usr\bin\tar.exe = GNU tar → 不支持 ar（实测）
  # PATH 里通常是 Git 的那个在前，所以只按名字取会拿到不能解 .deb 的那一个。
  $script:Tar = $null
  foreach ($p in @("$env:SystemRoot\System32\tar.exe", 'C:\Windows\System32\tar.exe')) {
    if (Test-Path -LiteralPath $p) { $script:Tar = $p; break }
  }
  if (-not $script:Tar) { $script:Tar = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source }
  if (-not $script:Tar) { $script:Tar = (Get-Command tar -ErrorAction SilentlyContinue).Source }
  if (-not $script:Tar) { Write-Die 'ps.missingTar' }

  $script:SevenZip = $null
  foreach ($p in @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe')) {
    if (Test-Path -LiteralPath $p) { $script:SevenZip = $p; break }
  }
  if (-not $script:SevenZip) { $script:SevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source }
  if (-not $script:SevenZip) { $script:SevenZip = (Get-Command 7za -ErrorAction SilentlyContinue).Source }

  # 谁能解 ar 由实读一次 .deb 判定（见 Test-ArTool），这里只列候选。
  # .sh 侧还有第三档"从第三方仓库借一份静态 bsdtar"，Windows 上没有这一档（见文件头）。
  $script:DebToolCandidates = @($script:Tar) + @($script:SevenZip | Where-Object { $_ })
  # 注意：不因为"没有 7-Zip"就跳过 EDK II —— bsdtar 同样能解 ar，
  # 真正的判定在下载后用实读完成（见 Install-Edk2）。这里只检查候选是否全空。
  if ($script:DoEdk2 -and $script:DebToolCandidates.Count -eq 0) {
    Write-Warn 'edk2.noTarNo7z'
    $script:DoEdk2 = $false
  }

  # 打 initramfs、生成 FAT 盘都复用项目自己的 TS 工具（tsx 是 devDependency）。
  # 提前检查，别等下载完 70 MB 才报缺工具。
  $script:Tsx = Join-Path $script:RepoRoot 'node_modules\.bin\tsx.cmd'
  if (-not (Test-Path -LiteralPath $script:Tsx)) { Write-Die 'common.missingTsx' $script:Tsx }

  New-Item -ItemType Directory -Force -Path $script:OutDir | Out-Null
  New-Item -ItemType Directory -Force -Path $script:FwDir  | Out-Null

  # node/tsx 的输出一律是 UTF-8，而中文 Windows 的控制台默认是 GBK/936 ——
  # 不显式声明的话，tools/initramfs.ts / tools/mkfat.ts 打印的中文会被按 GBK 解码成乱码
  # （实测：`条目数: 521` 变成 `鏉＄洰鏁�: 521`）。这里只改"如何解码子进程输出"，
  # 脚本自己的输出走控制台 Unicode 接口，不受影响。
  # 必须早于第一个子进程：晚一步，那次调用的输出就已经是乱码了。
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
}

# ---------------------------------------------------------------- 下载（重试 + 续传 + 多源）

# 本机网络有三个特点，下载栈必须同时应付：
#   1. 间歇性可达 —— 同一域名前一刻成功、后一刻 21s 超时；必须退避重试。
#   2. 会中途掉速 —— 实测 22 MB 的内核在 45 KB/s 与 5 KB/s 之间摆（差 9 倍），
#      纯重试会从 0 重来，前功尽弃。故用 `-C -` 断点续传。
#   3. 多源快慢不一 —— 故接受多个 URL 候选，逐个试，谁快谁上。

# 权威文件大小：必须跟随重定向取最终响应的 Content-Length。
#
# 这里踩过一个严重坑：早先写成 `curl -I`（不带 -L），拿到的是重定向源站的
# Content-Length —— dl-cdn 返回 15501313（rc 页面大小），而真实文件是 22001665。
# 于是"续传到 14.5 MB"被误判为下载完成，直到解压才炸。
# 静默地把残缺文件当成品交给下一步，是这个脚本最危险的失败模式。
function Get-RemoteSize {
  param([string]$Url)
  $hdrs = & $script:Curl -fsSLI --max-time 30 -4 --noproxy '*' $Url 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $hdrs) { return $null }
  $cl = ($hdrs | Select-String -Pattern '^content-length:\s*(\d+)' | Select-Object -Last 1)
  if (-not $cl) { return $null }
  return [long]$cl.Matches[0].Groups[1].Value
}

# 提前验证归档数据完整（不只是能列目录）。
#
# 关键区别，踩过：`tar -tzf` 只读文件表、不解压数据流，所以残缺文件也能列出。
# apk 是拼接的多个 gzip 流（实测 4 段），截断会切在流中间：
#     列目录通过 / 解压失败 —— 于是残缺文件一路走到解压步骤才炸。
# 这里解压到 $null（丢弃内容、完整读一遍），能真正发现截断。
function Test-Archive {
  param([string]$Path, [string[]]$TarFlags = @())
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  if ((Get-Item -LiteralPath $Path).Length -le 0) { return $false }
  & $script:Tar @TarFlags '-xOf' $Path > $null 2>$null
  return ($LASTEXITCODE -eq 0)
}

# 单个 URL 续传式下载：循环续传直到达到权威大小。成功返回 $true。
function Invoke-FetchOne {
  param([string]$Url, [string]$OutFile)
  $part = "$OutFile.part"
  $partSrc = "$part.src"
  $total = Get-RemoteSize $Url

  # 源一致性：`.part` 可能来自另一个源（上一次运行走的是镜像）。
  # 不同源的字节流不能拼接 —— 曾因此产出"大小对得上但内容损坏"的文件。
  # 换源就从 0 重来（宁可慢，不可错）。
  if ((Test-Path $part) -and (Get-Item $part).Length -gt 0) {
    $prev = if (Test-Path $partSrc) { (Get-Content -Raw $partSrc).Trim() } else { '' }
    if ($prev -ne $Url) {
      Write-Warn 'fetch.crossSource' -Pad 4
      Remove-Item -Force $part, $partSrc -ErrorAction SilentlyContinue
    }
  }
  Set-Content -Path $partSrc -Value $Url -NoNewline

  if ($total) { Write-Log 'fetch.size' $total -Pad 4 }
  else { Write-Warn 'fetch.noSize' -Pad 4 }

  # 次数按体积给：Alpine 的内核 22 MB，10 次绰绰有余；Debian 的整盘镜像 312 MB，
  # 这条链路一次尝试只能推进几十 MB（实测 20-90 KB/s，还会被服务端掐断），10 次不够，
  # 会在离终点不远的地方放弃。续传本身是安全的，所以大方一点，代价只是失败时多等一会儿。
  $tries = 10
  if ($total -and $total -gt 67108864) { $tries = 40 }

  for ($i = 1; $i -le $tries; $i++) {
    # -C - 断点续传：本机网络会在 45 KB/s 与 5 KB/s 之间摆，纯重试会从 0 重来。
    & $script:Curl -fsSL -C - --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 `
      -4 --noproxy '*' -o $part $Url 2>$null
    if ((Test-Path $part) -and (Get-Item $part).Length -gt 0) {
      $have = (Get-Item $part).Length
      if (-not $total) { Move-Item -Force $part $OutFile; Remove-Item -Force $partSrc -EA SilentlyContinue; return $true }
      if ($have -eq $total) { Move-Item -Force $part $OutFile; Remove-Item -Force $partSrc -EA SilentlyContinue; return $true }
      if ($have -gt $total) {
        # 超出声明大小 = 拼接污染或服务端变了；重下而不是硬用
        Write-Warn 'fetch.oversize' $have, $total -Pad 4
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        continue
      }
      $pct = '{0:N0}' -f ($have * 100 / $total)
      Write-Warn 'fetch.progress' $have, $total, $pct -Pad 4
      Start-Sleep -Seconds ([Math]::Min($i * 2, 15))
      continue
    }
    Write-Warn 'fetch.retry' $i, ($i * 3) -Pad 4
    Start-Sleep -Seconds ($i * 3)
  }
  return $false
}

# 列目录 / 取小文件：也要重试。
# （教训：原先只有下载带重试，列目录是单次尝试 —— 网络一抽风就直接放弃整个环节。）
function Get-RemoteText {
  param([string]$Url)
  for ($i = 1; $i -le 5; $i++) {
    $out = & $script:Curl -fsSL --max-time 40 --connect-timeout 20 -4 --noproxy '*' $Url 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ($out -join "`n") }
    Start-Sleep -Seconds ($i * 3)
  }
  return $null
}

# 多源下载：依次尝试候选 URL，全部失败才抛。带可选取 sha256 校验。
#   Invoke-Fetch -OutFile <文件> [-Sha256 <校验值>] -Url <url>[,<备用url>...]
# 与 .sh 的 fetch <输出文件> <校验sha256|""> <url> [备用url...] 一一对应。
# 失败即 throw：调用处 catch 后用自己那句话报错（与 .sh 的 `|| die "$(msg …)"` 一致）。
function Invoke-Fetch {
  param(
    [Parameter(Mandatory)][string]$OutFile,
    [string]$Sha256,
    [Parameter(Mandatory)][string[]]$Url
  )
  if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) {
    if (-not $Sha256) { Write-Log 'fetch.exists' (Split-Path -Leaf $OutFile); return }
    $got = (Get-FileHash -Algorithm SHA256 $OutFile).Hash.ToLower()
    if ($got -eq $Sha256.ToLower()) { Write-Log 'fetch.existsVerified' (Split-Path -Leaf $OutFile); return }
    Write-Warn 'fetch.existsBad' (Split-Path -Leaf $OutFile)
    Remove-Item -Force $OutFile
  }
  if (Test-Path "$OutFile.part") { Write-Log 'fetch.hasPartial' -Pad 2 }

  $badHash = $null
  foreach ($u in $Url) {
    Write-Log 'fetch.source' (@($u -split '/')[2]) -Pad 2
    if (Invoke-FetchOne -Url $u -OutFile $OutFile) {
      if ($Sha256) {
        $got = (Get-FileHash -Algorithm SHA256 $OutFile).Hash.ToLower()
        if ($got -ne $Sha256.ToLower()) {
          Write-Warn 'fetch.shaMismatch' $Sha256, $got -Pad 2
          $badHash = @($Sha256, $got)
          Remove-Item -Force $OutFile -ErrorAction SilentlyContinue
          continue
        }
        Write-Log 'fetch.verified' (Split-Path -Leaf $OutFile) -Pad 2
      }
      return
    }
    Write-Warn 'fetch.sourceFailed' (@($u -split '/')[2]) -Pad 2
  }
  Remove-Item -Force "$OutFile.part" -ErrorAction SilentlyContinue
  # 全部源都失败。如果失败原因是校验不符，报得更具体一点 —— .sh 侧这里只会报调用方的
  # 泛化文案（"minirootfs 下载失败"），看不出其实是校验没过。
  if ($badHash) { throw (Msg 'fetch.shaMismatchDie' (Split-Path -Leaf $OutFile), $badHash[0], $badHash[1]) }
  throw (Msg 'fetch.failed' $Url[0])
}

# ---------------------------------------------------- GitHub 直连探测 / 镜像选择

$script:GithubProxy = $null
$script:OpensbiProbeUrl = 'https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz'

# 直连探测：只看能否真取到字节。
# HEAD 能通不代表能下载：本机 github.com 一直答得好好的，302 之后的
# objects.githubusercontent.com 才是真正超时的那个。所以这里取前 1 KiB 试读。
function Test-UrlBytes {
  param([string]$Url)
  # `-o NUL`（Windows 空设备），不能写 `-o $null`：PowerShell 传给原生命令的
  # $null 不会变成"丢弃" —— curl 会把 1 KiB 响应体照样吐到 stdout。
  & $script:Curl -fsSL -o NUL --max-time 25 -4 --noproxy '*' -r 0-1023 $Url 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Test-GithubRelease { return (Test-UrlBytes $script:OpensbiProbeUrl) }

# 镜像选择：-NoMirror 直接拒绝；-Mirror 视为已授权；否则问一次（问过就不再问）。
function Select-Mirror {
  param([string]$Url = '')
  if ($script:MirrorMode -eq 'no') { return $false }
  $u = if ($Url) { $Url } else { $script:OpensbiProbeUrl }
  if ($script:MirrorMode -eq 'ask' -and -not $script:MirrorOk) {
    Write-Host ''
    Write-Warn 'mirror.directDown'
    Write-Warn 'mirror.trustNote'
    $ans = Read-Host (Msg 'mirror.ask')
    if ($ans -notmatch '^(y|Y|yes|YES)$') { return $false }
    $script:MirrorOk = $true
  }
  Write-Log 'mirror.probing'
  $best = $null; $bestSpeed = 0
  foreach ($name in @('v4', 'v6')) {
    # `-o NUL` 让 stdout 只剩 -w 打出的那个数字（实测：1 行）。
    # 解析不用 $Matches —— 之前那句 `[double]($sp -replace '[^\d.]','')`
    # 在 `-o $null` 把 1 MiB 二进制响应体也捕获进来时，会把整坨数字拼成一个
    # 无法转换的数组，在 $ErrorActionPreference='Stop' 下整个脚本直接崩。
    $sp = 0.0
    $raw = & $script:Curl -fsSL -o NUL --max-time 30 -4 --noproxy '*' -r 0-1048575 `
      -w '%{speed_download}' "https://$name.gh-proxy.org/$u" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $last = [string](@($raw)[-1])
      $tok = @($last -split '[^\d.]+' | Where-Object { $_ -ne '' })
      if ($tok.Count -gt 0) { $sp = [double]$tok[-1] }
    }
    Write-Host ("    {0,-4} {1} B/s" -f $name, $sp)
    if ($sp -gt $bestSpeed) { $bestSpeed = $sp; $best = $name }
  }
  if (-not $best) { return $false }
  $script:GithubProxy = "https://$best.gh-proxy.org/"
  Write-Log 'mirror.chosen' "$best.gh-proxy.org", ([int]$bestSpeed)
  return $true
}

# ------------------------------------------------- ②' Debian 13 磁盘镜像（整盘）
#
# 与 .sh 的 bootstrap_debian 一一对应：素材是官方 generic 云镜像的整块 GPT 盘
# （p1 = rootfs(ext4)、p15 = ESP(FAT16)，ESP 上是 Debian 自己的 GRUB）。详细理由见
# tools/lib/bootstrap-common.sh 同名段落 —— 核心是"宿主侧不读 ext4"，内核版本、
# PARTUUID、initrd 文件名全交给镜像自带的 grub.cfg。
function Install-Debian {
  $raw = $script:DebianImagePath

  if ($raw) {
    if (-not (Test-Path -LiteralPath $raw)) { Write-Die 'debian.imageMissing' $raw }
    Write-Log 'debian.usingLocal' $raw -Pad 2
    $script:DebianRaw = $raw.Replace('\', '/')
  } else {
    $tar = Join-Path $script:OutDir $script:DebianTar
    if ((Test-Path -LiteralPath $tar) -and (Test-Archive -Path $tar -TarFlags @('-J'))) {
      Write-Log 'debian.tarExists' $script:DebianTar -Pad 2
    } else {
      Write-Log 'debian.downloading' $script:DebianTar -Pad 2
      try { Invoke-Fetch -OutFile $tar -Url "$script:DebianBase/$script:DebianTar" }
      catch { Write-Die 'debian.downloadFailed' }
      if (-not (Test-Archive -Path $tar -TarFlags @('-J'))) { Write-Die 'debian.badArchive' }
    }

    Write-Log 'debian.extracting' -Pad 2
    & $script:Tar -xJf $tar -C $script:OutDir
    if ($LASTEXITCODE -ne 0) { Write-Die 'debian.extractFailed' }
    $found = Get-ChildItem -LiteralPath $script:OutDir -Filter 'debian-*.raw' -File |
      Select-Object -First 1
    if (-not $found) { Write-Die 'debian.noRaw' $script:OutDir }
    $raw = $found.FullName
    # 命令是在仓库根跑的，仓库内的产物按相对路径打印（与 Get-BsRelOut 同规则）
    $root = $script:RepoRoot.TrimEnd('\') + '\'
    if ($found.FullName.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $script:DebianRaw = $found.FullName.Substring($root.Length).Replace('\', '/')
    } else {
      $script:DebianRaw = $found.FullName.Replace('\', '/')
    }
  }

  # 两道体检：大小与 GPT 签名（下载截断是真实发生过的失败模式，见 .sh 侧注释）
  $sz = (Get-Item -LiteralPath $raw).Length
  if ($sz -lt 1073741824) { Write-Die 'debian.tooSmall' $raw, $sz }
  $fs = [System.IO.File]::OpenRead($raw)
  try {
    $fs.Seek(512, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buf = New-Object byte[] 8
    $fs.Read($buf, 0, 8) | Out-Null
  } finally { $fs.Dispose() }
  if ([System.Text.Encoding]::ASCII.GetString($buf) -ne 'EFI PART') { Write-Die 'debian.noGpt' $raw }
  Write-Log 'debian.imageOk' $raw, ('{0:N1}' -f ($sz / 1GB)) -Pad 2
}

# ------------------------------------------------- EDK II / U-Boot 共用的 .deb 拆包
#
# 注意 .deb 是 ar 归档（魔数 `!<arch>`），不是 tar 也不是 zip。本机没有 ar/dpkg-deb。
# 关键事实（实测，别再凭印象）：
#   * Git Bash 的 `tar` 是 GNU tar 1.35 → 不支持 ar，用它解 .deb 必报错。
#   * Windows 自带的 bsdtar（libarchive）支持 ar，且能一路穿透内层 data.tar.xz。
#     它在 PATH 里被 Git 的 tar 遮蔽（同名 tar.exe），必须按绝对路径调用。
#   * 7-Zip 也能做；但内层是 zstd 时只有 bsdtar 行（libarchive 带 zstd）。
#
# .sh 侧有三档策略（①系统 bsdtar ②系统 7-Zip ③借静态 bsdtar），
# PowerShell 侧只有①② —— 见文件头"与 .sh 侧故意不同的地方"。
# 谁能用一律由实读一次 .deb 判定，不看名字（PATH 里有两个同名 tar.exe）。
$script:ArTool = $null
$script:DebToolIs7z = $false

# 用真实的 .deb 试读，并且要求列出 data.tar 成员 —— 这才证明它真懂 ar。
# GNU tar 会在这里失败（".deb 不像 tar 归档"），正是我们要区分掉的。
# 语法不同，不能用同一套旗标探测：tar/bsdtar 是 `-tf`，7-Zip 是 `l`。
# 早先用 `-tf` 去测 7z，把它误判成"读不了 ar"（实测踩过）。
function Test-ArTool {
  param([string]$Bin, [string]$Deb)
  if (-not $Bin) { return $false }
  if (-not (Test-Path -LiteralPath $Bin)) { return $false }
  $is7z = (Split-Path -Leaf $Bin) -match '^7z(a)?(\.exe)?$'
  $out = if ($is7z) { & $Bin l $Deb 2>$null } else { & $Bin -tf $Deb 2>$null }
  if ($LASTEXITCODE -ne 0) { return $false }
  if (-not ($out | Select-String -SimpleMatch 'data.tar' -Quiet)) { return $false }
  $script:ArTool = $Bin
  $script:DebToolIs7z = [bool]$is7z
  return $true
}

# 系统里已有的工具（①bsdtar ②7-Zip）。都没有就返回 $false —— .sh 侧这时会去借，
# PowerShell 侧没有那一档。
function Find-LocalArTool {
  param([string]$Deb)
  foreach ($bin in $script:DebToolCandidates) {
    if (Test-ArTool -Bin $bin -Deb $Deb) {
      # 文案用 ar.toolPlain 而不是 .sh 的 ar.toolSystem：后者带"无需下载"的意思，
      # 而这边压根没有下载那一档。
      Write-Log 'ar.toolPlain' (Split-Path -Leaf $script:ArTool) -Pad 2
      return $true
    }
  }
  return $false
}

# .deb 拆包。拆出来的内容留在 $script:DebX 下，调用者取完自己调 Clear-DebUnpack
# （与 .sh 的 DEB_X / deb_cleanup 一致）。
# 返回 $false 只有一种情况：没有任何能解 ar 的工具。其余失败一律 Write-Die 退出。
function Invoke-DebUnpack {
  param([string]$Deb, [string]$Inner)
  $x = Join-Path $script:OutDir '.deb-x'
  if (Test-Path -LiteralPath $x) { Remove-Item -Recurse -Force $x }
  New-Item -ItemType Directory -Force -Path $x | Out-Null

  if (-not (Find-LocalArTool -Deb $Deb)) { return $false }

  # bsdtar 与 7z 的调用语法不同：bsdtar 是 -xf ... -C，7z 是 x -y -o<dir>
  if ($script:DebToolIs7z) {
    Write-Log 'edk2.unpack7z' -Pad 2
    & $script:ArTool x -y "-o$x" $Deb > $null 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.unpackFailed7z' }
  } else {
    Write-Log 'edk2.unpackBsdtar' -Pad 2
    & $script:ArTool -xf $Deb -C $x 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.unpackFailedBsdtar' }
  }

  # 内层可能是 data.tar / data.tar.xz（Debian 上游多用 xz，新包开始用 zstd）
  $data = Get-ChildItem -Path $x -Filter 'data.tar*' | Select-Object -First 1
  if (-not $data) { Write-Die 'edk2.noDataTar' }
  if ($data.Name -match '\.zst$') {
    # zstd 只有 bsdtar（libarchive）认；7-Zip 的主路径处理不了
    if ($script:DebToolIs7z) { Write-Die 'edk2.zstdNeedsBsdtar' }
    Write-Log 'edk2.innerBsdtar' $data.Name -Pad 2
    & $script:ArTool -xf $data.FullName -C $x $Inner 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.innerFailed' $data.Name }
  } else {
    Write-Log 'edk2.inner' $data.Name -Pad 2
    # 先验完整再解：截断的 data.tar 会让 tar 解到一半才失败，那时已经写进去半棵树
    if (-not (Test-Archive -Path $data.FullName)) { Write-Die 'edk2.dataIncomplete' (Split-Path -Leaf $Deb) }
    & $script:Tar -xf $data.FullName -C $x $Inner 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.innerFailed' $data.Name }
  }
  $script:DebX = $x
  return $true
}

function Clear-DebUnpack {
  if ($script:DebX -and (Test-Path -LiteralPath $script:DebX)) { Remove-Item -Recurse -Force $script:DebX }
  $script:DebX = ''
}

# ---------------------------------------------------------------- ① OpenSBI 固件

function Install-OpenSbi {
  $rel = 'riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz'
  $url = "https://github.com/$rel"
  $tarball = Join-Path $script:FwDir 'opensbi-1.9-rv-bin.tar.xz'
  $fwJump  = Join-Path $script:FwDir 'opensbi-1.9-rv-bin\share\opensbi\lp64\generic\firmware\fw_jump.bin'

  if (Test-Path -LiteralPath $fwJump) {
    Write-Log 'opensbi.exists' 'firmware\opensbi-1.9-rv-bin\...\fw_jump.bin' -Pad 2
    return
  }

  # 直连优先；失败再走镜像（镜像需授权）。授权被拒就只能报错让人手动放文件。
  $ok = $false
  if (Test-GithubRelease) {
    Write-Log 'opensbi.directOk' -Pad 2
    try { Invoke-Fetch -OutFile $tarball -Url $url; $ok = $true } catch { $ok = $false }
  } else {
    Write-Warn 'opensbi.directDown' -Pad 2
  }
  if (-not $ok -and (Select-Mirror)) {
    try { Invoke-Fetch -OutFile $tarball -Url "$script:GithubProxy$url"; $ok = $true } catch { $ok = $false }
  }
  if (-not $ok) {
    Write-Warn 'opensbi.cantDownload' -Pad 2
    Write-Warn 'opensbi.manualHint' $tarball, $url -Pad 2
    Write-Warn 'opensbi.manualHint2' "$script:FwDir\" -Pad 2
    Write-Die 'opensbi.failed'
  }

  Write-Log 'opensbi.extracting' -Pad 2
  # 先验完整再解压：截断的 .tar.xz 会让 tar 解到一半才炸，那时 firmware/ 里已经有半棵树
  if (-not (Test-Archive -Path $tarball)) { Write-Die 'opensbi.badArchive' }
  & $script:Tar -xf $tarball -C $script:FwDir
  if ($LASTEXITCODE -ne 0) { Write-Die 'opensbi.extractFailed' }
  if (-not (Test-Path -LiteralPath $fwJump)) { Write-Die 'opensbi.noFwJump' }
  Write-OkRaw "fw_jump.bin -> $fwJump"
}

# --------------------------------------------------------------- ② EDK II 固件

function Install-Edk2 {
  if (-not $script:DoEdk2) { Write-Log 'edk2.skippedPs' -Pad 2; return }

  # Debian 的 qemu-efi-riscv64 包里就是 32 MiB 的 CODE + VARS，尺寸天然合规。
  # 版本号动态取（池目录里可能有多个版本，取最新的）。
  $pool = 'https://deb.debian.org/debian/pool/main/e/edk2/'
  $listing = Get-RemoteText $pool
  $debName = $null
  if ($listing) {
    $debName = ($listing | Select-String -Pattern 'qemu-efi-riscv64_[^"]*_all\.deb' -AllMatches).Matches.Value |
               Sort-Object -Unique | Select-Object -Last 1
  }
  if (-not $debName) { Write-Warn 'edk2.noListing' -Pad 2; return }
  Write-Log 'edk2.latest' $debName -Pad 2

  $deb = Join-Path $script:OutDir $debName
  try { Invoke-Fetch -OutFile $deb -Url "$pool$debName" } catch { Write-Warn 'edk2.downloadFailed' -Pad 2; return }

  if (-not (Invoke-DebUnpack -Deb $deb -Inner './usr/share/qemu-efi-riscv64/')) {
    Write-Warn 'edk2.noToolPs' -Pad 2
    Write-Warn 'edk2.gnuTarNote' -Pad 2
    return
  }

  $src = Join-Path $script:DebX 'usr\share\qemu-efi-riscv64'
  foreach ($f in @('RISCV_VIRT_CODE.fd', 'RISCV_VIRT_VARS.fd')) {
    $s = Join-Path $src $f
    if (-not (Test-Path -LiteralPath $s)) { Write-Die 'edk2.notFound' $f }
    $d = Join-Path $script:OutDir $f
    Copy-Item -Force $s $d
    $sz = (Get-Item -LiteralPath $d).Length
    # 文件名 + 尺寸没有语言成分，不进文案表（.sh 侧同样是拼出来的）
    Write-OkRaw ("{0}  ({1} B = {2} MiB)" -f $f, $sz, ('{0:N2}' -f ($sz / 1MB)))
    # EDK II 强制要求两块各 32 MiB，尺寸不对就别让用户拿到一个会在固件里报错的产物
    if ($sz -ne 33554432) { Write-Warn 'edk2.badSize' -Pad 2 }
  }
  Clear-DebUnpack

  # 固件卷里压着 LZMA，剥掉后引导快约 5 倍（实测 23 分钟 → 2.5 分钟）。剥出来的那份
  # 另存一个名字，原始产物留着（想对照或想自己试都行）。
  if ($script:DoStrip) {
    Remove-Edk2Lzma (Join-Path $script:OutDir 'RISCV_VIRT_CODE.fd') (Join-Path $script:OutDir 'RISCV_VIRT_CODE.nocomp.fd')
    $script:Edk2CodeFile = 'RISCV_VIRT_CODE.nocomp.fd'
  }

  New-Edk2Tramp (Join-Path $script:OutDir 'edk2-tramp.bin')
}

# EDK II 要一段 8 字节跳板才跑得起来，别删（删了只会看到 OpenSBI banner，之后一片安静）：
#   * CLI 把 --kernel 装在 0x80200000 —— 那正是 OpenSBI fw_jump 的落点；
#   * 而 EDK II 固件在 pflash 0x20000000（真实 virt 机器也是这个布局，见机器的 VIRT_FLASH）；
#   * 两者之间差一次跳转，于是给 0x80200000 放两条指令把它接过去：
#       lui t0, 0x20000    ; 机器码 200002b7
#       jr  t0             ; 机器码 00028067（= jalr x0, 0(t0)）
# 为什么不让模拟器直接跳 flash：fw_jump 的落点是编译进 OpenSBI 的，改不了；
# 模拟器也不该为某一份固件特判一个地址。
function New-Edk2Tramp {   # New-Edk2Tramp <输出文件>
  param([string]$OutFile)
  [System.IO.File]::WriteAllBytes($OutFile, [byte[]]@(0xb7, 0x02, 0x00, 0x20, 0x67, 0x80, 0x02, 0x00))
  Write-Log 'edk2.tramp' (Split-Path -Leaf $OutFile), (Get-Item -LiteralPath $OutFile).Length -Pad 2
}

# EDK II 的固件卷里压了一层 LZMA：原样交给模拟器，固件自己解压要十分钟（实测），
# 而这一步纯属白烧指令。tools/uncompress-fv.ts 在盘上先把它剥掉，引导快约 5 倍。
# 剥过的文件叫 RISCV_VIRT_CODE.nocomp.fd，打印引导命令时用的就是它。
function Remove-Edk2Lzma {   # Remove-Edk2Lzma <原始.fd> <输出.fd>
  param([string]$InFile, [string]$OutFile)
  Write-Log 'edk2.stripping' -Pad 2
  & $script:Tsx (Join-Path $script:RepoRoot 'tools\uncompress-fv.ts') $InFile $OutFile
  if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.stripFailed' }
}

# ------------------------------------------------------------ ③ Alpine 内核 + initramfs

function Install-Alpine {
  $main = "https://dl-cdn.alpinelinux.org/alpine/$($script:AlpineBranch)/main/$($script:Arch)/"
  $rel  = "https://dl-cdn.alpinelinux.org/alpine/$($script:AlpineBranch)/releases/$($script:Arch)/"
  $mirrorMain = "$($script:AlpineMirror)/$($script:AlpineBranch)/main/$($script:Arch)"
  $mirrorRel  = "$($script:AlpineMirror)/$($script:AlpineBranch)/releases/$($script:Arch)"
  Write-Log 'alpine.branch' $script:AlpineBranch -Pad 2

  # --- 内核：从目录列表动态取最新 linux-lts（不硬编码版本）
  $listing = Get-RemoteText $main
  $apk = $null
  if ($listing) {
    $apk = ($listing | Select-String -Pattern 'linux-lts-[0-9][^"]*\.apk' -AllMatches).Matches.Value |
           Sort-Object -Unique | Select-Object -Last 1
  }
  if (-not $apk) { Write-Die 'alpine.noKernelList' }
  Write-Log 'alpine.kernel' $apk -Pad 2

  $apkPath = Join-Path $script:OutDir $apk
  try { Invoke-Fetch -OutFile $apkPath -Url @("$main$apk", "$mirrorMain/$apk") }
  catch { Write-Die 'alpine.kernelFailedPs' }

  Write-Log 'alpine.extractImage' -Pad 2
  $t = Join-Path $script:OutDir '.apk-x'
  if (Test-Path -LiteralPath $t) { Remove-Item -Recurse -Force $t }
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  if (-not (Test-Archive -Path $apkPath -TarFlags @('-z'))) { Write-Die 'alpine.badApk' $apkPath }

  # 只解 `boot/`，不要整包解压。apk 里有个指向 `/boot/vmlinuz-lts` 的相对符号链接
  # （lib/modules/*/vmlinuz），Windows 上建不了，会让 tar 以非 0 退出并带上
  # "Cannot create symlink" —— 整个归档其实完好，只是那一条无关链接失败。
  # 只取需要的成员既避开这个坑，也少解 20 MB 的模块树。
  & $script:Tar -xzf $apkPath -C $t 'boot/' 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Die 'alpine.apkUnpackFailed' }
  $vmz = Join-Path $t 'boot\vmlinuz-lts'
  if (-not (Test-Path -LiteralPath $vmz)) {
    $found = Get-ChildItem -Path $t -Recurse -Filter 'vmlinuz*' | Select-Object -First 1
    if ($found) { $vmz = $found.FullName }
  }
  if (-not (Test-Path -LiteralPath $vmz)) { Write-Die 'alpine.noVmlinuz' }

  # gzip -dc 等价：读 gzip 流解到输出（Git Bash 的 gzip 在 Windows 上不保证有）
  $imgPath = Join-Path $script:OutDir 'Image'
  $in  = [System.IO.File]::OpenRead($vmz)
  try {
    $gz  = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [System.IO.File]::Create($imgPath)
      try { $gz.CopyTo($out) } finally { $out.Dispose() }
    } finally { $gz.Dispose() }
  } finally { $in.Dispose() }
  Remove-Item -Recurse -Force $t

  $isz = (Get-Item -LiteralPath $imgPath).Length
  if ($isz -lt 1000000) { Write-Die 'alpine.imageTooSmall' $isz }
  Write-Ok 'alpine.imageOk' $isz, ('{0:N1}' -f ($isz / 1MB))

  # --- initramfs：从 latest-releases.yaml 取 minirootfs（含官方 sha256 可校验）
  Write-Log 'alpine.readingYaml' -Pad 2
  $yaml = Join-Path $script:OutDir 'latest-releases.yaml'
  try { Invoke-Fetch -OutFile $yaml -Url @("${rel}latest-releases.yaml", "$mirrorRel/latest-releases.yaml") }
  catch { Write-Die 'alpine.noYaml' }

  $text  = Get-Content -Raw $yaml
  $rootfs = ([regex]::Matches($text, 'alpine-minirootfs-[0-9][^"\s]*riscv64\.tar\.gz') |
             ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -Last 1)
  if (-not $rootfs) { Write-Die 'alpine.noRootfsEntry' }

  # 取该条目所在块里的 sha256（file: 与 sha256: 相邻）
  $sha = $null
  $block = [regex]::Match($text, "(?s)file:\s*$([regex]::Escape($rootfs)).*?sha256:\s*([0-9a-f]{64})")
  if ($block.Success) { $sha = $block.Groups[1].Value }
  if (-not $sha) { Write-Warn 'alpine.noSha' -Pad 2 }
  Write-LogRaw "minirootfs: $rootfs" -Pad 2

  $rfs = Join-Path $script:OutDir $rootfs
  try { Invoke-Fetch -OutFile $rfs -Sha256 $sha -Url @("${rel}${rootfs}", "$mirrorRel/$rootfs") }
  catch { Write-Die 'alpine.rootfsFailed' }

  Write-Log 'alpine.packing' -Pad 2
  if (-not (Test-Archive -Path $rfs -TarFlags @('-z'))) { Write-Die 'alpine.rootfsIncomplete' }

  # 这一步不经过磁盘：initramfs.ts 直接从 tar 头里读 mode 与 linkname，
  # 在内存里组装 cpio。原因见该文件头部的长注释 —— 一旦落盘，Windows 上符号链接
  # 建不出来（要提权）、执行位也存不住（内核 execve 报 EACCES，起不到 init）。
  $cpio = Join-Path $script:OutDir 'initramfs.cpio.gz'
  & $script:Tsx (Join-Path $script:RepoRoot 'tools\initramfs.ts') alpine $rfs $cpio
  if ($LASTEXITCODE -ne 0) { Write-Die 'alpine.packFailed' }

  $csz = (Get-Item -LiteralPath $cpio).Length
  if ($csz -lt 500000) { Write-Die 'alpine.tooSmall' $csz }
  Write-OkRaw "initramfs.cpio.gz  ($csz B)"

  # 再出一份未压缩的。内核在解 initramfs 前会先认压缩格式，认不出就按裸 cpio 直接用 ——
  # 于是"在模拟器里跑一遍 inflate"这段指令整个省掉（实测数字见文件末尾的引导命令）。
  # 代价只是文件大一倍，而 tmp/ 本来就不入库。
  #
  # 是"推荐但可选"，所以问一句。无人值守时 Read-Host 拿到 EOF 会返回空串（等同 no），
  # 不会挂住；想预先表态用 -Decompress / -NoDecompress。
  $wantCpio = $false
  if ($script:DecompressMode -eq 'yes') { $wantCpio = $true }
  elseif ($script:DecompressMode -eq 'no') { $wantCpio = $false }
  else {
    Write-Host ''
    Write-Log 'alpine.decompressNote' -Pad 2
    $ans = Read-Host (Msg 'alpine.decompressAsk')
    if ($ans -match '^(y|Y|yes|YES)$') { $wantCpio = $true }
  }

  if ($wantCpio) {
    $cpioRaw = Join-Path $script:OutDir 'initramfs.cpio'
    & $script:Tsx (Join-Path $script:RepoRoot 'tools\initramfs.ts') decompress $cpio $cpioRaw
    if ($LASTEXITCODE -ne 0) { Write-Die 'alpine.decompressFailed' }
    Write-Ok 'alpine.decompressed' (Get-Item -LiteralPath $cpioRaw).Length
    $script:InitrdFile = 'initramfs.cpio'
  } else {
    Write-Log 'alpine.decompressSkipped' -Pad 2
  }
}

# ------------------------------------------------------------- ④ U-Boot 固件
#
# U-Boot 作为 S 模式负载跑在 OpenSBI 之上，自己去 virtio 盘上把内核与 initramfs
# 读进内存、再 booti 起来。Debian 的 u-boot-qemu 里有两份 ELF，别拿错：
#   qemu-riscv64/uboot.elf        给 QEMU 当 -bios 直接跑（按裸机布局链接）
#   qemu-riscv64_smode/uboot.elf  由 SBI 固件引导（我们要这个）
function Install-Uboot {
  $pool = 'https://deb.debian.org/debian/pool/main/u/u-boot/'
  $elf = Join-Path $script:OutDir 'uboot.elf'
  if (Test-Path -LiteralPath $elf) { Write-Log 'uboot.exists' -Pad 2; return }

  $listing = Get-RemoteText $pool
  $debName = $null
  if ($listing) {
    $debName = ($listing | Select-String -Pattern 'u-boot-qemu_[^"]*_all\.deb' -AllMatches).Matches.Value |
               Sort-Object -Unique | Select-Object -Last 1
  }
  if (-not $debName) { Write-Die 'uboot.noListing' }
  Write-Log 'uboot.latest' $debName -Pad 2

  $deb = Join-Path $script:OutDir $debName
  try { Invoke-Fetch -OutFile $deb -Url "$pool$debName" } catch { Write-Die 'uboot.downloadFailed' }

  if (-not (Invoke-DebUnpack -Deb $deb -Inner './usr/lib/u-boot/qemu-riscv64_smode/')) { Write-Die 'uboot.noTool' }
  $src = Join-Path $script:DebX 'usr\lib\u-boot\qemu-riscv64_smode\uboot.elf'
  if (-not (Test-Path -LiteralPath $src)) { Write-Die 'uboot.notFound' }
  Copy-Item -Force $src $elf
  Clear-DebUnpack
  Write-Log 'uboot.extracted' ([System.IO.Path]::GetFileNameWithoutExtension($debName)), (Get-Item -LiteralPath $elf).Length -Pad 2
}

# ------------------------------------------------- 引导盘（FAT16，tools/mkfat.ts）
#
# U-Boot 的 fatload 与 UEFI 的 ESP 都按**文件**读盘，不认裸块号，所以盘上得有文件系统。
# 镜像由 tools/mkfat.ts 手写生成（为什么不借 mtools / mkfs.vfat 见那个文件的注释），
# 这里只负责把产物塞进去、再把"盘上叫什么"告诉调用者。
$script:FatPartFat16 = '0x0C'
$script:FatPartEsp   = '0xEF'

# New-FatDisk <输出.img> <分区类型> <镜像内路径=宿主文件...>
function New-FatDisk {
  param([string]$Img, [string]$PartType, [string[]]$Members)
  # tsx 是 devDependency；mkfat.ts 自己按 TSIE_LANG 输出，所以这里不会再冒出中文/英文混杂
  & $script:Tsx (Join-Path $script:RepoRoot 'tools\mkfat.ts') $Img "--part-type=$PartType" @Members
  if ($LASTEXITCODE -ne 0) { Write-Die 'fat.failed' }
}

# U-Boot 的命令脚本：扫盘 → 逐个 fatload 到内存 → booti。
# 盘上就两个文件、名字固定，所以命令也固定（不现场拼字符串，便于对着 README 读）。
#
# ⚠️ booti 的第三个参数（设备树）不能省：这个构建的 qemu-riscv64_smode U-Boot 自己的
# gd->fdt_blob 在交接时会变成 0（实测 "Working FDT set to 0" → "Device tree not found"），
# 必须显式把 `$fdtcontroladdr`（U-Boot 启动时记下的控制 FDT 地址）传进去。
function New-UbootCmdScript {
  param([string]$OutFile)
  # 注意 PowerShell 的 `$` 转义：`${kernel_addr_r}` 在双引号里会被当成 PowerShell 变量
  # （展开成空串），所以要么用单引号、要么加反引号。下面那行两个都要用：
  # 反引号保住 ${ramdisk_addr_r}，$() 插进本次实际产出的 initramfs 文件名。
  $lines = @(
    'virtio scan'
    'part list virtio 0'
    'fatls virtio 0:1'
    'fatload virtio 0:1 ${kernel_addr_r} Image'
    "fatload virtio 0:1 `${ramdisk_addr_r} $($script:InitrdFile)"
    'setenv bootargs console=ttyS0 rdinit=/init earlycon=sbi'
    'booti ${kernel_addr_r} ${ramdisk_addr_r}:${filesize} ${fdtcontroladdr}'
  )
  # 换行统一成 LF：U-Boot 把这些当命令逐个吃，CR 会变成多余的按键
  Set-Content -LiteralPath $OutFile -Value (($lines -join "`n") + "`n") -NoNewline -Encoding ascii
}

# Debian 那条路的命令脚本：盘上不是我们放的 Image/initramfs，而是它自己的 GPT 盘，
# 内核、initrd、root= 全在 ESP 上那个 GRUB 的 grub.cfg 里。`bootefi bootmgr` 让 U-Boot
# 的 EFI 启动管理器按"可移动介质"规则去枚举 \EFI\BOOT\BOOTRISCV64.EFI，之后 GRUB 接手。
# `part list` 只为把分区表打进日志 —— 这条路出问题时，第一眼要看的就是它。
function New-UbootCmdScriptDebian {
  param([string]$OutFile)
  $lines = @(
    'virtio scan'
    'part list virtio 0'
    'bootefi bootmgr'
  )
  Set-Content -LiteralPath $OutFile -Value (($lines -join "`n") + "`n") -NoNewline -Encoding ascii
}

# U-Boot 那条路要的盘：内核 + initramfs + 命令脚本，一次做齐。
function Install-UbootDisk {
  $img = Join-Path $script:OutDir 'uboot-disk.img'
  New-FatDisk -Img $img -PartType $script:FatPartFat16 -Members @(
    "Image=$($script:OutDir)\Image"
    "$($script:InitrdFile)=$($script:OutDir)\$($script:InitrdFile)"
  )
  New-UbootCmdScript (Join-Path $script:OutDir 'uboot-cmd.txt')
  Write-Log 'uboot.diskMade' (Split-Path -Leaf $img), ([int][math]::Floor((Get-Item -LiteralPath $img).Length / 1MB)) -Pad 2
}

# Debian 那条路不用做盘（盘就是镜像本身），但命令脚本要写。
function Install-UbootCmds {
  $cmd = Join-Path $script:OutDir 'uboot-cmd.txt'
  New-UbootCmdScriptDebian $cmd
  Write-Log 'uboot.cmdMade' 'uboot-cmd.txt', (@(Get-Content -LiteralPath $cmd).Count) -Pad 2
}

# EDK II 的 ESP：固件里有 UEFI Shell 与 `initrd` 命令（OvmfPkg/LinuxInitrdDynamicShellCommand），
# 它把文件注册成 Linux initrd 的 device path，内核的 EFI stub 就会去读 —— 于是不需要
# 任何第三方引导器。startup.nsh 是 shell 启动时自动执行的脚本，两条命令就够。
function Install-Esp {
  $esp = Join-Path $script:OutDir 'esp.img'
  $nsh = Join-Path $script:OutDir 'startup.nsh'
  # `\Image` / `\initramfs.cpio` 里的反斜杠是 UEFI Shell 的根目录写法，不是转义；
  # PowerShell 里反斜杠本身就是字面量，不用（也不能）加倍。
  $nshLines = @(
    '@echo -off'
    "initrd \$($script:InitrdFile)"
    '\Image console=ttyS0 rdinit=/init earlycon=sbi'
  )
  Set-Content -LiteralPath $nsh -Value (($nshLines -join "`n") + "`n") -NoNewline -Encoding ascii

  New-FatDisk -Img $esp -PartType $script:FatPartEsp -Members @(
    "startup.nsh=$nsh"
    "Image=$($script:OutDir)\Image"
    "$($script:InitrdFile)=$($script:OutDir)\$($script:InitrdFile)"
  )
  Write-Log 'esp.made' (Split-Path -Leaf $esp), ([int][math]::Floor((Get-Item -LiteralPath $esp).Length / 1MB)) -Pad 2
}

# ----------------------------------------------------------------------- 主流程

# 三个入口共用的开场与收尾（编号由入口自己排：每条路要的素材不一样）
function Show-BsBanner {
  Write-Log 'common.bannerPs'
  Write-Log 'common.repo' $script:RepoRoot
  Write-Log 'common.outdir' $script:OutDir
}

function Show-BsArtifacts {
  Write-Host ''
  Write-Log 'common.done'
  Get-ChildItem $script:OutDir -File | Where-Object { $_.Length -gt 0 } |
    Sort-Object Name | ForEach-Object { Write-Host ("  {0,12} B  {1}" -f $_.Length, $_.Name) }
}

# 与 .sh 的 ${OUT_DIR#$REPO_ROOT/} 对应：产物目录落在仓库里时打印成相对路径。
# 分隔符换成正斜杠 —— 这几行是要粘进命令行的（Windows 上两种都认，但与 .sh 侧一致更好读）。
function Get-BsRelOut {
  $root = $script:RepoRoot.TrimEnd('\') + '\'
  if ($script:OutDir.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $script:OutDir.Substring($root.Length).Replace('\', '/')
  }
  return $script:OutDir.Replace('\', '/')
}

function Get-BsFwRel { return 'firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin' }

# initramfs 的解释文字随"这次到底产出了哪一份"变，避免打印一条指向不存在文件的命令
function Get-BsInitrdNote {
  if ($script:InitrdFile -eq 'initramfs.cpio') { return (Msg 'tail.uncompressed') }
  return (Msg 'tail.compressedHint' (Get-BsRelOut))
}

# ① OpenSBI 直接跳转内核：fw_jump 落在 0x80200000，内核就在那儿等它
function Show-TailDirect {
  # 行尾续行符用 PowerShell 的反引号而不是 .sh 的 `\`：这几行是给人**粘进终端**的，
  # 而这里的目标终端是 PowerShell（.sh 侧那份用 `\`，各按各的终端来）。
  Write-Host @"

$(Msg 'tail.title')

  # $(Msg 'tail.alpineCmd')
$(Msg 'tail.earlycon')
$(Get-BsInitrdNote)

  npx tsx src/cli.ts ``
    --bios $(Get-BsFwRel) ``
    --kernel $(Get-BsRelOut)/Image --initrd $(Get-BsRelOut)/$($script:InitrdFile) ``
    --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats

"@
}

# ② U-Boot 拉内核：OpenSBI → U-Boot → 由 U-Boot 自己从 FAT 盘上 fatload + booti
function Show-TailUboot {
  if ($script:DistroSel -eq 'debian') {
    Write-Host @"

$(Msg 'tail.title')

  # $(Msg 'tail.debianUbootCmd')
$(Msg 'tail.debianNote')

  npx tsx src/cli.ts ``
    --bios $(Get-BsFwRel) ``
    --kernel $(Get-BsRelOut)/uboot.elf ``
    --disk $($script:DebianRaw) ``
    --script $(Get-BsRelOut)/uboot-cmd.txt ``
    --timebase 100000000 -n 20000000000 --stats

"@
    return
  }
  Write-Host @"

$(Msg 'tail.title')

  # $(Msg 'tail.ubootCmd')
$(Msg 'tail.ubootNote')

  npx tsx src/cli.ts ``
    --bios $(Get-BsFwRel) ``
    --kernel $(Get-BsRelOut)/uboot.elf ``
    --disk $(Get-BsRelOut)/uboot-disk.img ``
    --script $(Get-BsRelOut)/uboot-cmd.txt -n 3000000000 --stats

"@
}

# ③ EDK II：固件在 flash 里，内核与 initramfs 在 ESP 上。
#
# ⚠️ 必须带 --bios：CLI 要求 --kernel 或 --bios 至少有一个（只有 --flash-* 会被当成
# 参数错误、打印帮助退出 2），而且 EDK II 在 RISC-V 上要用 SBI 的定时器/IPI/复位，
# 少了 OpenSBI 根本走不到 UEFI 引导界面。旧版脚本打印的命令漏了这个开关，是坏的。
function Show-TailEdk2 {
  if ($script:DistroSel -eq 'debian') {
    Write-Host @"

$(Msg 'tail.title')

  # $(Msg 'tail.debianEdk2Cmd')
$(Msg 'tail.debianNote')

  # $(Msg 'tail.edk2')
  npx tsx src/cli.ts ``
    --bios $(Get-BsFwRel) ``
    --kernel $(Get-BsRelOut)/edk2-tramp.bin ``
    --flash-code $(Get-BsRelOut)/$($script:Edk2CodeFile) ``
    --flash-vars $(Get-BsRelOut)/RISCV_VIRT_VARS.fd ``
    --disk $($script:DebianRaw) ``
    --timebase 100000000 -n 20000000000 --stats

"@
    return
  }
  Write-Host @"

$(Msg 'tail.title')

  # $(Msg 'tail.edk2Cmd')
$(Msg 'tail.edk2Note')

  # $(Msg 'tail.edk2')
  npx tsx src/cli.ts ``
    --bios $(Get-BsFwRel) ``
    --kernel $(Get-BsRelOut)/edk2-tramp.bin ``
    --flash-code $(Get-BsRelOut)/$($script:Edk2CodeFile) ``
    --flash-vars $(Get-BsRelOut)/RISCV_VIRT_VARS.fd ``
    --disk $(Get-BsRelOut)/esp.img -n 3000000000 --stats

"@
}
