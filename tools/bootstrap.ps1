<#
.SYNOPSIS
  一键拉取并拼装 TSIE 的引导素材：OpenSBI 固件 + EDK II (UEFI) 固件 + Alpine 内核/initramfs。

.DESCRIPTION
  tools/bootstrap.sh 的 PowerShell 孪生，面向原生 Windows（pwsh）。行为逐项对齐：

    * 版本号一律**动态发现**，不硬编码。Alpine 的包更新很快，写死的 URL 会 404
      （README 里那个 linux-lts-6.18.44 在 2026-09-26 就已经是 404）。
    * 产物落在 gitignored 目录（firmware/、tmp/），**不得入库**：
      GPL-2.0 / 第三方产物，本项目是 Apache-2.0。
    * 下载全部带重试。本机网络对 dl-cdn / deb.debian.org 是**间歇性**可达的，
      同一域名前一刻成功、后一刻 21 秒超时，不带重试必然随机失败。
    * GitHub release 资产**直连不通**（github.com 能到，但 302 之后的
      objects.githubusercontent.com 超时），需要镜像。镜像属代理转发，
      脚本会先征求同意（-Mirror 可预先授权）。
    * 下载统一走 curl.exe（Windows 自带的就够），这样与 .sh 版本共用同一套
      旗标语义（--retry / --noproxy / -4），避免 Invoke-WebRequest 的差异。

  cpio 打包复用项目已有的 tools/make-initramfs.py —— PowerShell 与 Git Bash
  都没有原生 cpio（本机也没有 ar/dpkg-deb），没必要造第三份实现。

.EXAMPLE
  pwsh tools/bootstrap.ps1
  pwsh tools/bootstrap.ps1 -Mirror -NoEdk2
  pwsh tools/bootstrap.ps1 -Alpine v3.24 -Dir tmp/boot-pinned

.NOTES
  传 -Dir 时**用正斜杠或相对路径**：PowerShell 会把双引号里的 `\t`、`\n` 当转义序列，
  写 `-Dir G:\tmp\ps-test` 会静默变成 `G:tmpps-test`（`\t` = 制表符）。
  已知坑：本机 dl-cdn 会重定向且速度在 45 KB/s~5 KB/s 间摆动，故下载走 -C - 断点续传
  并按**最终**响应的 Content-Length 判完成；`.part` 还记录来源 URL，换源即重下。
#>
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE

[CmdletBinding()]
param(
  [switch]$Mirror,      # 预先授权镜像（无人值守）
  [switch]$NoMirror,    # 禁止镜像；OpenSBI 只从本地已有文件取
  [switch]$NoEdk2,      # 跳过 EDK II（省约 70 MB）
  [string]$Alpine = 'latest-stable',  # Alpine 分支（默认 latest-stable 别名）
  [string]$Dir          # 换输出目录（默认 tmp/boot）
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir   = if ($Dir) { $Dir } else { Join-Path $RepoRoot 'tmp\boot' }
$FwDir    = Join-Path $RepoRoot 'firmware'
# Alpine 分支：默认 latest-stable 别名 —— 语义正确且不随发行版推进失效。
# （曾想自己算"最高版本号"，既多余又有 bug：v4.0 编码成 4000 会小于 v3.24 的 3024。）
$Arch = 'riscv64'

function Write-Log  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "警告: $m" -ForegroundColor Yellow }
function Write-Die  { param($m) Write-Host "错误: $m" -ForegroundColor Red; exit 1 }
function Write-Ok   { param($m) Write-Host "    $m" -ForegroundColor Green }

# 依赖检查
$Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $Curl) { $Curl = (Get-Command curl -ErrorAction SilentlyContinue).Source }
if (-not $Curl) { Write-Die '缺少 curl（Windows 10 1803+ 自带；或装 Git for Windows）' }

$Tar = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source
if (-not $Tar) { Write-Die '缺少 tar（Windows 10 1803+ 自带 bsdtar）' }

$SevenZip = $null
foreach ($p in @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe')) {
  if (Test-Path $p) { $SevenZip = $p; break }
}
if (-not $SevenZip) { $SevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source }

$Python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue).Source }

