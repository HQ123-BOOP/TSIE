#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
#
# 一键拉取并拼装 TSIE 的引导素材：OpenSBI 固件 + EDK II (UEFI) 固件 + Alpine 内核/initramfs。
#
# 设计约定（照着改之前先读）：
#   * 版本号一律**动态发现**，不硬编码。Alpine 的包更新很快，写死的 URL 会 404
#     （README 里那个 linux-lts-6.18.44 在 2026-09-26 就已经是 404）。
#   * 所有产物落在 gitignored 目录（`firmware/`、`tmp/`），**不得入库**：
#     这些是 GPL-2.0 / 第三方产物，本项目是 Apache-2.0。
#   * 下载全部带重试。本机网络对 dl-cdn / deb.debian.org 是**间歇性**可达的，
#     同一个域名前一刻成功、后一刻 21 秒超时，不带重试必然随机失败。
#   * GitHub release 资产**直连不通**（github.com 能到，但 302 之后的
#     objects.githubusercontent.com 超时），所以需要镜像。镜像属代理转发，
#     脚本会先征求同意（--mirror 可预先授权）。
#
# 用法：
#   tools/bootstrap.sh                 # 交互：GitHub 不通时询问是否用镜像
#   tools/bootstrap.sh --mirror        # 预先授权镜像（无人值守）
#   tools/bootstrap.sh --no-mirror     # 禁止镜像；OpenSBI 只从本地已有文件取
#   tools/bootstrap.sh --no-edk2       # 跳过 EDK II（省约 70 MB）
#   tools/bootstrap.sh --alpine v3.24  # 固定 Alpine 分支（默认 latest-stable）
#   tools/bootstrap.sh --dir DIR       # 换输出目录（默认 tmp/boot）
#
# 依赖（缺失时的后果已注明）：
#   必需  curl / tar / sha256sum   Git Bash 自带
#   必需  python                   解压与打 cpio 都靠它。**不是可选项**：Windows 的 tar
#                                  建不了符号链接、也不保留执行位，直接 tar 解出来的 rootfs
#                                  产出的 initramfs 会因 EACCES 起不到 init。
#                                  需 Python 3.12+（extract_archive.py 用 tarfile 的 filter=）
#   可选  bsdtar / 7-Zip           只有 EDK II 需要：.deb 是 **ar 归档**，而 Git Bash 的
#                                  GNU tar **不支持 ar**。Windows 自带的
#                                  C:\Windows\System32\tar.exe 就是 bsdtar（libarchive），
#                                  能解 ar 且能穿透内层 data.tar.xz —— 优先用它；
#                                  7-Zip 作兜底。两者都没有时自动跳过 EDK II。
#   不需要 xz                      OpenSBI 是 .tar.xz，但 tar 自己经 liblzma 解压。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/tmp/boot"
FW_DIR="$REPO_ROOT/firmware"
# Alpine 分支：默认用 latest-stable 别名 —— 语义正确，且不会随发行版推进而失效。
# （曾想自己算"最高版本号"，但那既多余又有 bug：v4.0 编码成 4000 会小于 v3.24 的 3024。）
# 需要固定分支时用 --alpine v3.24。
ALPINE_BRANCH="latest-stable"

MIRROR_MODE="ask"    # ask | yes | no
DO_EDK2=1

SEVENZIP="/c/Program Files/7-Zip/7z.exe"

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m警告:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror)    MIRROR_MODE="yes" ;;
    --no-mirror) MIRROR_MODE="no" ;;
    --no-edk2)   DO_EDK2=0 ;;
    --alpine)    ALPINE_BRANCH="$2"; shift ;;
    --dir)       OUT_DIR="$2"; shift ;;
    -h|--help)   sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1"; }
# 注意：**不检查 xz**。OpenSBI 是 .tar.xz，但 `tar -xf` 自己会经 liblzma 解压，
# 不需要独立的 xz 命令（实测 GNU tar 1.35 直接解开）。ps1 侧同理，从未依赖它。
for c in curl tar sha256sum python; do need "$c"; done
# python 是硬依赖（ps1 侧同样）：解压必须走 extract_archive.py —— Windows 的 tar 建不了
# 符号链接、也不保留执行位，缺了它产出的 initramfs 无法引导。提前检查，别等 20 分钟后才报。

