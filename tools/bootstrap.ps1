# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE

<#
.SYNOPSIS
  一键拉取并拼装 TSIE 的引导素材：OpenSBI 固件 + EDK II (UEFI) 固件 + Alpine 内核/initramfs。

.DESCRIPTION
  tools/bootstrap.sh 的 PowerShell 孪生，面向原生 Windows（pwsh）。行为逐项对齐：

    * 版本号一律动态发现，不硬编码。Alpine 的包更新很快，写死的 URL 会 404
      （README 里那个 linux-lts-6.18.44 在 2026-09-26 就已经是 404）。
    * 产物落在 gitignored 目录（firmware/、tmp/），不得入库：
      GPL-2.0 / 第三方产物，本项目是 Apache-2.0。
    * 下载全部带重试。本机网络对 dl-cdn / deb.debian.org 是间歇性可达的，
      同一域名前一刻成功、后一刻 21 秒超时，不带重试必然随机失败。
    * GitHub release 资产直连不通（github.com 能到，但 302 之后的
      objects.githubusercontent.com 超时），需要镜像。镜像属代理转发，
      脚本会先征求同意（-Mirror 可预先授权）。
    * 下载统一走 curl.exe（Windows 自带的就够），这样与 .sh 版本共用同一套
      旗标语义（--retry / --noproxy / -4），避免 Invoke-WebRequest 的差异。

  cpio 打包复用项目自己的 tools/initramfs.ts（tsx 跑）—— PowerShell 与 Git Bash
  都没有原生 cpio（本机也没有 ar/dpkg-deb），没必要造第三份实现。

  文案与 .sh 共用同一张表 tools/i18n/messages.tsv（key<TAB>中文<TAB>English），
  -Help 打印的是 tools/i18n/usage.ps.<lang>.txt；两者都跟随 -Lang / TSIE_LANG / 系统区域。

.EXAMPLE
  pwsh tools/bootstrap.ps1
  pwsh tools/bootstrap.ps1 -Help                  # 也可以 --help / -h / -?
  pwsh tools/bootstrap.ps1 -Mirror -NoEdk2
  pwsh tools/bootstrap.ps1 -Decompress            # 无人值守时预先同意解压 initramfs
  pwsh tools/bootstrap.ps1 -Alpine v3.24 -Dir tmp/boot-pinned
  pwsh tools/bootstrap.ps1 -Lang en               # 英文输出（默认跟随系统区域）

.NOTES
  需要 PowerShell 7+（`pwsh`，不是 Windows 自带的 `powershell.exe` 5.1）。
  脚本启动时会检测版本：5.1 会打印一段安装提示、等 5 秒后以退出码 1 结束。

  本文件刻意带 UTF-8 BOM，别把它删掉：5.1 按 ANSI/GBK 读无 BOM 的 UTF-8 脚本，
  会直接抛一堆语法错误 —— 那样它连上面那段"请装 7+"的提示都读不到，用户只会看到乱码报错。
  CI 的 hygiene 作业会检查这个 BOM 还在不在。

  依赖（缺失时的后果已注明）：
    必需  curl.exe              Windows 10 1803+ 自带，或装 Git for Windows
    必需  tar.exe               必须是 Windows 自带的那个 bsdtar，不是 Git 的 GNU tar。
                                两者同名但能力不同：本脚本显式取 System32\tar.exe，
                                因为 PATH 里 Git 的 tar.exe 排在前面且不支持 ar。
    必需  node + tsx            打 initramfs 用 tools/initramfs.ts，tsx 是 devDependency
                                （先 npm install）。这一步不经过磁盘：直接从 tar 头里
                                读 mode/linkname 组装 cpio，所以 "Windows 建不了符号链接、
                                存不住执行位" 都不影响它。已不再需要 Python。
    可选  7-Zip                 只有 EDK II 拆 ar 会用到，且仅在 bsdtar 不可用时兜底。
                                两者都没有就自动跳过 EDK II 并警告。
    不需要 xz                   OpenSBI 是 .tar.xz，但 tar/bsdtar 自己经 liblzma 解压。

  注意 .deb 是 ar 归档（魔数 `!<arch>`），不是 tar 也不是 zip。
  Windows 自带的 bsdtar（libarchive）能解 ar 且能穿透内层 data.tar.xz；
  Git 的 GNU tar 不能。EDK II 那一步的拆包工具由实读一次 .deb 判定，不靠猜。

  传 -Dir 时用正斜杠或相对路径：PowerShell 会把双引号里的 `\t`、`\n` 当转义序列，
  写 `-Dir G:\tmp\ps-test` 会静默变成 `G:tmpps-test`（`\t` = 制表符）。
  已知坑：本机 dl-cdn 会重定向且速度在 45 KB/s~5 KB/s 间摆动，故下载走 -C - 断点续传
  并按最终响应的 Content-Length 判完成；`.part` 还记录来源 URL，换源即重下。
