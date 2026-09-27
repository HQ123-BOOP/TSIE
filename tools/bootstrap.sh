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
# EDK II 需要解 .deb（ar 归档）：系统自带的 bsdtar / 7-Zip 优先；都没有时会提示
# 「将从第三方仓库下载静态 bsdtar，按原样提供、无任何担保」，同意才下，拒绝即退出。
#
# 依赖（缺失时的后果已注明）：
#   必需  curl / tar / sha256sum   Git Bash 自带
#   必需  node + tsx               打 initramfs 用 tools/initramfs.ts，而 tsx 是
#                                  devDependency（先 npm install）。这一步**不经过磁盘**：
#                                  直接从 tar 头里读 mode/linkname 组装 cpio，所以
#                                  "Windows 建不了符号链接 / 存不住执行位"都不影响它。
#                                  已不再需要 Python。
#   可选  bsdtar / 7-Zip           只有 EDK II 需要：.deb 是 **ar 归档**，而 Git Bash 的
#                                  GNU tar **不支持 ar**。系统里已有就免下载（Windows
#                                  自带的 C:\Windows\System32\tar.exe 就是 bsdtar）；
#                                  都没有时会征求同意，从第三方仓库拉一份静态 bsdtar
#                                  到临时目录，**用完即删**。
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
    -h|--help)   sed -n '2,41p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1"; }
# 注意：**不检查 xz**。OpenSBI 是 .tar.xz，但 `tar -xf` 自己会经 liblzma 解压，
# 不需要独立的 xz 命令（实测 GNU tar 1.35 直接解开）。ps1 侧同理，从未依赖它。
for c in curl tar sha256sum node; do need "$c"; done
# 不再依赖 Python：initramfs 由 tools/initramfs.ts 直接 tar→cpio（见下），复用项目
# 自己的工具链 —— tsx 本来就在 devDependencies 里，跑模拟器也要用它。
# 提前检查，别等下载完 70 MB 才报缺工具。
TSX="$REPO_ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || die "缺少 tsx（$TSX）—— 请先在仓库根执行 npm install"

# ------------------------------------------------- EDK II 的 ar 拆包工具选择
#
# .deb 是 **ar 归档**（魔数 `!<arch>`），不是 tar 也不是 zip。本机没有 ar/dpkg-deb。
# 关键事实（实测，别再凭印象）：
#   * Git Bash 的 `tar` 是 **GNU tar 1.35 → 不支持 ar**，用它解 .deb 必报错。
#   * **Windows 自带的 bsdtar（libarchive 3.8.8）支持 ar**，且能一路穿透内层 data.tar.xz。
#     它在 PATH 里被 Git 的 tar 遮蔽（同名 tar.exe），必须按绝对路径调用。
#     实测产物与 7-Zip 逐字节一致（两个 .fd 的 sha256 相同）。
#   * 7-Zip 也能做；macOS / FreeBSD 的 /usr/bin/tar 本身就是 bsdtar。
#
# 三档策略，越靠前代价越小：
#   ① 系统已有 bsdtar  → 直接用，不下载（本机命中 Windows 自带那个）
#   ② 系统已有 7-Zip   → 直接用，不下载
#   ③ 都没有           → 征求同意后从第三方仓库下静态 bsdtar 到临时目录，用完即删
#
# 谁能用一律由**实读一次 .deb** 判定，不看名字（PATH 里有两个同名 tar.exe）。
AR_TOOL=""
AR_TOOL_IS_7ZIP=0
BORROWED_DIR=""          # 下载来的 bsdtar 所在临时目录，退出时删除
MIRROR_OK=""             # 本轮是否已就"用镜像"取得同意（问过一次就不再问）

is_7zip() { case "$(basename "$1")" in 7z|7z.exe|7za|7za.exe) return 0 ;; *) return 1 ;; esac; }

build_ar_candidates() {
  local sysroot="${SYSTEMROOT:-C:\\Windows}" p
  # SYSTEMROOT 在 MSYS 下是 Windows 形式（C:\Windows），转成 MSYS 路径再拼
  command -v cygpath >/dev/null 2>&1 && sysroot="$(cygpath -u "$sysroot" 2>/dev/null || echo "$sysroot")"
  AR_CANDIDATES=(
    "${sysroot}/System32/tar.exe"      # Windows 自带 bsdtar（libarchive）
    "/c/Windows/sysnative/tar.exe"     # 32 位进程下的 64 位视图
  )
  # PATH 里的 bsdtar / tar（macOS 与 FreeBSD 的 /usr/bin/tar 本身就是 bsdtar；
  # Git Bash 的 tar 是 GNU tar，会在探测里被淘汰）
  for p in "$(command -v bsdtar 2>/dev/null || true)" \
           "$(command -v tar 2>/dev/null || true)" \
           "/c/Program Files/7-Zip/7z.exe" \
           "/c/Program Files (x86)/7-Zip/7z.exe" \
           "$(command -v 7z 2>/dev/null || true)" \
           "$(command -v 7za 2>/dev/null || true)"; do
    [ -n "$p" ] && AR_CANDIDATES+=("$p")
  done
  return 0
}