# ------------------------------------------------- EDK II 的 ar 拆包工具选择
#
# .deb 是 **ar 归档**（魔数 `!<arch>`），不是 tar 也不是 zip。本机没有 ar/dpkg-deb。
# 关键事实（实测，别再凭印象）：
#   * Git Bash 的 `tar` 是 **GNU tar 1.35 → 不支持 ar**，用它解 .deb 必报错。
#   * **Windows 自带的 bsdtar（libarchive 3.8.8）支持 ar**，且能一路穿透内层 data.tar.xz。
#     它在 PATH 里被 Git 的 tar 遮蔽（同名 tar.exe），必须按绝对路径调用。
#     实测产物与 7-Zip 逐字节一致（两个 .fd 的 sha256 相同）。
#   * 7-Zip 也能做，作为兜底。
#
# 候选按优先级排列；真正判定在 deb 下载后用 probe_deb_tool 实读一次。
AR_CANDIDATES=()
build_ar_candidates() {
  local sysroot="${SYSTEMROOT:-C:\\Windows}"
  AR_CANDIDATES=(
    "/c/Windows/System32/tar.exe"       # Windows 自带 bsdtar（64 位进程）
    "${sysroot}/System32/tar.exe"
    "/c/Windows/sysnative/tar.exe"      # 32 位进程下的 64 位视图
    "$SEVENZIP"
  )
  local z; z="$(command -v 7z 2>/dev/null || true)"
  [ -n "$z" ] && AR_CANDIDATES+=("$z")
}

# 用真实的 .deb 试读：每个候选都要能列出 ar 成员才算数。
#
# ⚠️ 语法不同，不能用同一套旗标探测：GNU tar 与 bsdtar 是 `-tf`，**7-Zip 是 `l`**。
# 早先用 `-tf` 去测 7z 会把它误判为"读不了 ar"（实测踩过）。
AR_TOOL=""
is_7zip() { case "$(basename "$1")" in 7z|7z.exe|7za|7za.exe) return 0 ;; *) return 1 ;; esac; }

probe_deb_tool() {  # probe_deb_tool <某个 .deb>
  local deb="$1"
  local bin
  for bin in "${AR_CANDIDATES[@]}"; do
    [ -x "$bin" ] || continue
    if is_7zip "$bin"; then
      "$bin" l "$deb" >/dev/null 2>&1 && { AR_TOOL="$bin"; log "  EDK II 拆包工具: 7-Zip ($bin)"; return 0; }
    else
      "$bin" -tf "$deb" >/dev/null 2>&1 && { AR_TOOL="$bin"; log "  EDK II 拆包工具: bsdtar ($bin)"; return 0; }
    fi
  done
  return 1
}

mkdir -p "$OUT_DIR" "$FW_DIR"
build_ar_candidates

# ---------------------------------------------------------------- 下载（重试 + 续传 + 多源）

# 本机网络有三个特点，fetch 必须同时应付：
#   1. **间歇性可达** —— 同一域名前一刻成功、后一刻 21s 超时；必须退避重试。
#   2. **会中途掉速** —— 实测 22 MB 的内核在 45 KB/s 与 5 KB/s 之间摆（差 9 倍），
#      纯重试会从 0 重来，前功尽弃。故用 `-C -` 断点续传。
#   3. **多源快慢不一** —— 故接受多个 URL 候选，逐个试，谁快谁上。

# 权威文件大小：必须跟随重定向取**最终**响应的 Content-Length。
#
# ⚠️ 这里踩过一个严重坑：早先写成 `curl -I`（不带 -L），拿到的是重定向源站的
# Content-Length —— dl-cdn 返回 15501313（rc 页面大小），而真实文件是 22001665。
# 于是"续传到 14.5 MB"被误判为**下载完成**，直到 `tar -xzf` 才炸。
# 静默地把残缺文件当成品交给下一步，是这个脚本最危险的失败模式。
remote_size() {
  curl -fsSLI --max-time 30 -4 --noproxy '*' "$1" 2>/dev/null \
    | grep -i '^content-length' | tail -1 | tr -d '\r' | awk '{print $2}'
}