#>

# PositionalBinding = $false 是故意的，别去掉。
# 默认情况下没人认领的参数会被当成"第一个位置参数"静默绑给 $Alpine ——
# 实测 `./bootstrap.ps1 --help` 在加上 -Help 之前会变成"Alpine 分支: --help"，
# 然后一路跑到下载失败。拼错的参数应当当场报错，而不是悄悄变成别的意思。
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Help,        # 显示帮助。`-Help` / `-h` / `--help` 三种写法都行
  [switch]$Mirror,      # 预先授权镜像（无人值守）
  [switch]$NoMirror,    # 禁止镜像；OpenSBI 只从本地已有文件取
  [switch]$NoEdk2,      # 跳过 EDK II（省约 70 MB）
  [switch]$Decompress,  # 预先同意解压 initramfs（无人值守）
  [switch]$NoDecompress,# 不要解压，只留 .cpio.gz
  [string]$Alpine = 'latest-stable',  # Alpine 分支（默认 latest-stable 别名）
  [string]$Dir,         # 换输出目录（默认 tmp/boot）
  [string]$Lang,        # 输出语言 zh|en（默认跟随系统区域；也可用 TSIE_LANG）
  # 接住没人认领的位置参数。PowerShell 不认 `--name` 这种写法（只认 `-name`），
  # 所以 `--help` 到不了 -Help 开关上，会原样落进这里（实测；它不是被拆成 `help`）。
  # 两种调用方式的规则还不一样：直接调用脚本（`./bootstrap.ps1 --help`）会报
  # "找不到接受自变量的位置参数"，而 `pwsh -File bootstrap.ps1 --help` 却能过 ——
  # 我第一版只测了后者，于是在用户真实的用法下是坏的。这里接住它，与 .sh 的 `--help` 对齐。
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ---------------------------------------------------------------- 语言 / i18n
#
# 用户可见的文案与 .sh 共用同一张表（单一来源）：tools/i18n/messages.tsv
# （key<TAB>中文<TAB>English）。选 TSV 而不是 JSON 是被 bash 逼的：bash 没有内置
# JSON 解析器，为了这个引 jq 就多一个依赖；而 TSV 三种语言都能零依赖读，
# 成对维护两份内联文案则迟早漂移。
#
# 这一段刻意只用在 PowerShell 5.1 里也合法的语法，并且放在版本守卫**之前** ——
# 守卫自己也要按当前语言说话（本文件带 BOM，5.1 才读得进来）。
$MsgFile = Join-Path $RepoRoot 'tools\i18n\messages.tsv'
$script:MsgTable = @{}
$script:MsgLoaded = $false

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
  if (-not (Test-Path -LiteralPath $MsgFile)) { return }   # 表不在就退回键名，至少不崩
  foreach ($raw in @(Get-Content -LiteralPath $MsgFile -Encoding utf8)) {
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

# 语言来源优先级：-Lang > TSIE_LANG > 系统区域（与 .sh 的 --lang > TSIE_LANG > 区域一致）。
# 显式给错值时报错退出，而不是静默退回中文 —— 否则 `-Lang fr` 看起来"成功了"。
$LangSel = ''
if ($Lang) {
  if (Test-LangValue $Lang) { $LangSel = $Lang.ToLower() }
  else {
    $LangSel = Get-SystemLang; Import-Messages $LangSel
    Write-Host ((Msg 'error.prefix') + ' ' + (Msg 'i18n.badLang' $Lang)) -ForegroundColor Red
    exit 1
  }
} elseif ($env:TSIE_LANG) {
  if (Test-LangValue $env:TSIE_LANG) { $LangSel = $env:TSIE_LANG.ToLower() }
  else {
    $LangSel = Get-SystemLang; Import-Messages $LangSel
    Write-Host ((Msg 'error.prefix') + ' ' + (Msg 'i18n.badLang' $env:TSIE_LANG)) -ForegroundColor Red
    exit 1
  }
} else {
  $LangSel = Get-SystemLang
}
Import-Messages $LangSel

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

# ---------------------------------------------------------------- 版本守卫
#
# 只支持 PowerShell 7+。5.1 在这个脚本依赖的几处行为上都不一样：
#   * `$null` 传给原生命令的语义不同（见下面 curl 的 `-o NUL` 注释）；
#   * 它按 ANSI/GBK 读无 BOM 的 UTF-8 脚本 —— 本文件因此刻意带 UTF-8 BOM：
#     不是为了"支持 5.1"，而是为了让它能读懂这段提示。否则 5.1 会在解析阶段
#     抛出一堆语法错误，用户根本看不到下面这句话。
if ($PSVersionTable.PSVersion.Major -lt 7) {
  # 文案表读不到时（比如只拷了这一个文件）退回内置中文：不能让 5.1 用户什么都看不到。
  if ($script:MsgLoaded) { Write-Host (Msg 'ps.needs7') }
  else {
    Write-Host '本工具不支持PowerShell 5，请参阅https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows 获取PowerShell 7+。然后重试'
  }
  Start-Sleep -Seconds 5
  exit 1
}

# 与 .sh 的 `--lang en` 对齐：PowerShell 不认 `--name`，所以它落在 $Rest 里。
# 必须放在帮助之前 —— 这样 `--lang en --help` 打印的是英文帮助。
if ($Rest.Count -ge 2 -and $Rest[0] -imatch '^(--)?lang$') {
  if (Test-LangValue $Rest[1]) { $LangSel = $Rest[1].ToLower(); Import-Messages $LangSel }
  else { Write-Host ((Msg 'error.prefix') + ' ' + (Msg 'i18n.badLang' $Rest[1])) -ForegroundColor Red; exit 1 }
  $Rest = @($Rest | Select-Object -Skip 2)
}

# 帮助入口。四种写法都要能出帮助：
#   -Help（标准开关）、-h（-Help 的唯一前缀）、-?（PowerShell 内建）、
#   以及 --help / --h。后两种到不了开关上：PowerShell 不认 `--name`，
#   实测直接调用脚本时它们原样落进 $Rest（并不是被拆成 `help`），所以按字面匹配。
# 与 .sh 侧的 `-h|--help` 对齐 —— 打印的是文案目录下的用法文本（跟随语言），
# 而不是 Get-Help 渲染的注释块；注释块是给 Get-Help 和读源码的人看的。
if ($Help -or ($Rest.Count -gt 0 -and $Rest[0] -imatch '^(--)?(help|h|\?|/\?)$')) {
  $usageFile = Join-Path $RepoRoot "tools\i18n\usage.ps.$LangSel.txt"
  if (Test-Path -LiteralPath $usageFile) { Write-Host (Get-Content -Raw -LiteralPath $usageFile -Encoding utf8) }
  else { Get-Help $PSCommandPath -Full }   # 用法文件不在就退回注释式帮助，别什么都不给
  exit 0
}

# 其余没人认领的参数：当场报错，不要静默变成别的意思
if ($Rest.Count -gt 0) {
  Write-Host ((Msg 'error.prefix') + ' ' + (Msg 'ps.unknownArg' ($Rest -join ' '))) -ForegroundColor Red
  exit 1
}

$ErrorActionPreference = 'Stop'

# 导给子进程（tools/initramfs.ts 等）：它们按同一张表输出，免得中英混着打。
# 这里也顺带覆盖掉用户环境里可能已有的 TSIE_LANG —— 以本次选定的语言为准。
$env:TSIE_LANG = $LangSel

# node/tsx 的输出一律是 UTF-8，而中文 Windows 的控制台默认是 GBK/936 ——
# 不显式声明的话，tools/initramfs.ts 打印的中文会被按 GBK 解码成乱码
# （实测：`条目数: 521` 变成 `鏉＄洰鏁�: 521`）。这里只改"如何解码子进程输出"，
# 脚本自己的输出走控制台 Unicode 接口，不受影响。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$OutDir   = if ($Dir) { $Dir } else { Join-Path $RepoRoot 'tmp\boot' }
$FwDir    = Join-Path $RepoRoot 'firmware'
# Alpine 分支：默认 latest-stable 别名 —— 语义正确且不随发行版推进失效。
# （曾想自己算"最高版本号"，既多余又有 bug：v4.0 编码成 4000 会小于 v3.24 的 3024。）
$Arch = 'riscv64'
# 最终推荐用哪一份 initramfs 引导（解压成功则换成 .cpio）；末尾打印的引导命令据此变。
$InitrdFile = 'initramfs.cpio.gz'

# 依赖检查
$Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $Curl) { $Curl = (Get-Command curl -ErrorAction SilentlyContinue).Source }
if (-not $Curl) { Write-Die 'ps.missingCurl' }