# 用真实的 .deb 试读，并且要求**列出 data.tar 成员** —— 这才证明它真懂 ar。
# GNU tar 会在这里失败（".deb 不像 tar 归档"），正是我们要区分掉的。
#
# ⚠️ 语法不同，不能用同一套旗标探测：tar/bsdtar 是 `-tf`，**7-Zip 是 `l`**。
# 早先用 `-tf` 去测 7z，把它误判成"读不了 ar"（实测踩过）。
probe_ar_tool() {  # probe_ar_tool <候选> <deb>；成功则设好 AR_TOOL / AR_TOOL_IS_7ZIP
  local bin="$1" deb="$2"
  [ -n "$bin" ] || return 1
  [ -x "$bin" ] || command -v "$bin" >/dev/null 2>&1 || return 1
  if is_7zip "$bin"; then
    "$bin" l "$deb" 2>/dev/null | grep -q 'data\.tar' || return 1
    AR_TOOL_IS_7ZIP=1
  else
    "$bin" -tf "$deb" 2>/dev/null | grep -q 'data\.tar' || return 1
    AR_TOOL_IS_7ZIP=0
  fi
  AR_TOOL="$bin"
  return 0
}

find_local_ar_tool() {  # ①②档：系统里已有的工具
  local bin
  for bin in "${AR_CANDIDATES[@]}"; do
    if probe_ar_tool "$bin" "$1"; then
      log "  拆包工具: $(basename "$AR_TOOL")（系统已有，无需下载）"
      return 0
    fi
  done
  return 1
}

# ------------------------------------------------- ③ 第三方静态 bsdtar（兜底）
#
# 仓库：https://github.com/probonopd/static-tools（continuous 连续构建，Linux 静态二进制）
# 资产名按架构选。注意 i686 的是 **bsdtar-i686** —— 同一个 release 里还有个
# desktop-file-install-i686，那是另一个工具，别拿错。
BSDTAR_BASE="https://github.com/probonopd/static-tools/releases/download/continuous"

bsdtar_asset() {
  case "$(uname -m)" in
    x86_64|amd64)        echo bsdtar-x86_64 ;;
    aarch64|arm64)       echo bsdtar-aarch64 ;;
    armv7l|armv6l|armhf) echo bsdtar-armhf ;;
    i386|i486|i586|i686) echo bsdtar-i686 ;;
    *) return 1 ;;
  esac
}

acquire_bsdtar() {  # acquire_bsdtar <deb>；成功则设好 AR_TOOL / BORROWED_DIR
  # MSYS / Cygwin 执行不了 Linux ELF：与其白下 6.6 MB，不如直接说清楚
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      warn "  系统里没有能解 ar 的工具，而该 release 提供的是 **Linux 静态二进制**，"
      warn "  在 MSYS/Cygwin 下无法执行。Windows 10 1803+ 自带"
      warn "  C:\\Windows\\System32\\tar.exe（bsdtar），请确认它还在。"
      return 1 ;;
  esac

  local asset
  asset="$(bsdtar_asset)" || { warn "  未知架构 $(uname -m)，不知道该取哪个 bsdtar 资产"; return 1; }

  echo
  warn "缺少能解 ar 的拆包工具（.deb 是 ar 归档，GNU tar 不支持它）。"
  warn "打算从**第三方仓库**下载一份静态编译的 bsdtar："
  warn "    https://github.com/probonopd/static-tools   →   $asset"
  warn "该二进制由第三方构建，**按原样（AS IS）提供，不附带任何担保**，"
  warn "本项目未审计也不为其背书；若 GitHub 直连不通，会经镜像站（gh-proxy.org）"
  warn "转发，同样属于第三方。它只用于解 EDK II 的 .deb，用完立即删除。"
  printf '是否继续下载？[y/N] '
  local ans=""; read -r ans || true
  case "$ans" in
    y|Y|yes|YES) ;;
    *) die "已取消：没有拆包工具，EDK II 无法获取（想去掉这一步请用 --no-edk2）" ;;
  esac
  MIRROR_OK=yes   # 上面的提示已说明镜像用途，不再重复询问

  BORROWED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tsie-bsdtar.XXXXXX")" || return 1
  local bin="$BORROWED_DIR/bsdtar" url="$BSDTAR_BASE/$asset" ok=0
  # 先探一次直连再决定：直接 hard 试 fetch 的话，不通时要磨完 10 轮重试才轮到镜像
  if probe_url_bytes "$url"; then
    log "  直连可用，下载 $asset（约 6.6 MB）..."
    fetch "$bin" "" "$url" && ok=1 || true
  else
    warn "  GitHub 直连不通"
  fi
  if [ "$ok" = 0 ] && pick_mirror "$url"; then
    log "  改走镜像下载 $asset..."
    fetch "$bin" "" "${GITHUB_PROXY}${url}" && ok=1 || true
  fi
  [ "$ok" = 1 ] || { warn "  bsdtar 下载失败"; return 1; }

  chmod +x "$bin" 2>/dev/null || true
  if ! probe_ar_tool "$bin" "$1"; then
    warn "  下载到的 bsdtar 无法使用（架构不符？）"
    return 1
  fi
  log "  拆包工具: 临时 bsdtar ($bin)"
  return 0
}