# 提前验证归档**数据完整**（不只是能列目录）。
#
# ⚠️ 关键区别，踩过：`tar -tzf` 只读文件表、不解压数据流，所以**残缺文件也能列出**。
# apk 是拼接的多个 gzip 流（实测 4 段），截断会切在流中间：
#     tar -tzf 通过 / tar -xzf 失败 —— 于是残缺文件一路走到解压步骤才炸。
# 这里解压到 /dev/null（丢弃内容、完整读一遍），能真正发现截断。
verify_archive() {  # verify_archive <文件> <tar旗标...>
  local f="$1"; shift
  [ -s "$f" ] || return 1
  tar "$@" -xOf "$f" >/dev/null 2>&1
}

# 单个 URL 续传式下载：循环续传直到达到权威大小。
fetch_one() {  # fetch_one <url> <输出文件>
  local url="$1" out="$2" part="$2.part"
  local total; total="$(remote_size "$url")"

  # ⚠️ 源一致性：`.part` 可能来自**另一个**源（上一次运行走的是镜像）。
  # 不同源的字节流不能拼接 —— 曾因此产出"大小对得上但内容损坏"的文件。
  # 换源就从 0 重来（宁可慢，不可错）。
  if [ -s "$part" ]; then
    local prev=""
    [ -f "$part.src" ] && prev="$(cat "$part.src" 2>/dev/null || true)"
    if [ "$prev" != "$url" ]; then
      warn "    断点来自另一个源，丢弃重下（跨源续传会损坏文件）"
      rm -f "$part" "$part.src"
    fi
  fi
  printf '%s' "$url" > "$part.src"

  if [ -z "$total" ]; then
    warn "    取不到权威大小（该源可能不支持 HEAD），只能整下"
  else
    log "    源声明大小: $total B"
  fi

  local i have
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsSL -C - --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 \
         -4 --noproxy '*' -o "$part" "$url" || true
    if [ ! -s "$part" ]; then
      warn "    第 $i 次尝试失败，$((i*3))s 后重试"
      sleep $((i*3)); continue
    fi
    have=$(stat -c %s "$part")
    if [ -n "$total" ] && [ "$have" -eq "$total" ]; then
      mv -f "$part" "$out"; rm -f "$part.src"; return 0
    fi
    if [ -n "$total" ] && [ "$have" -gt "$total" ]; then
      # 超出声明大小 = 拼接污染或服务端变了；重下而不是硬用
      warn "    文件超过声明大小（$have > $total），丢弃重下"
      rm -f "$part"; continue
    fi
    if [ -z "$total" ]; then
      mv -f "$part" "$out"; rm -f "$part.src"; return 0
    fi
    warn "    已续传至 $have / $total B（$(awk "BEGIN{printf \"%.0f\", $have*100/$total}")%），继续..."
    sleep $((i*2))
  done
  return 1
}