# tar 有两个可能来源，能力不同，必须分清：
#   * Windows 自带的 C:\Windows\System32\tar.exe = bsdtar（libarchive）→ 支持 ar
#   * Git 的 C:\Git\usr\bin\tar.exe = GNU tar → 不支持 ar（实测）
# PATH 里通常是 Git 的那个在前，所以只按名字取会拿到不能解 .deb 的那一个。
$Tar = $null
foreach ($p in @("$env:SystemRoot\System32\tar.exe", 'C:\Windows\System32\tar.exe')) {
  if (Test-Path $p) { $Tar = $p; break }
}
if (-not $Tar) { $Tar = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source }
if (-not $Tar) { $Tar = (Get-Command tar -ErrorAction SilentlyContinue).Source }
if (-not $Tar) { Write-Die 'ps.missingTar' }

$SevenZip = $null
foreach ($p in @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe')) {
  if (Test-Path $p) { $SevenZip = $p; break }
}
if (-not $SevenZip) { $SevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source }

# 谁能解 ar 由实读一次 .deb 判定（见 Select-DebTool），这里只列候选。
$DebToolCandidates = @($Tar) + @($SevenZip | Where-Object { $_ })

# 打 initramfs 用 tools/initramfs.ts（tsx 是 devDependency）。
# 与 .sh 一致：不再要求系统装 Python —— 那一步现在直接从 tar 组装 cpio，不落盘。
$Tsx = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'

