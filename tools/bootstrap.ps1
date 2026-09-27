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

.EXAMPLE
  pwsh tools/bootstrap.ps1
  pwsh tools/bootstrap.ps1 -Help                  # 也可以 --help / -h / -?
  pwsh tools/bootstrap.ps1 -Mirror -NoEdk2
  pwsh tools/bootstrap.ps1 -Decompress            # 无人值守时预先同意解压 initramfs
  pwsh tools/bootstrap.ps1 -Alpine v3.24 -Dir tmp/boot-pinned

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
  Git 的 GNU tar 不能。EDK II 那一步的拆包工具由实读一次 .deb判定，不靠猜。

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
  # 接住没人认领的位置参数。PowerShell 不认 `--name` 这种写法（只认 `-name`），
  # 所以 `--help` 到不了 -Help 开关上，会原样落进这里（实测；它不是被拆成 `help`）。
  # 两种调用方式的规则还不一样：直接调用脚本（`./bootstrap.ps1 --help`）会报
  # "找不到接受自变量的位置参数"，而 `pwsh -File bootstrap.ps1 --help` 却能过 ——
  # 我第一版只测了后者，于是在用户真实的用法下是坏的。这里接住它，与 .sh 的 `--help` 对齐。
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

# ---------------------------------------------------------------- 版本守卫
#
# 只支持 PowerShell 7+。5.1 在这个脚本依赖的几处行为上都不一样：
#   * `$null` 传给原生命令的语义不同（见下面 curl 的 `-o NUL` 注释）；
#   * 它按 ANSI/GBK 读无 BOM 的 UTF-8 脚本 —— 本文件因此刻意带 UTF-8 BOM：
#     不是为了"支持 5.1"，而是为了让它能读懂这段提示。否则 5.1 会在解析阶段
#     抛出一堆语法错误，用户根本看不到下面这句话。
if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Host '本工具不支持PowerShell 5，请参阅https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows 获取PowerShell 7+。然后重试'
  Start-Sleep -Seconds 5
  exit 1
}

# 帮助入口。四种写法都要能出帮助：
#   -Help（标准开关）、-h（-Help 的唯一前缀）、-?（PowerShell 内建）、
#   以及 --help / --h。后两种到不了开关上：PowerShell 不认 `--name`，
#   实测直接调用脚本时它们原样落进 $Rest（并不是被拆成 `help`），所以按字面匹配。
# 与 .sh 侧的 `-h|--help` 对齐 —— 注释式帮助本身是给 Get-Help 读的，用户未必知道。
if ($Help -or ($Rest.Count -gt 0 -and $Rest[0] -imatch '^(--)?(help|h|\?|/\?)$')) {
  Get-Help $PSCommandPath -Full
  exit 0
}

# 其余没人认领的参数：当场报错，不要静默变成别的意思
# （这里用 Write-Host 而不是后面定义的 Write-Die —— 那些函数还没定义到）。
if ($Rest.Count -gt 0) {
  Write-Host ("错误: 无法识别的参数 '" + ($Rest -join ' ') + "'。用 -Help（或 --help）看用法。") -ForegroundColor Red
  exit 1
}

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir   = if ($Dir) { $Dir } else { Join-Path $RepoRoot 'tmp\boot' }
$FwDir    = Join-Path $RepoRoot 'firmware'
# Alpine 分支：默认 latest-stable 别名 —— 语义正确且不随发行版推进失效。
# （曾想自己算"最高版本号"，既多余又有 bug：v4.0 编码成 4000 会小于 v3.24 的 3024。）
$Arch = 'riscv64'
# 最终推荐用哪一份 initramfs 引导（解压成功则换成 .cpio）；末尾打印的引导命令据此变。
$InitrdFile = 'initramfs.cpio.gz'

function Write-Log  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "警告: $m" -ForegroundColor Yellow }
function Write-Die  { param($m) Write-Host "错误: $m" -ForegroundColor Red; exit 1 }
function Write-Ok   { param($m) Write-Host "    $m" -ForegroundColor Green }