# 列目录 / 取小文件：也要重试。
# （教训：原先只有下载带重试，列目录是单次尝试 —— 网络一抽风就直接放弃整个环节。）
fetch_text() {  # fetch_text <url>
  local url="$1" i out
  for i in 1 2 3 4 5; do
    out=$(curl -fsSL --max-time 40 --connect-timeout 20 -4 --noproxy '*' "$url" 2>/dev/null) && {
      [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    }
    sleep $((i*3))
  done
  return 1
}

# 多源下载：依次尝试候选 URL，全部失败才报错。带可选取 sha256 校验。
fetch() {  # fetch <输出文件> <校验sha256|""> <url> [备用url...]
  local out="$1" want="$2"; shift 2
  if [ -f "$out" ] && [ -s "$out" ]; then
    if [ -z "$want" ] || [ "$(sha256sum "$out" | cut -d' ' -f1)" = "$want" ]; then
      log "已存在，跳过下载: $(basename "$out")"; return 0
    fi
    warn "已存在但校验不符，重新下载: $(basename "$out")"
    rm -f "$out"
  fi
  [ -f "$out.part" ] && log "  发现未完成的续传文件，将从断点继续"

  local url
  for url in "$@"; do
    log "  源: $(echo "$url" | cut -d/ -f3)"
    if fetch_one "$url" "$out"; then
      if [ -n "$want" ]; then
        local got; got="$(sha256sum "$out" | cut -d' ' -f1)"
        if [ "$got" != "$want" ]; then
          warn "  sha256 不符（期望 $want 得到 $got），换下一个源"
          rm -f "$out"; continue
        fi
        log "  校验通过: $(basename "$out")"
      fi
      return 0
    fi
    warn "  该源失败: $(echo "$url" | cut -d/ -f3)"
  done
  rm -f "$out.part"
  return 1
}

# ---------------------------------------------------- Alpine 源

ARCH="riscv64"
#
# 官方 dl-cdn 是本机唯一稳定可用的 Alpine 源；国内镜像对 v3.24 普遍未同步（实测
# 清华 403、阿里/南大/上交/华为 404）。所以镜像只作为**官方源失败时的兜底**，
# 不指望它更快。多一个源就自动获得"换源重试"，且校验值仍取自官方 manifest。
ALPINE_MIRROR="https://mirrors.ustc.edu.cn/alpine"

# ---------------------------------------------------- GitHub 直连探测 / 镜像选择

GITHUB_PROXY=""

probe_github_release() {
  # release 资产直连：只看能否真取到字节。302 之后的下载域名经常不通。
  local u="https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz"
  curl -fsSL -o /dev/null --max-time 25 -4 --noproxy '*' -r 0-1023 "$u" 2>/dev/null
}

pick_mirror() {
  [ "$MIRROR_MODE" = "no" ] && return 1
  local base u best="" best_speed=0 name speed
  u="https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz"
  if [ "$MIRROR_MODE" = "ask" ]; then
    echo
    warn "GitHub release 资产直连不通。"
    warn "镜像站（gh-proxy.org）会转发 GitHub 内容，理论上可被中间方替换 —— 属于信任边界变更。"
    printf '是否允许使用镜像站？[y/N] '
    local ans=""; read -r ans || true
    case "$ans" in y|Y|yes|YES) ;; *) return 1 ;; esac
  fi
  log "探测镜像站速度（各取前 1 MiB）..."
  for name in v4 v6; do
    speed=$(curl -fsSL -o /dev/null --max-time 30 -4 --noproxy '*' -r 0-1048575 \
      -w '%{speed_download}' "https://${name}.gh-proxy.org/${u}" 2>/dev/null || echo 0)
    speed=${speed%.*}
    printf '    %-4s %s B/s\n' "$name" "${speed:-0}"
    if [ "${speed:-0}" -gt "$best_speed" ]; then best_speed="$speed"; best="$name"; fi
  done
  [ -n "$best" ] || return 1
  GITHUB_PROXY="https://${best}.gh-proxy.org/"
  log "选用镜像: ${best}.gh-proxy.org（${best_speed} B/s）"
  return 0
}

# ---------------------------------------------------------------- ① OpenSBI 固件