$DoEdk2 = -not $NoEdk2
# 注意：这里不再因为"没有 7-Zip"就跳过 EDK II —— bsdtar 同样能解 ar，
# 真正的判定在下载后用实读完成（见 Install-Edk2）。这里只检查候选是否全空。
if ($DoEdk2 -and $DebToolCandidates.Count -eq 0) {
  Write-Warn 'edk2.noTarNo7z'
  $DoEdk2 = $false
}
$debToolIs7z = $false

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $FwDir  | Out-Null

# ---------------------------------------------------------------- 下载（带重试）

function Invoke-Fetch {
  param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$OutFile,
    [string]$Sha256
  )
  if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) {
    if (-not $Sha256) { Write-Log 'fetch.exists' (Split-Path -Leaf $OutFile); return }
    $got = (Get-FileHash -Algorithm SHA256 $OutFile).Hash.ToLower()
    if ($got -eq $Sha256.ToLower()) { Write-Log 'fetch.existsVerified' (Split-Path -Leaf $OutFile); return }
    Write-Warn 'fetch.existsBad' (Split-Path -Leaf $OutFile)
  }

  $part = "$OutFile.part"
  $partSrc = "$part.src"

  # 权威大小：必须跟随重定向取最终响应的 Content-Length。
  # （本机 dl-cdn 会把请求跳到另一主机，`curl -I` 不跟随时拿到的是源站的值，会误判。）
  $total = $null
  $hdrs = & $Curl -fsSLI --max-time 30 -4 --noproxy '*' $Url 2>$null
  if ($LASTEXITCODE -eq 0 -and $hdrs) {
    $cl = ($hdrs | Select-String -Pattern '^content-length:\s*(\d+)' | Select-Object -Last 1)
    if ($cl) { $total = [long]$cl.Matches[0].Groups[1].Value }
  }

  # 源一致性：`.part` 可能来自另一个源（上一次走的是镜像）。
  # 不同源的字节流不能拼接 —— 曾因此产出"大小对得上但内容损坏"的文件。换源就从 0 重来。
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

  for ($i = 1; $i -le 10; $i++) {
    # -C - 断点续传：本机网络会在 45 KB/s 与 5 KB/s 之间摆，纯重试会从 0 重来。
    & $Curl -fsSL -C - --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 `
      -4 --noproxy '*' -o $part $Url 2>$null
    if ((Test-Path $part) -and (Get-Item $part).Length -gt 0) {
      $have = (Get-Item $part).Length
      if (-not $total) { Move-Item -Force $part $OutFile; Remove-Item -Force $partSrc -EA SilentlyContinue; break }
      if ($have -eq $total) {
        Move-Item -Force $part $OutFile
        Remove-Item -Force $partSrc -ErrorAction SilentlyContinue
        if ($Sha256) {
          $got = (Get-FileHash -Algorithm SHA256 $OutFile).Hash.ToLower()
          if ($got -ne $Sha256.ToLower()) {
            Remove-Item -Force $OutFile
            Write-Die 'fetch.shaMismatchDie' (Split-Path -Leaf $OutFile), $Sha256, $got
          }
          Write-Ok 'fetch.verified' (Split-Path -Leaf $OutFile)
        }
        return
      }
      if ($have -gt $total) {
        Write-Warn 'fetch.oversize' $have, $total -Pad 4
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        continue
      }
      $pct = '{0:N0}' -f ($have * 100 / $total)
      Write-Warn 'fetch.progress' $have, $total, $pct -Pad 4
      Start-Sleep -Seconds ($i * 2)
      continue
    }
    Write-Warn 'fetch.retry' $i, ($i * 3) -Pad 4
    Start-Sleep -Seconds ($i * 3)
  }
  if (Test-Path $part) { Remove-Item -Force $part }
  throw (Msg 'fetch.failed' $Url)
}

# ---------------------------------------------------- GitHub 直连探测 / 镜像选择

$script:GithubProxy = $null

function Test-GithubRelease {
  $u = 'https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz'
  # `-o NUL`（Windows 空设备），不能写 `-o $null`：PowerShell 传给原生命令的
  # $null 不会变成"丢弃" —— curl 会把 1 KiB 响应体照样吐到 stdout。
  & $Curl -fsSL -o NUL --max-time 25 -4 --noproxy '*' -r 0-1023 $u 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Select-Mirror {
  if ($NoMirror) { return $false }
  $u = 'https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz'
  if (-not $Mirror) {
    Write-Host ''
    Write-Warn 'mirror.directDown'
    Write-Warn 'mirror.trustNote'
    $ans = Read-Host (Msg 'mirror.ask')
    if ($ans -notmatch '^(y|Y|yes|YES)$') { return $false }
  }
  Write-Log 'mirror.probing'
  $best = $null; $bestSpeed = 0
  foreach ($name in @('v4', 'v6')) {
    # `-o NUL` 让 stdout 只剩 -w 打出的那个数字（实测：1 行）。
    # 解析不用 $Matches —— 之前那句 `[double]($sp -replace '[^\d.]','')`
    # 在 `-o $null` 把 1 MiB 二进制响应体也捕获进来时，会把整坨数字拼成一个
    # 无法转换的数组，在 $ErrorActionPreference='Stop' 下整个脚本直接崩。
    $sp = 0.0
    $raw = & $Curl -fsSL -o NUL --max-time 30 -4 --noproxy '*' -r 0-1048575 `
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

# ---------------------------------------------------------------- ① OpenSBI 固件

function Install-OpenSbi {
  Write-Log 'stage.opensbi'
  $rel = 'riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz'
  $url = "https://github.com/$rel"
  $tarball = Join-Path $FwDir 'opensbi-1.9-rv-bin.tar.xz'
  $fwJump  = Join-Path $FwDir 'opensbi-1.9-rv-bin\share\opensbi\lp64\generic\firmware\fw_jump.bin'

  if (Test-Path $fwJump) { Write-Log 'opensbi.exists' 'firmware\opensbi-1.9-rv-bin\...\fw_jump.bin' -Pad 2; return }

  $ok = $false
  if (Test-GithubRelease) {
    Write-Log 'opensbi.directOk' -Pad 2
    try { Invoke-Fetch -Url $url -OutFile $tarball; $ok = $true } catch { $ok = $false }
  } else {
    Write-Warn 'opensbi.directDown' -Pad 2
  }
  if (-not $ok -and (Select-Mirror)) {
    try { Invoke-Fetch -Url "$script:GithubProxy$url" -OutFile $tarball; $ok = $true } catch { $ok = $false }
  }
  if (-not $ok) {
    Write-Warn 'opensbi.cantDownload' -Pad 2
    Write-Warn 'opensbi.manualHint' $tarball, $url -Pad 2
    Write-Warn 'opensbi.manualHint2' "$FwDir\" -Pad 2
    Write-Die 'opensbi.failed'
  }

  Write-Log 'opensbi.extracting' -Pad 2
  & $Tar -xf $tarball -C $FwDir
  if ($LASTEXITCODE -ne 0) { Write-Die 'opensbi.extractFailed' }
  if (-not (Test-Path $fwJump)) { Write-Die 'opensbi.noFwJump' }
  Write-OkRaw "fw_jump.bin -> $fwJump"
}

# --------------------------------------------------------------- ② EDK II 固件

function Install-Edk2 {
  Write-Log 'stage.edk2'
  if (-not $DoEdk2) { Write-Log 'edk2.skippedPs' -Pad 2; return }

  # Debian 的 qemu-efi-riscv64 包里就是 32 MiB 的 CODE + VARS，尺寸天然合规。
  $pool = 'https://deb.debian.org/debian/pool/main/e/edk2/'
  $listing = & $Curl -fsSL --max-time 40 -4 --noproxy '*' $pool 2>$null
  $debName = ($listing | Select-String -Pattern 'qemu-efi-riscv64_[^"]*_all\.deb' -AllMatches).Matches.Value |
             Sort-Object -Unique | Select-Object -Last 1
  if (-not $debName) { Write-Warn 'edk2.noListing' -Pad 2; return }
  Write-Log 'edk2.latest' $debName -Pad 2

  $deb = Join-Path $OutDir $debName
  try { Invoke-Fetch -Url "$pool$debName" -OutFile $deb } catch { Write-Warn 'edk2.downloadFailed' -Pad 2; return }

  # 拆 ar 容器：由实读一次 .deb 判定谁能做（GNU tar 会在此失败，bsdtar/7-Zip 通过）。
  $debTool = $null
  foreach ($cand in $DebToolCandidates) {
    if (-not $cand -or -not (Test-Path $cand)) { continue }
    $is7z = (Split-Path -Leaf $cand) -match '^7z(a)?(\.exe)?$'
    # 语法不同：tar/bsdtar 用 -tf，7-Zip 用 l。不能用同一套旗标探测。
    if ($is7z) { & $cand l $deb *> $null } else { & $cand -tf $deb *> $null }
    if ($LASTEXITCODE -eq 0) { $debTool = $cand; $debToolIs7z = $is7z; break }
  }
  if (-not $debTool) {
    Write-Warn 'edk2.noToolPs' -Pad 2
    Write-Warn 'edk2.gnuTarNote' -Pad 2
    return
  }
  Write-Log 'ar.toolPlain' (Split-Path -Leaf $debTool) -Pad 2

  $x = Join-Path $OutDir '.deb-x'
  if (Test-Path $x) { Remove-Item -Recurse -Force $x }
  New-Item -ItemType Directory -Force -Path $x | Out-Null
  if ($debToolIs7z) {
    & $debTool x -y "-o$x" $deb | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.unpackFailed7z' }
  } else {
    & $debTool -xf $deb -C $x 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.unpackFailedBsdtar' }
  }

  # 内层可能是 data.tar 或 data.tar.xz（Debian 上游用 xz，bsdtar 能直接穿透）
  $data = Get-ChildItem -Path $x -Filter 'data.tar*' | Select-Object -First 1
  if (-not $data) { Write-Die 'edk2.noDataTar' }
  if ($data.Name -match '\.(xz|gz|zst)$') {
    Write-Log 'edk2.inner' $data.Name -Pad 2
    & $debTool -xf $data.FullName -C $x './usr/share/qemu-efi-riscv64/' 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'edk2.innerFailed' $data.Name }
  } else {
    & $Tar -xf $data.FullName -C $x './usr/share/qemu-efi-riscv64/' 2>$null
  }

  $src = Join-Path $x 'usr\share\qemu-efi-riscv64'
  foreach ($f in @('RISCV_VIRT_CODE.fd', 'RISCV_VIRT_VARS.fd')) {
    $s = Join-Path $src $f
    if (-not (Test-Path $s)) { Write-Die 'edk2.notFound' $f }
    $d = Join-Path $OutDir $f
    Copy-Item -Force $s $d
    $sz = (Get-Item $d).Length
    # 文件名 + 尺寸没有语言成分，不进文案表（.sh 侧同样是拼出来的）
    Write-OkRaw ("{0}  ({1} B = {2} MiB)" -f $f, $sz, ('{0:N2}' -f ($sz / 1MB)))
    # EDK II 强制要求两块各 32 MiB，尺寸不对就别让用户拿到会在固件里报错的产物
    if ($sz -ne 33554432) { Write-Warn 'edk2.badSize' -Pad 2 }
  }
  Remove-Item -Recurse -Force $x
}