# 依赖检查
$Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $Curl) { $Curl = (Get-Command curl -ErrorAction SilentlyContinue).Source }
if (-not $Curl) { Write-Die '缺少 curl（Windows 10 1803+ 自带；或装 Git for Windows）' }

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
if (-not $Tar) { Write-Die '缺少 tar（Windows 10 1803+ 自带 bsdtar）' }

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
  Write-Warn '找不到任何 tar/7-Zip，跳过 EDK II'
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
    if (-not $Sha256) { Write-Log "已存在，跳过下载: $(Split-Path -Leaf $OutFile)"; return }
    $got = (Get-FileHash -Algorithm SHA256 $OutFile).Hash.ToLower()
    if ($got -eq $Sha256.ToLower()) { Write-Log "已存在且校验通过: $(Split-Path -Leaf $OutFile)"; return }
    Write-Warn "已存在但校验不符，重新下载: $(Split-Path -Leaf $OutFile)"
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
      Write-Warn '    断点来自另一个源，丢弃重下（跨源续传会损坏文件）'
      Remove-Item -Force $part, $partSrc -ErrorAction SilentlyContinue
    }
  }
  Set-Content -Path $partSrc -Value $Url -NoNewline

  if ($total) { Write-Log "    源声明大小: $total B" }
  else { Write-Warn '    取不到权威大小（该源可能不支持 HEAD），只能整下' }

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
            Write-Die "sha256 不符: $(Split-Path -Leaf $OutFile)（期望 $Sha256 得到 $got）"
          }
          Write-Ok "校验通过: $(Split-Path -Leaf $OutFile)"
        }
        return
      }
      if ($have -gt $total) {
        Write-Warn "    文件超过声明大小（$have > $total），丢弃重下"
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        continue
      }
      Write-Warn ("    已续传至 {0} / {1} B（{2:N0}%），继续..." -f $have, $total, ($have * 100 / $total))
      Start-Sleep -Seconds ($i * 2)
      continue
    }
    Write-Warn "    第 $i 次尝试失败，$($i*3)s 后重试: $(Split-Path -Leaf $OutFile)"
    Start-Sleep -Seconds ($i * 3)
  }
  if (Test-Path $part) { Remove-Item -Force $part }
  throw "下载失败: $Url"
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
    Write-Warn 'GitHub release 资产直连不通。'
    Write-Warn '镜像站（gh-proxy.org）会转发 GitHub 内容，理论上可被中间方替换 —— 属于信任边界变更。'
    $ans = Read-Host '是否允许使用镜像站？[y/N]'
    if ($ans -notmatch '^(y|Y|yes|YES)$') { return $false }
  }
  Write-Log '探测镜像站速度（各取前 1 MiB）...'
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
  Write-Log "选用镜像: $best.gh-proxy.org（$([int]$bestSpeed) B/s）"
  return $true
}

# ---------------------------------------------------------------- ① OpenSBI 固件