bootstrap_opensbi() {
  log "① OpenSBI 固件"
  local rel="riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz"
  local url="https://github.com/${rel}"
  local tarball="$FW_DIR/opensbi-1.9-rv-bin.tar.xz"

  if [ -f "$FW_DIR/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin" ]; then
    log "  已存在，跳过: firmware/opensbi-1.9-rv-bin/.../fw_jump.bin"
    return 0
  fi

  # 直连优先；失败再走镜像（镜像需授权）。授权被拒则回退本地文件。
  local ok=0
  if probe_github_release; then
    log "  GitHub 直连可用"
    fetch "$tarball" "" "$url" && ok=1 || true
  else
    warn "  GitHub release 资产直连不可用"
  fi
  if [ "$ok" = 0 ]; then
    if pick_mirror; then
      fetch "$tarball" "" "${GITHUB_PROXY}${url}" && ok=1 || true
    fi
  fi
  if [ "$ok" = 0 ]; then
    warn "  无法下载 OpenSBI。"
    warn "  请手动放置：curl -L -o $tarball $url"
    warn "  然后解压到 $FW_DIR/ 并重跑本脚本。"
    die "OpenSBI 获取失败（--no-mirror 时这是预期行为）"
  fi

  log "  解压..."
  verify_archive "$tarball" \
    || die "OpenSBI tar.xz 下载不完整（tar 无法列出内容）—— 删掉后重跑，或手动放置"
  tar -xf "$tarball" -C "$FW_DIR"
  local fw="$FW_DIR/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin"
  [ -f "$fw" ] || die "解压后未找到 fw_jump.bin"
  log "  ✅ $fw"
}

# --------------------------------------------------------------- ② EDK II 固件

bootstrap_edk2() {
  log "② EDK II (UEFI) 固件"
  [ "$DO_EDK2" = 1 ] || { log "  已按 --no-edk2 跳过"; return 0; }

  # Debian 的 qemu-efi-riscv64 包里就是 32 MiB 的 CODE + VARS，尺寸天然合规。
  # 版本号动态取（池目录里可能有多个版本，取最新的）。
  local pool="https://deb.debian.org/debian/pool/main/e/edk2/"
  local deb_name
  deb_name=$(fetch_text "$pool" 2>/dev/null \
    | grep -oE 'qemu-efi-riscv64_[^"]*_all\.deb' | sort -u | tail -1) || true
  [ -n "$deb_name" ] || { warn "  无法列出 Debian edk2 池目录，跳过 EDK II"; return 0; }
  log "  最新包: $deb_name"

  local deb="$OUT_DIR/$deb_name"
  fetch "$deb" "" "$pool$deb_name" || { warn "  下载失败，跳过 EDK II"; return 0; }

  # 拆 ar 容器。工具在下载后**实读一次**判定（GNU tar 会在此失败，bsdtar/7-Zip 通过）。
  if ! probe_deb_tool "$deb"; then
    warn "  没有能解 ar 的工具（bsdtar 或 7-Zip），跳过 EDK II"
    warn "  .deb 是 ar 归档；Git Bash 的 GNU tar 不支持它"
    return 0
  fi

  local x="$OUT_DIR/.deb-x"
  rm -rf "$x"; mkdir -p "$x"
  # bsdtar 与 7z 的调用语法不同：bsdtar 是 -xf ... -C，7z 是 x -y -o<dir>
  if is_7zip "$AR_TOOL"; then
    log "  拆包（7-Zip）..."
    "$AR_TOOL" x -y -o"$x" "$deb" >/dev/null 2>&1 || die "7-Zip 解 .deb 失败"
  else
    log "  拆包（bsdtar）..."
    "$AR_TOOL" -xf "$deb" -C "$x" 2>/dev/null || die "bsdtar 解 .deb 失败"
  fi

  # 内层可能是 data.tar 或 data.tar.xz（Debian 上游用 xz，bsdtar 能直接穿透）
  local data; data="$(ls "$x"/data.tar* 2>/dev/null | head -1)"
  [ -n "$data" ] || die "未在 .deb 里找到 data.tar*"
  case "$data" in
    *.xz|*.gz|*.zst)
      log "  解内层 $(basename "$data")..."
      "$AR_TOOL" -xf "$data" -C "$x" ./usr/share/qemu-efi-riscv64/ 2>/dev/null \
        || die "解内层 $(basename "$data") 失败"
      ;;
    *)
      verify_archive "$data" || die ".deb 内的 data.tar 不完整，重新下载 $deb_name"
      tar -xf "$data" -C "$x" ./usr/share/qemu-efi-riscv64/ 2>/dev/null || true
      ;;
  esac

  local src="$x/usr/share/qemu-efi-riscv64"
  local f
  for f in RISCV_VIRT_CODE.fd RISCV_VIRT_VARS.fd; do
    [ -f "$src/$f" ] || die "未找到 $f"
    cp -f "$src/$f" "$OUT_DIR/$f"
    local sz; sz=$(stat -c %s "$OUT_DIR/$f")
    log "  ✅ $f  ($sz B = $(awk "BEGIN{printf \"%.2f\", $sz/1048576}") MiB)"
    # EDK II 强制要求两块各 32 MiB，尺寸不对就别让用户拿到一个会在固件里报错的产物
    [ "$sz" -eq 33554432 ] || warn "  尺寸不是 32 MiB（33554432），EDK II 可能拒绝该固件"
  done
  rm -rf "$x"
}