cleanup_borrowed() {
  if [ -n "$BORROWED_DIR" ] && [ -d "$BORROWED_DIR" ]; then
    rm -rf "$BORROWED_DIR"
    log "已删除临时 bsdtar"
  fi
  return 0
}
# ⚠️ 只写 EXIT 不够：Ctrl-C（SIGINT）与 SIGTERM 默认**不触发** EXIT trap，
# 临时目录会留在 /tmp 里。所以三个信号都要接，再接回 EXIT 做真正的清理。
trap cleanup_borrowed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

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
OPENSBI_PROBE_URL="https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz"

# 直连探测：只看能否**真取到字节**。
# ⚠️ HEAD 能通不代表能下载：本机 github.com 一直答得好好的，302 之后的
# objects.githubusercontent.com 才是真正超时的那个。所以这里取前 1 KiB 试读。
probe_url_bytes() {  # probe_url_bytes <url>
  curl -fsSL -o /dev/null --max-time 25 -4 --noproxy '*' -r 0-1023 "$1" 2>/dev/null
}

probe_github_release() { probe_url_bytes "$OPENSBI_PROBE_URL"; }

pick_mirror() {  # pick_mirror [用于测速的 URL，默认 OpenSBI 资产]
  [ "$MIRROR_MODE" = "no" ] && return 1
  local u="${1:-$OPENSBI_PROBE_URL}" best="" best_speed=0 name speed
  if [ "$MIRROR_MODE" = "ask" ] && [ -z "$MIRROR_OK" ]; then
    echo
    warn "GitHub release 资产直连不通。"
    warn "镜像站（gh-proxy.org）会转发 GitHub 内容，理论上可被中间方替换 —— 属于信任边界变更。"
    printf '是否允许使用镜像站？[y/N] '
    local ans=""; read -r ans || true
    case "$ans" in y|Y|yes|YES) MIRROR_OK=yes ;; *) return 1 ;; esac
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

  # 拆 ar 容器：先看系统里已有的（①bsdtar ②7-Zip），都没有才谈下载（③）。
  if ! find_local_ar_tool "$deb"; then
    acquire_bsdtar "$deb" || { warn "  没有可用的拆包工具，跳过 EDK II"; return 0; }
  fi

  local x="$OUT_DIR/.deb-x"
  rm -rf "$x"; mkdir -p "$x"
  # bsdtar 与 7z 的调用语法不同：bsdtar 是 -xf ... -C，7z 是 x -y -o<dir>
  if [ "$AR_TOOL_IS_7ZIP" = 1 ]; then
    log "  拆包（7-Zip）..."
    "$AR_TOOL" x -y -o"$x" "$deb" >/dev/null 2>&1 || die "7-Zip 解 .deb 失败"
  else
    log "  拆包（bsdtar）..."
    "$AR_TOOL" -xf "$deb" -C "$x" 2>/dev/null || die "bsdtar 解 .deb 失败"
  fi

  # 内层可能是 data.tar / data.tar.xz（Debian 上游用 xz）
  local data; data="$(ls "$x"/data.tar* 2>/dev/null | head -1)"
  [ -n "$data" ] || die "未在 .deb 里找到 data.tar*"
  case "$data" in
    *.zst)
      # GNU tar 未必编了 zstd，这一步交给 bsdtar（libarchive 带 zstd）
      [ "$AR_TOOL_IS_7ZIP" = 0 ] || die "内层是 zstd，7-Zip 主路径处理不了，请装 bsdtar"
      log "  解内层 $(basename "$data")（bsdtar）..."
      "$AR_TOOL" -xf "$data" -C "$x" ./usr/share/qemu-efi-riscv64/ 2>/dev/null \
        || die "解内层 $(basename "$data") 失败"
      ;;
    *)
      # .tar / .tar.gz / .tar.xz：**GNU tar 自己能解**（经 liblzma / zlib），
      # 不需要 ar 工具 —— 它只是读不了外层的 ar 而已。
      log "  解内层 $(basename "$data")..."
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

  log "  打成 cpio-newc initramfs（tools/initramfs.ts）..."
  verify_archive "$rfs" -z \
    || die "minirootfs 下载不完整（完整解压校验失败）—— 删掉重跑"

  # ⚠️ 这一步**不经过磁盘**：initramfs.ts 直接从 tar 头里读 mode 与 linkname，
  # 在内存里组装 cpio。原因见该文件头部的长注释 —— 一旦落盘，Windows 上符号链接
  # 建不出来（要提权）、执行位也存不住（内核 execve 报 EACCES，起不到 init）。
  # 顺带好处：不再解出一棵 7 MB 的树再走一遍磁盘，也少一个 .modes.json 中间文件。
  "$TSX" "$REPO_ROOT/tools/initramfs.ts" alpine "$rfs" "$OUT_DIR/initramfs.cpio.gz" \
    || die "initramfs 打包失败（tools/initramfs.ts alpine）"
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