function Install-OpenSbi {
  Write-Log '① OpenSBI 固件'
  $rel = 'riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz'
  $url = "https://github.com/$rel"
  $tarball = Join-Path $FwDir 'opensbi-1.9-rv-bin.tar.xz'
  $fwJump  = Join-Path $FwDir 'opensbi-1.9-rv-bin\share\opensbi\lp64\generic\firmware\fw_jump.bin'

  if (Test-Path $fwJump) { Write-Log '  已存在，跳过: firmware\opensbi-1.9-rv-bin\...\fw_jump.bin'; return }

  $ok = $false
  if (Test-GithubRelease) {
    Write-Log '  GitHub 直连可用'
    try { Invoke-Fetch -Url $url -OutFile $tarball; $ok = $true } catch { $ok = $false }
  } else {
    Write-Warn '  GitHub release 资产直连不可用'
  }
  if (-not $ok -and (Select-Mirror)) {
    try { Invoke-Fetch -Url "$script:GithubProxy$url" -OutFile $tarball; $ok = $true } catch { $ok = $false }
  }
  if (-not $ok) {
    Write-Warn '  无法下载 OpenSBI。'
    Write-Warn "  请手动放置：curl -L -o `"$tarball`" $url"
    Write-Warn "  解压到 $FwDir 后重跑本脚本。"
    Write-Die 'OpenSBI 获取失败（-NoMirror 时这是预期行为）'
  }

  Write-Log '  解压...'
  & $Tar -xf $tarball -C $FwDir
  if ($LASTEXITCODE -ne 0) { Write-Die 'tar 解压 OpenSBI 失败' }
  if (-not (Test-Path $fwJump)) { Write-Die '解压后未找到 fw_jump.bin' }
  Write-Ok "fw_jump.bin -> $fwJump"
}

# --------------------------------------------------------------- ② EDK II 固件

function Install-Edk2 {
  Write-Log '② EDK II (UEFI) 固件'
  if (-not $DoEdk2) { Write-Log '  已跳过（-NoEdk2）'; return }

  # Debian 的 qemu-efi-riscv64 包里就是 32 MiB 的 CODE + VARS，尺寸天然合规。
  $pool = 'https://deb.debian.org/debian/pool/main/e/edk2/'
  $listing = & $Curl -fsSL --max-time 40 -4 --noproxy '*' $pool 2>$null
  $debName = ($listing | Select-String -Pattern 'qemu-efi-riscv64_[^"]*_all\.deb' -AllMatches).Matches.Value |
             Sort-Object -Unique | Select-Object -Last 1
  if (-not $debName) { Write-Warn '  无法列出 Debian edk2 池目录，跳过 EDK II'; return }
  Write-Log "  最新包: $debName"

  $deb = Join-Path $OutDir $debName
  try { Invoke-Fetch -Url "$pool$debName" -OutFile $deb } catch { Write-Warn '  下载失败，跳过 EDK II'; return }

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
    Write-Warn '  没有能解 ar 的工具（bsdtar 或 7-Zip），跳过 EDK II'
    Write-Warn '  .deb 是 ar 归档；Git 自带的 GNU tar 不支持它'
    return
  }
  Write-Log "  拆包工具: $(Split-Path -Leaf $debTool)"

  $x = Join-Path $OutDir '.deb-x'
  if (Test-Path $x) { Remove-Item -Recurse -Force $x }
  New-Item -ItemType Directory -Force -Path $x | Out-Null
  if ($debToolIs7z) {
    & $debTool x -y "-o$x" $deb | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Die '7-Zip 解 .deb 失败' }
  } else {
    & $debTool -xf $deb -C $x 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die 'bsdtar 解 .deb 失败' }
  }

  # 内层可能是 data.tar 或 data.tar.xz（Debian 上游用 xz，bsdtar 能直接穿透）
  $data = Get-ChildItem -Path $x -Filter 'data.tar*' | Select-Object -First 1
  if (-not $data) { Write-Die '未在 .deb 里找到 data.tar*' }
  if ($data.Name -match '\.(xz|gz|zst)$') {
    Write-Log "  解内层 $($data.Name)..."
    & $debTool -xf $data.FullName -C $x './usr/share/qemu-efi-riscv64/' 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Die "解内层 $($data.Name) 失败" }
  } else {
    & $Tar -xf $data.FullName -C $x './usr/share/qemu-efi-riscv64/' 2>$null
  }

  $src = Join-Path $x 'usr\share\qemu-efi-riscv64'
  foreach ($f in @('RISCV_VIRT_CODE.fd', 'RISCV_VIRT_VARS.fd')) {
    $s = Join-Path $src $f
    if (-not (Test-Path $s)) { Write-Die "未找到 $f" }
    $d = Join-Path $OutDir $f
    Copy-Item -Force $s $d
    $sz = (Get-Item $d).Length
    Write-Ok ("{0}  ({1} B = {2:N2} MiB)" -f $f, $sz, ($sz / 1MB))
    # EDK II 强制要求两块各 32 MiB，尺寸不对就别让用户拿到会在固件里报错的产物
    if ($sz -ne 33554432) { Write-Warn "  尺寸不是 32 MiB（33554432），EDK II 可能拒绝该固件" }
  }
  Remove-Item -Recurse -Force $x
}

# ------------------------------------------------------------ ③ Alpine 内核 + initramfs

function Install-Alpine {
  Write-Log '③ Alpine 内核 + initramfs'
  Write-Log "  Alpine 分支: $Alpine"
  $main = "https://dl-cdn.alpinelinux.org/alpine/$Alpine/main/$Arch/"
  $rel  = "https://dl-cdn.alpinelinux.org/alpine/$Alpine/releases/$Arch/"

  # --- 内核：从目录列表动态取最新 linux-lts（不硬编码版本）
  $listing = & $Curl -fsSL --max-time 40 -4 --noproxy '*' $main 2>$null
  $apk = ($listing | Select-String -Pattern 'linux-lts-[0-9][^"]*\.apk' -AllMatches).Matches.Value |
         Sort-Object -Unique | Select-Object -Last 1
  if (-not $apk) { Write-Die '无法列出 Alpine 内核包（网络间歇性，可重跑）' }
  Write-Log "  内核包: $apk"

  $apkPath = Join-Path $OutDir $apk
  try { Invoke-Fetch -Url "$main$apk" -OutFile $apkPath } catch { Write-Die '内核下载失败（可重跑，已完成的会跳过）' }

  Write-Log '  解出内核 Image（apk 内是 gzip 压缩的 vmlinuz，需再 gunzip）...'
  $t = Join-Path $OutDir '.apk-x'
  if (Test-Path $t) { Remove-Item -Recurse -Force $t }
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  & $Tar -xzf $apkPath -C $t
  if ($LASTEXITCODE -ne 0) { Write-Die 'apk 解压失败' }
  $vmz = Get-ChildItem -Path $t -Recurse -Filter 'vmlinuz*' | Select-Object -First 1
  if (-not $vmz) { Write-Die 'apk 内未找到 vmlinuz' }

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
  if ($isz -lt 1000000) { Write-Die "解出的 Image 太小（$isz B），可能不是内核" }
  Write-Ok ("Image  ({0} B = {1:N1} MiB)" -f $isz, ($isz / 1MB))

  # --- initramfs：从 latest-releases.yaml 取 minirootfs（含官方 sha256 可校验）
  Write-Log '  读取 latest-releases.yaml 取 minirootfs 版本与校验值...'
  $yaml = Join-Path $OutDir 'latest-releases.yaml'
  try { Invoke-Fetch -Url "${rel}latest-releases.yaml" -OutFile $yaml } catch { Write-Die '无法获取 latest-releases.yaml' }

  $text  = Get-Content -Raw $yaml
  $rootfs = ([regex]::Matches($text, 'alpine-minirootfs-[0-9][^"\s]*riscv64\.tar\.gz') |
             ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -Last 1)
  if (-not $rootfs) { Write-Die 'latest-releases.yaml 里没有 minirootfs 条目' }

  # 取该条目所在块里的 sha256（file: 与 sha256: 相邻）
  $sha = $null
  $block = [regex]::Match($text, "(?s)file:\s*$([regex]::Escape($rootfs)).*?sha256:\s*([0-9a-f]{64})")
  if ($block.Success) { $sha = $block.Groups[1].Value }
  if (-not $sha) { Write-Warn '  未解析到 sha256，将跳过校验' }
  Write-Log "  minirootfs: $rootfs"

  $rfs = Join-Path $OutDir $rootfs
  try { Invoke-Fetch -Url "${rel}${rootfs}" -OutFile $rfs -Sha256 $sha } catch { Write-Die 'minirootfs 下载/校验失败' }

  # tsx 是 devDependency；打 initramfs 复用项目自己的工具链，不再要求系统装 Python。
  if (-not $Tsx) {
    Write-Die "找不到 tsx（$RepoRoot\node_modules\.bin\tsx）—— 请先在仓库根执行 npm install"
  }

  Write-Log '  打成 cpio-newc initramfs（tools/initramfs.ts）...'

  # 这一步不经过磁盘：initramfs.ts 直接从 tar 头里读 mode 与 linkname，
  # 在内存里组装 cpio。一旦落盘，Windows 上符号链接建不出来（要提权）、执行位
  # 也存不住（内核 execve 报 EACCES，起不到 init）—— 这正是它不落盘的原因。
  $cpio = Join-Path $OutDir 'initramfs.cpio.gz'
  & $Tsx (Join-Path $RepoRoot 'tools\initramfs.ts') alpine $rfs $cpio
  if ($LASTEXITCODE -ne 0) { Write-Die 'initramfs 打包失败（tools/initramfs.ts alpine）' }

  $csz = (Get-Item $cpio).Length
  if ($csz -lt 500000) { Write-Die "initramfs 太小（$csz B），大概率缺符号链接" }
  Write-Ok ("initramfs.cpio.gz  ({0} B)" -f $csz)

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
    Write-Log '  解压 initramfs 可省 38.9% 的引导指令（实测 12.7 亿 → 7.76 亿条，两条路都到 shell）'
    $ans = Read-Host '强烈建议解压缩initramfs，节省CPU指令从而减少启动时间 (y/N)'
    if ($ans -match '^(y|Y|yes|YES)$') { $wantCpio = $true }
  }

  if ($wantCpio) {
    $cpioRaw = Join-Path $OutDir 'initramfs.cpio'
    & $Tsx (Join-Path $RepoRoot 'tools\initramfs.ts') decompress $cpio $cpioRaw
    if ($LASTEXITCODE -ne 0) { Write-Die 'initramfs 解压失败（tools/initramfs.ts decompress）' }
    Write-Ok ("initramfs.cpio     ({0} B，未压缩；引导更快)" -f (Get-Item $cpioRaw).Length)
    $script:InitrdFile = 'initramfs.cpio'
  } else {
    Write-Log '  跳过了，只留 initramfs.cpio.gz（随时可补做：tools/initramfs.ts decompress）'
  }
}

# ----------------------------------------------------------------------- 主流程

Write-Log 'TSIE 引导素材 bootstrap (PowerShell)'
Write-Log "仓库: $RepoRoot"
Write-Log "输出: $OutDir"
Write-Host ''
Install-OpenSbi
Write-Host ''
Install-Edk2
Write-Host ''
Install-Alpine
Write-Host ''
Write-Log '全部完成。产物：'
Get-ChildItem $OutDir -File | Where-Object { $_.Length -gt 0 } |
  Sort-Object Name | ForEach-Object { Write-Host ("  {0,12} B  {1}" -f $_.Length, $_.Name) }

$relOut = $OutDir.Replace("$RepoRoot\", '').Replace('\', '/')

# 解释文字随"这次到底产出了哪一份"变，避免打印一条指向不存在文件的命令
$initrdNote = if ($InitrdFile -eq 'initramfs.cpio') {
@"
  # 用的是未压缩的 initramfs.cpio：内核认不出压缩就直接按裸 cpio 用，
  #    省掉在模拟器里跑 inflate。同机同核实测（instret，两条路都到 ~ #）：
  #      initramfs.cpio.gz   1,270,638,213 条   到 /init 用 t=120.26s
  #      initramfs.cpio        776,011,912 条   到 /init 用 t=64.67s
  #    ⇒ 省 4.95 亿条（38.9%）。差别不是能不能起来，是快多少。
  #    （虚拟秒与指令数不成正比：内核的 time 走被抖动的 mtime，指令数才是准的。）
"@
} else {
@"
  # 这次用的是压缩态 initramfs.cpio.gz。想快 38.9% 就补一步（实测省 4.95 亿条指令）：
  #      npx tsx tools/initramfs.ts decompress $relOut/initramfs.cpio.gz $relOut/initramfs.cpio
  #    然后把下面 --initrd 换成 $relOut/initramfs.cpio。
"@
}

Write-Host @"

引导命令（在仓库根执行）：

  # Alpine + OpenSBI（到 BusyBox shell）
  # 必须带 earlycon=sbi：Alpine 内核编了 SBI earlycon 驱动，有它约 150M 指令内
  #    就能看到输出；没有它内核会把 printk 攒在 ring buffer 里，直到 16550 控制台
  #    注册（约 350-400M 指令）才一次性倒出 —— 看起来像卡死。
$initrdNote
  npx tsx src/cli.ts ``
    --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin ``
    --kernel $relOut/Image --initrd $relOut/$InitrdFile ``
    --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats

  # EDK II (UEFI)：需要成对提供 CODE / VARS
  npx tsx src/cli.ts ``
    --flash-code $relOut/RISCV_VIRT_CODE.fd ``
    --flash-vars $relOut/RISCV_VIRT_VARS.fd

"@