# ------------------------------------------------------------ ③ Alpine 内核 + initramfs

bootstrap_alpine() {
  log "③ Alpine 内核 + initramfs"
  local main="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_BRANCH/main/$ARCH/"
  local rel="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_BRANCH/releases/$ARCH/"

  # --- 内核：从目录列表动态取最新 linux-lts（不硬编码版本）
  local apk
  apk=$(fetch_text "$main" 2>/dev/null \
    | grep -oE 'linux-lts-[0-9][^"]*\.apk' | sort -u | tail -1) || true
  [ -n "$apk" ] || die "无法列出 Alpine 内核包（网络间歇性，可重跑）"
  log "  内核包: $apk"

  local apk_path="$OUT_DIR/$apk"
  local mirror_main="$ALPINE_MIRROR/$ALPINE_BRANCH/main/$ARCH/$apk"
  fetch "$apk_path" "" "$main$apk" "$mirror_main" \
    || die "内核下载失败（可重跑，会从断点续传）"

  log "  解出内核 Image（apk 内是 gzip 压缩的 vmlinuz，需再 gunzip）..."
  local t="$OUT_DIR/.apk-x"; rm -rf "$t"; mkdir -p "$t"
  verify_archive "$apk_path" -z \
    || die "apk 下载不完整（完整解压校验失败）—— 删掉 $apk_path 与同名 .part 后重跑"

  # ⚠️ 只解 `boot/`，**不要**整包解压。apk 里有个指向 `/boot/vmlinuz-lts` 的相对符号链接
  # （lib/modules/*/vmlinuz），Windows 上建不了，会让 tar 以退出码 2 结束并带上
  # "Cannot create symlink" —— 整个归档其实完好，只是那一条无关链接失败。
  # 只取需要的成员既避开这个坑，也少解 20 MB 的模块树。
  tar -xzf "$apk_path" -C "$t" boot/ 2>/dev/null \
    || die "apk 解压 boot/ 失败"
  local vmz="$t/boot/vmlinuz-lts"
  [ -f "$vmz" ] || vmz="$(find "$t" -name 'vmlinuz*' | head -1)"
  [ -n "$vmz" ] || die "apk 内未找到 vmlinuz"
  gzip -dc "$vmz" > "$OUT_DIR/Image"
  rm -rf "$t"
  local isz; isz=$(stat -c %s "$OUT_DIR/Image")
  [ "$isz" -gt 1000000 ] || die "解出的 Image 太小（$isz B），可能不是内核"
  log "  ✅ Image  ($isz B = $(awk "BEGIN{printf \"%.1f\", $isz/1048576}") MiB)"

  # --- initramfs：从 latest-releases.yaml 取 minirootfs（含官方 sha256 可校验）
  log "  读取 latest-releases.yaml 取 minirootfs 版本与校验值..."
  local yaml="$OUT_DIR/latest-releases.yaml"
  local mirror_yaml="$ALPINE_MIRROR/$ALPINE_BRANCH/releases/$ARCH/latest-releases.yaml"
  fetch "$yaml" "" "${rel}latest-releases.yaml" "$mirror_yaml" \
    || die "无法获取 latest-releases.yaml"

  local rootfs sha
  rootfs=$(grep -oE 'alpine-minirootfs-[0-9][^"]*riscv64\.tar\.gz' "$yaml" | sort -u | tail -1)
  [ -n "$rootfs" ] || die "latest-releases.yaml 里没有 minirootfs 条目"
  # 取该条目后面的 sha256（同一块里 file: 与 sha256: 相邻）
  sha=$(awk -v f="$rootfs" '
    $0 ~ "file: *"f {found=1}
    found && /sha256:/ {gsub(/.*sha256: */,""); print; exit}
  ' "$yaml")
  [ -n "$sha" ] || warn "  未解析到 sha256，将跳过校验"
  log "  minirootfs: $rootfs"

  local rfs="$OUT_DIR/$rootfs"
  local mirror_rfs="$ALPINE_MIRROR/$ALPINE_BRANCH/releases/$ARCH/$rootfs"
  fetch "$rfs" "$sha" "${rel}${rootfs}" "$mirror_rfs" \
    || die "minirootfs 下载/校验失败"

  log "  解出 rootfs 树并打成 cpio-newc initramfs（复用 tools/make-initramfs.py）..."
  local root="$OUT_DIR/rootfs"
  # 权限表是 rootfs 的**同级**文件（extract_archive.py 写出），清理时要一起删，否则残留干扰下次运行。
  rm -rf "$root" "$root.modes.json"; mkdir -p "$root"
  verify_archive "$rfs" -z \
    || die "minirootfs 下载不完整（完整解压校验失败）—— 删掉重跑"

  # ⚠️ 必须用 extract_archive.py，**不能**用 tar：
  # Alpine 的可执行文件几乎全是指向 /bin/busybox 的符号链接，而 Windows 上
  # tar/ln 都建不了链接（需管理员或开发者模式）。实测 tar 解完是 0 链接 / 106 文件
  # 且提前中止；Python tarfile 走重解析点，普通用户即可，能解出 335 个链接。
  # 少了这些链接，initramfs 里 /bin/sh 就不存在，根本起不到 shell。
  python "$REPO_ROOT/tools/extract_archive.py" "$rfs" "$root" \
    || die "minirootfs 解压失败（extract_archive.py）"

  python "$REPO_ROOT/tools/make-initramfs.py" "$root" "$OUT_DIR/initramfs.cpio.gz" \
    || die "make-initramfs.py 失败"
  rm -rf "$root" "$root.modes.json"
  local csz; csz=$(stat -c %s "$OUT_DIR/initramfs.cpio.gz")
  [ "$csz" -gt 500000 ] || die "initramfs 太小（$csz B），大概率缺符号链接"
  log "  ✅ initramfs.cpio.gz  ($csz B)"
}