$DoEdk2 = -not $NoEdk2
if ($DoEdk2 -and -not $SevenZip) {
  Write-Warn '找不到 7-Zip，跳过 EDK II（.deb 是 ar 归档，本机没有 ar/dpkg-deb）'
  $DoEdk2 = $false
}

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

  # 权威大小：必须跟随重定向取**最终**响应的 Content-Length。
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
  & $Curl -fsSL -o $null --max-time 25 -4 --noproxy '*' -r 0-1023 $u 2>$null
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
    $sp = & $Curl -fsSL -o $null --max-time 30 -4 --noproxy '*' -r 0-1048575 `
      -w '%{speed_download}' "https://$name.gh-proxy.org/$u" 2>$null
    if ($LASTEXITCODE -ne 0) { $sp = 0 }
    $sp = [double]($sp -replace '[^\d.]', '')
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
  if (-not $DoEdk2) { Write-Log '  已跳过（-NoEdk2 或缺少 7-Zip）'; return }

  # Debian 的 qemu-efi-riscv64 包里就是 32 MiB 的 CODE + VARS，尺寸天然合规。
  $pool = 'https://deb.debian.org/debian/pool/main/e/edk2/'
  $listing = & $Curl -fsSL --max-time 40 -4 --noproxy '*' $pool 2>$null
  $debName = ($listing | Select-String -Pattern 'qemu-efi-riscv64_[^"]*_all\.deb' -AllMatches).Matches.Value |
             Sort-Object -Unique | Select-Object -Last 1
  if (-not $debName) { Write-Warn '  无法列出 Debian edk2 池目录，跳过 EDK II'; return }
  Write-Log "  最新包: $debName"

  $deb = Join-Path $OutDir $debName
  try { Invoke-Fetch -Url "$pool$debName" -OutFile $deb } catch { Write-Warn '  下载失败，跳过 EDK II'; return }

  Write-Log '  解包（.deb 是 ar 归档，用 7-Zip）...'
  $x = Join-Path $OutDir '.deb-x'
  if (Test-Path $x) { Remove-Item -Recurse -Force $x }
  New-Item -ItemType Directory -Force -Path $x | Out-Null
  & $SevenZip x -y "-o$x" $deb | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Die '7-Zip 解 .deb 失败' }

  $data = Get-ChildItem -Path $x -Filter 'data.tar*' | Select-Object -First 1
  if (-not $data) { Write-Die '未在 .deb 里找到 data.tar' }
  & $Tar -xf $data.FullName -C $x './usr/share/qemu-efi-riscv64/' 2>$null

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

  # Python 是硬依赖：解压（保符号链接）与打 cpio 都要它。
  if (-not $Python) {
    Write-Die '找不到 python。解压必须用 tools/extract_archive.py —— Windows 的 tar 建不了符号链接（见下），而缺少链接的 initramfs 起不到 shell。'
  }

  Write-Log '  解出 rootfs 树并打成 cpio-newc initramfs...'
  $root = Join-Path $OutDir 'rootfs'
  if (Test-Path $root) { Remove-Item -Recurse -Force $root }
  New-Item -ItemType Directory -Force -Path $root | Out-Null

  # ⚠️ 必须用 extract_archive.py，不能用 tar：
  # Alpine 的可执行文件几乎全是指向 /bin/busybox 的符号链接，而 Windows 上
  # tar 与 ln 都建不了链接（需管理员或开发者模式）—— 实测 tar 解完 0 链接 / 106 文件
  # 且提前中止。Python tarfile 用重解析点写链接，普通用户即可，能解出 335 个。
  # 少了这些链接，initramfs 里 /bin/sh 就不存在，根本起不到 shell。
  & $Python (Join-Path $RepoRoot 'tools\extract_archive.py') $rfs $root
  if ($LASTEXITCODE -ne 0) { Write-Die 'rootfs 解压失败（extract_archive.py）' }

  $cpio = Join-Path $OutDir 'initramfs.cpio.gz'
  & $Python (Join-Path $RepoRoot 'tools\make-initramfs.py') $root $cpio
  if ($LASTEXITCODE -ne 0) { Write-Die 'make-initramfs.py 失败' }
  Remove-Item -Recurse -Force $root

  $csz = (Get-Item $cpio).Length
  if ($csz -lt 500000) { Write-Die "initramfs 太小（$csz B），大概率缺符号链接" }
  Write-Ok ("initramfs.cpio.gz  ({0} B)" -f $csz)
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
Write-Host @"

引导命令（在仓库根执行）：

  # Alpine + OpenSBI（到 BusyBox shell）
  # ⚠️ 必须带 earlycon=sbi：Alpine 内核编了 SBI earlycon 驱动，有它约 150M 指令内
  #    就能看到输出；没有它内核会把 printk 攒在 ring buffer 里，直到 16550 控制台
  #    注册（约 350-400M 指令）才一次性倒出 —— 看起来像卡死。
  # ⚠️ 指令预算给足 1.5e9：完整引导需约 1.2e9 条（含 initramfs 解包）。
  npx tsx src/cli.ts ``
    --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin ``
    --kernel $relOut/Image --initrd $relOut/initramfs.cpio.gz ``
    --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats

  # EDK II (UEFI)：需要成对提供 CODE / VARS
  npx tsx src/cli.ts ``
    --flash-code $relOut/RISCV_VIRT_CODE.fd ``
    --flash-vars $relOut/RISCV_VIRT_VARS.fd

"@