# ------------------------------------------------------------ ③ Alpine 内核 + initramfs

function Install-Alpine {
  Write-Log 'stage.alpine'
  Write-Log 'alpine.branch' $Alpine -Pad 2
  $main = "https://dl-cdn.alpinelinux.org/alpine/$Alpine/main/$Arch/"
  $rel  = "https://dl-cdn.alpinelinux.org/alpine/$Alpine/releases/$Arch/"

  # --- 内核：从目录列表动态取最新 linux-lts（不硬编码版本）
  $listing = & $Curl -fsSL --max-time 40 -4 --noproxy '*' $main 2>$null
  $apk = ($listing | Select-String -Pattern 'linux-lts-[0-9][^"]*\.apk' -AllMatches).Matches.Value |
         Sort-Object -Unique | Select-Object -Last 1
  if (-not $apk) { Write-Die 'alpine.noKernelList' }
  Write-Log 'alpine.kernel' $apk -Pad 2

  $apkPath = Join-Path $OutDir $apk
  try { Invoke-Fetch -Url "$main$apk" -OutFile $apkPath } catch { Write-Die 'alpine.kernelFailedPs' }

  Write-Log 'alpine.extractImage' -Pad 2
  $t = Join-Path $OutDir '.apk-x'
  if (Test-Path $t) { Remove-Item -Recurse -Force $t }
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  & $Tar -xzf $apkPath -C $t
  if ($LASTEXITCODE -ne 0) { Write-Die 'alpine.apkUnpackFailedPs' }
  $vmz = Get-ChildItem -Path $t -Recurse -Filter 'vmlinuz*' | Select-Object -First 1
  if (-not $vmz) { Write-Die 'alpine.noVmlinuz' }

  # gzip -dc 等价：读 gzip 流解到输出
  $imgPath = Join-Path $OutDir 'Image'
  $in  = [System.IO.File]::OpenRead($vmz.FullName)
  try {
    $gz  = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [System.IO.File]::Create($imgPath)
      try { $gz.CopyTo($out) } finally { $out.Dispose() }
    } finally { $gz.Dispose() }
  } finally { $in.Dispose() }
  Remove-Item -Recurse -Force $t

  $isz = (Get-Item $imgPath).Length
  if ($isz -lt 1000000) { Write-Die 'alpine.imageTooSmall' $isz }
  Write-Ok 'alpine.imageOk' $isz, ('{0:N1}' -f ($isz / 1MB))

  # --- initramfs：从 latest-releases.yaml 取 minirootfs（含官方 sha256 可校验）
  Write-Log 'alpine.readingYaml' -Pad 2
  $yaml = Join-Path $OutDir 'latest-releases.yaml'
  try { Invoke-Fetch -Url "${rel}latest-releases.yaml" -OutFile $yaml } catch { Write-Die 'alpine.noYaml' }

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

  $rfs = Join-Path $OutDir $rootfs
  try { Invoke-Fetch -Url "${rel}${rootfs}" -OutFile $rfs -Sha256 $sha } catch { Write-Die 'alpine.rootfsFailed' }

  # tsx 是 devDependency；打 initramfs 复用项目自己的工具链，不再要求系统装 Python。
  if (-not (Test-Path -LiteralPath $Tsx)) {
    Write-Die 'common.missingTsx' (Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd')
  }

  Write-Log 'alpine.packing' -Pad 2

  # 这一步不经过磁盘：initramfs.ts 直接从 tar 头里读 mode 与 linkname，
  # 在内存里组装 cpio。一旦落盘，Windows 上符号链接建不出来（要提权）、执行位
  # 也存不住（内核 execve 报 EACCES，起不到 init）—— 这正是它不落盘的原因。
  $cpio = Join-Path $OutDir 'initramfs.cpio.gz'
  & $Tsx (Join-Path $RepoRoot 'tools\initramfs.ts') alpine $rfs $cpio
  if ($LASTEXITCODE -ne 0) { Write-Die 'alpine.packFailed' }

  $csz = (Get-Item $cpio).Length
  if ($csz -lt 500000) { Write-Die 'alpine.tooSmall' $csz }
  Write-OkRaw "initramfs.cpio.gz  ($csz B)"

  # 再出一份未压缩的。内核解 initramfs 前先认压缩格式，认不出就按裸 cpio 直接用 ——
  # 于是"在模拟器里跑一遍 inflate"这段指令整个省掉（实测数字见末尾的引导命令）。
  # 代价只是文件大一倍，而 tmp/ 本来就不入库。
  #
  # 是"推荐但可选"，所以问一句。无人值守时 Read-Host 拿到 EOF 会返回空串（等同 no），
  # 不会挂住；想预先表态用 -Decompress / -NoDecompress。
  $wantCpio = $false
  if ($Decompress) { $wantCpio = $true }
  elseif ($NoDecompress) { $wantCpio = $false }
  else {
    Write-Host ''
    Write-Log 'alpine.decompressNote' -Pad 2
    $ans = Read-Host (Msg 'alpine.decompressAsk')
    if ($ans -match '^(y|Y|yes|YES)$') { $wantCpio = $true }
  }

  if ($wantCpio) {
    $cpioRaw = Join-Path $OutDir 'initramfs.cpio'
    & $Tsx (Join-Path $RepoRoot 'tools\initramfs.ts') decompress $cpio $cpioRaw
    if ($LASTEXITCODE -ne 0) { Write-Die 'alpine.decompressFailed' }
    Write-Ok 'alpine.decompressed' (Get-Item $cpioRaw).Length
    $script:InitrdFile = 'initramfs.cpio'
  } else {
    Write-Log 'alpine.decompressSkipped' -Pad 2
  }
}