# ----------------------------------------------------------------------- 主流程

main() {
  log "TSIE 引导素材 bootstrap"
  log "仓库: $REPO_ROOT"
  log "输出: $OUT_DIR"
  echo
  bootstrap_opensbi
  echo
  bootstrap_edk2
  echo
  bootstrap_alpine
  echo
  log "全部完成。产物："
  ls -la "$OUT_DIR" | awk 'NR>3 && $5>0 {printf "  %12d B  %s\n", $5, $9}'

  local fw="$FW_DIR/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin"
  local rel_out="${OUT_DIR#$REPO_ROOT/}"
  cat <<EOF

引导命令（在仓库根执行）：

  # Alpine + OpenSBI（到 BusyBox shell）
  # ⚠️ 必须带 earlycon=sbi：Alpine 内核编了 SBI earlycon 驱动，有它约 150M 指令内
  #    就能看到输出；没有它内核会把 printk 攒在 ring buffer 里，直到 16550 控制台
  #    注册（约 350-400M 指令）才一次性倒出 —— 看起来像卡死。
  # ⚠️ 指令预算给足 1.5e9：完整引导需约 1.2e9 条（含 initramfs 解包）。
  npx tsx src/cli.ts \\
    --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin \\
    --kernel $rel_out/Image --initrd $rel_out/initramfs.cpio.gz \\
    --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats

  # EDK II (UEFI)：需要成对提供 CODE / VARS
  npx tsx src/cli.ts \\
    --flash-code $rel_out/RISCV_VIRT_CODE.fd \\
    --flash-vars $rel_out/RISCV_VIRT_VARS.fd

EOF
}

main