# ----------------------------------------------------------------------- 主流程

Write-Log 'common.bannerPs'
Write-Log 'common.repo' $RepoRoot
Write-Log 'common.outdir' $OutDir
Write-Host ''
Install-OpenSbi
Write-Host ''
Install-Edk2
Write-Host ''
Install-Alpine
Write-Host ''
Write-Log 'common.done'
Get-ChildItem $OutDir -File | Where-Object { $_.Length -gt 0 } |
  Sort-Object Name | ForEach-Object { Write-Host ("  {0,12} B  {1}" -f $_.Length, $_.Name) }

$relOut = $OutDir.Replace("$RepoRoot\", '').Replace('\', '/')

# 解释文字随"这次到底产出了哪一份"变，避免打印一条指向不存在文件的命令
$initrdNote = if ($InitrdFile -eq 'initramfs.cpio') {
  Msg 'tail.uncompressed'
} else {
  Msg 'tail.compressedHint' $relOut
}

Write-Host @"

$(Msg 'tail.title')

  # $(Msg 'tail.alpineCmd')
$(Msg 'tail.earlycon')
$initrdNote

  npx tsx src/cli.ts ``
    --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin ``
    --kernel $relOut/Image --initrd $relOut/$InitrdFile ``
    --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats

  # $(Msg 'tail.edk2')
  npx tsx src/cli.ts ``
    --flash-code $relOut/RISCV_VIRT_CODE.fd ``
    --flash-vars $relOut/RISCV_VIRT_VARS.fd

"@
