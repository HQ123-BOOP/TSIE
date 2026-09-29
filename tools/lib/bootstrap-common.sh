#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
#
# 三个引导脚本的共享实现（**不是**可执行入口，只被 source）：
#
#   tools/bootstrap-direct.sh    OpenSBI fw_jump 直接跳转内核
#   tools/bootstrap-uboot.sh     OpenSBI → U-Boot → 内核（U-Boot 自己从 FAT 盘上拉）
#   tools/bootstrap-edk2.sh      EDK II (UEFI) 固件 + ESP（UEFI 里把 Linux 拉起来）
#
# 入口脚本只负责：声明这条引导路要哪些素材、按什么顺序取、最后打印哪几条引导命令。
# 取素材的机制（下载重试 / 镜像 / ar 拆包 / cpio / FAT）与文案都写在这里，只有一份。
#
# 设计约定（照着改之前先读）：
#   * 版本号一律动态发现，不硬编码。Alpine 的包更新很快，写死的 URL 会 404
#     （README 里那个 linux-lts-6.18.44 在 2026-09-26 就已经是 404）。
#   * 所有产物落在 gitignored 目录（`firmware/`、`tmp/`），不得入库：
#     这些是 GPL-2.0 / 第三方产物，本项目是 Apache-2.0。
#   * 下载全部带重试。本机网络对 dl-cdn / deb.debian.org 是间歇性可达的，
#     同一个域名前一刻成功、后一刻 21 秒超时，不带重试必然随机失败。
#   * GitHub release 资产直连不通（github.com 能到，但 302 之后的
#     objects.githubusercontent.com 超时），所以需要镜像。镜像属代理转发，
#     脚本会先征求同意（--mirror 可预先授权）。
#
# EDK II / U-Boot 都要解 .deb（ar 归档）：系统自带的 bsdtar / 7-Zip 优先；都没有时
# 会提示「将从第三方仓库下载静态 bsdtar，按原样提供、无任何担保」，同意才下，拒绝即退出。
#
# 依赖（缺失时的后果已注明）：
#   必需  curl / tar / sha256sum   Git Bash 自带
#   必需  node + tsx               打 initramfs 用 tools/initramfs.ts，而 tsx 是
#                                  devDependency（先 npm install）。这一步不经过磁盘：
#                                  直接从 tar 头里读 mode/linkname 组装 cpio，所以
#                                  "Windows 建不了符号链接 / 存不住执行位"都不影响它。
#                                  已不再需要 Python。
#   可选  bsdtar / 7-Zip           只有解 .deb 需要：它是 ar 归档，而 Git Bash 的
#                                  GNU tar 不支持 ar。系统里已有就免下载（Windows
#                                  自带的 C:\Windows\System32\tar.exe 就是 bsdtar）；
#                                  都没有时会征求同意，从第三方仓库拉一份静态 bsdtar
#                                  到临时目录，用完即删。
#   不需要 xz                      OpenSBI 是 .tar.xz，但 tar 自己经 liblzma 解压。
#
# 用法文本在 tools/i18n/usage.<入口名>.<语言>.txt，由入口脚本用 bs_print_usage 打印。

set -euo pipefail

# 本文件在 tools/lib/ 下，仓库根是再上两级
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/tmp/boot"
FW_DIR="$REPO_ROOT/firmware"
# Alpine 分支：默认用 latest-stable 别名 —— 语义正确，且不会随发行版推进而失效。
# （曾想自己算"最高版本号"，但那既多余又有 bug：v4.0 编码成 4000 会小于 v3.24 的 3024。）
# 需要固定分支时用 --alpine v3.24。
ALPINE_BRANCH="latest-stable"

MIRROR_MODE="ask"     # ask | yes | no
DECOMPRESS="ask"      # ask | yes | no：是否额外产出一份未压缩 initramfs
DO_EDK2=1
INITRD_FILE="initramfs.cpio.gz"   # 最终推荐用哪一份引导（解压成功则换成 .cpio）
EDK2_CODE_FILE="RISCV_VIRT_CODE.fd"   # EDK II 那条路用哪份 CODE 固件（剥过 LZMA 则换成 .nocomp.fd）

# ---------------------------------------------------------------- 语言 / i18n
#
# 文案表是**单一来源**：tools/i18n/messages.tsv（key<TAB>zh<TAB>en）。
# 选 TSV 是因为三种语言都能零依赖读它 —— bash 没有内置 JSON 解析器，引 jq 就多一个依赖；
# 而成对维护两份内联文案，迟早会漂移。
MSG_FILE="$REPO_ROOT/tools/i18n/messages.tsv"
declare -A MSG

# 跟随系统区域：明确是英文区域就说英文，其余（含认不出来）一律中文 ——
# 本项目的文档与注释以中文为主，认不出来时中文是更合理的默认。
detect_lang() {
  case "${LC_ALL:-}${LC_MESSAGES:-}${LANG:-}" in
    *[Ee][Nn]*) echo en ;;
    *)          echo zh ;;
  esac
}

load_messages() {  # load_messages <zh|en>
  local lang="$1" key zh en
  MSG=()
  while IFS=$'	' read -r key zh en || [ -n "$key" ]; do
    case "$key" in ''|\#*) continue ;; esac
    [ -n "$en" ] || en="$zh"
    if [ "$lang" = "en" ]; then MSG["$key"]="$en"; else MSG["$key"]="$zh"; fi
  done < "$MSG_FILE"
}

# msg <key> [参数...]：取当前语言的文案，替换 {0}{1}…，并把字面 \n 变成真换行。
msg() {
  local key="$1"; shift
  local s="${MSG[$key]:-$key}" i=0
  s="${s//\\n/$'\n'}"
  for a in "$@"; do s="${s//\{$i\}/$a}"; i=$((i + 1)); done
  printf '%s' "$s"
}

# 先按环境/区域预加载：参数解析阶段就可能报错（未知参数），那时也得有文案。
LANG_SEL="${TSIE_LANG:-$(detect_lang)}"
load_messages "$LANG_SEL"

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
# 前缀本身也走文案表：写死「警告:」的话，英文运行里会突然冒出一句中文
warn() { printf '\033[33m%s\033[0m %s\n' "$(msg warn.prefix)" "$*" >&2; }
die()  { printf '\033[31m%s\033[0m %s\n' "$(msg error.prefix)" "$*" >&2; exit 1; }

# 用法文本也是双语的，每个入口各一份（长文本塞进 TSV 的单元格里可读性太差）。
# BOOT_PATH 由入口脚本在 source 之前设好（direct / uboot / edk2）。
bs_print_usage() {
  local f="$REPO_ROOT/tools/i18n/usage.${BOOT_PATH:-direct}.$LANG_SEL.txt"
  [ -f "$f" ] || die "$(msg common.noUsage "$f")"
  cat "$f"
}

# 公共参数解析：入口脚本在**自己的** case 里对认不出来的参数调用它。
#   bs_arg_common "$@"   →  认得就处理并设 BS_CONSUMED（1 或 2），返回 0；不认得返回 1。
# 用 BS_CONSUMED 而不是在函数里 shift：bash 的函数改不了调用者的位置参数。
bs_arg_common() {
  BS_CONSUMED=1
  case "$1" in
    --mirror)    MIRROR_MODE="yes" ;;
    --no-mirror) MIRROR_MODE="no" ;;
    --alpine)    ALPINE_BRANCH="$2"; BS_CONSUMED=2 ;;
    --dir)       OUT_DIR="$2"; BS_CONSUMED=2 ;;
    --lang)      # 立即校验并重载：这样「--lang en 后面跟个错参数」报的也是英文
                 case "${2:-}" in
                   zh|en) LANG_SEL="$2"; load_messages "$LANG_SEL" ;;
                   *) die "$(msg i18n.badLang "${2:-}")" ;;
                 esac
                 BS_CONSUMED=2 ;;
    -h|--help)   BS_DO_HELP=1 ;;   # 真打印在语言确定之后（否则 --lang en --help 会打成中文）
    *) return 1 ;;
  esac
  return 0
}

# 参数解析收尾：定语言、导出给子进程、需要就打用法。入口在自己循环结束后调用一次。
bs_args_done() {
  # 语言来源优先级：--lang > TSIE_LANG > 系统区域
  LANG_SEL="${LANG_SEL:-${TSIE_LANG:-}}"
  case "$LANG_SEL" in
    en|zh) ;;
    "") LANG_SEL="$(detect_lang)" ;;
    *) die "$(msg i18n.badLang "$LANG_SEL")" ;;
  esac
  load_messages "$LANG_SEL"

  # 导给子进程（tools/initramfs.ts 等）：它们按同一张表输出，免得中英混着打。
  # 这里也顺带覆盖掉用户环境里可能已有的 TSIE_LANG —— 以本次选定的语言为准。
  export TSIE_LANG="$LANG_SEL"

  if [ "${BS_DO_HELP:-0}" = 1 ]; then
    bs_print_usage
    exit 0
  fi
}

# 依赖检查与目录准备。入口解析完参数、确定要干活之后调用一次。
bs_init() {
  need() { command -v "$1" >/dev/null 2>&1 || die "$(msg common.missingCmd "$1")"; }
  # 注意：不检查 xz。OpenSBI 是 .tar.xz，但 `tar -xf` 自己会经 liblzma 解压，
  # 不需要独立的 xz 命令（实测 GNU tar 1.35 直接解开）。ps1 侧同理，从未依赖它。
  for c in curl tar sha256sum node; do need "$c"; done
  # 不再依赖 Python：initramfs 由 tools/initramfs.ts 直接 tar→cpio（见下），复用项目
  # 自己的工具链 —— tsx 本来就在 devDependencies 里，跑模拟器也要用它。
  # 提前检查，别等下载完 70 MB 才报缺工具。
  TSX="$REPO_ROOT/node_modules/.bin/tsx"
  [ -x "$TSX" ] || die "$(msg common.missingTsx "$TSX")"

  mkdir -p "$OUT_DIR" "$FW_DIR"
  build_ar_candidates
}

# ------------------------------------------------- EDK II 的 ar 拆包工具选择
#
# 注意 .deb 是 ar 归档（魔数 `!<arch>`），不是 tar 也不是 zip。本机没有 ar/dpkg-deb。
# 关键事实（实测，别再凭印象）：
#   * Git Bash 的 `tar` 是 GNU tar 1.35 → 不支持 ar，用它解 .deb 必报错。
#   * Windows 自带的 bsdtar（libarchive 3.8.8）支持 ar，且能一路穿透内层 data.tar.xz。
#     它在 PATH 里被 Git 的 tar 遮蔽（同名 tar.exe），必须按绝对路径调用。
#     实测产物与 7-Zip 逐字节一致（两个 .fd 的 sha256 相同）。
#   * 7-Zip 也能做；macOS / FreeBSD 的 /usr/bin/tar 本身就是 bsdtar。
#
# 三档策略，越靠前代价越小：
#   ① 系统已有 bsdtar  → 直接用，不下载（本机命中 Windows 自带那个）
#   ② 系统已有 7-Zip   → 直接用，不下载
#   ③ 都没有           → 征求同意后从第三方仓库下静态 bsdtar 到临时目录，用完即删
#
# 谁能用一律由实读一次 .deb 判定，不看名字（PATH 里有两个同名 tar.exe）。
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

# 用真实的 .deb 试读，并且要求列出 data.tar 成员 —— 这才证明它真懂 ar。
# GNU tar 会在这里失败（".deb 不像 tar 归档"），正是我们要区分掉的。
#
# 语法不同，不能用同一套旗标探测：tar/bsdtar 是 `-tf`，7-Zip 是 `l`。
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
      log "  $(msg ar.toolSystem "$(basename "$AR_TOOL")")"
      return 0
    fi
  done
  return 1
}

# ------------------------------------------------- ③ 第三方静态 bsdtar（兜底）
#
# 仓库：https://github.com/probonopd/static-tools（continuous 连续构建，Linux 静态二进制）
# 资产名按架构选。注意 i686 的是 bsdtar-i686 —— 同一个 release 里还有个
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
      warn "  $(msg ar.msysNoElf)"
      return 1 ;;
  esac

  local asset
  asset="$(bsdtar_asset)" || { warn "  $(msg ar.unknownArch "$(uname -m)")"; return 1; }

  echo
  warn "$(msg ar.consent "https://github.com/probonopd/static-tools   →   $asset")"
  printf '%s ' "$(msg ar.consentAsk)"
  local ans=""; read -r ans || true
  case "$ans" in
    y|Y|yes|YES) ;;
    *) die "$(msg ar.cancelled)" ;;
  esac
  MIRROR_OK=yes   # 上面的提示已说明镜像用途，不再重复询问

  BORROWED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tsie-bsdtar.XXXXXX")" || return 1
  local bin="$BORROWED_DIR/bsdtar" url="$BSDTAR_BASE/$asset" ok=0
  # 先探一次直连再决定：直接 hard 试 fetch 的话，不通时要磨完 10 轮重试才轮到镜像
  if probe_url_bytes "$url"; then
    log "  $(msg ar.directOk "$asset")"
    fetch "$bin" "" "$url" && ok=1 || true
  else
    warn "  $(msg ar.directDown)"
  fi
  if [ "$ok" = 0 ] && pick_mirror "$url"; then
    log "  $(msg ar.viaMirror "$asset")"
    fetch "$bin" "" "${GITHUB_PROXY}${url}" && ok=1 || true
  fi
  [ "$ok" = 1 ] || { warn "  $(msg ar.downloadFailed)"; return 1; }

  chmod +x "$bin" 2>/dev/null || true
  if ! probe_ar_tool "$bin" "$1"; then
    warn "  $(msg ar.unusable)"
    return 1
  fi
  log "  $(msg ar.toolBorrowed "$bin")"
  return 0
}

cleanup_borrowed() {
  if [ -n "$BORROWED_DIR" ] && [ -d "$BORROWED_DIR" ]; then
    rm -rf "$BORROWED_DIR"
    log "$(msg ar.cleaned)"
  fi
  return 0
}
# 只写 EXIT 不够：Ctrl-C（SIGINT）与 SIGTERM 默认不触发 EXIT trap，
# 临时目录会留在 /tmp 里。所以三个信号都要接，再接回 EXIT 做真正的清理。
trap cleanup_borrowed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------- 下载（重试 + 续传 + 多源）

# 本机网络有三个特点，fetch 必须同时应付：
#   1. 间歇性可达 —— 同一域名前一刻成功、后一刻 21s 超时；必须退避重试。
#   2. 会中途掉速 —— 实测 22 MB 的内核在 45 KB/s 与 5 KB/s 之间摆（差 9 倍），
#      纯重试会从 0 重来，前功尽弃。故用 `-C -` 断点续传。
#   3. 多源快慢不一 —— 故接受多个 URL 候选，逐个试，谁快谁上。

# 权威文件大小：必须跟随重定向取最终响应的 Content-Length。
#
# 这里踩过一个严重坑：早先写成 `curl -I`（不带 -L），拿到的是重定向源站的
# Content-Length —— dl-cdn 返回 15501313（rc 页面大小），而真实文件是 22001665。
# 于是"续传到 14.5 MB"被误判为下载完成，直到 `tar -xzf` 才炸。
# 静默地把残缺文件当成品交给下一步，是这个脚本最危险的失败模式。
remote_size() {
  curl -fsSLI --max-time 30 -4 --noproxy '*' "$1" 2>/dev/null \
    | grep -i '^content-length' | tail -1 | tr -d '\r' | awk '{print $2}'
}

# 提前验证归档数据完整（不只是能列目录）。
#
# 关键区别，踩过：`tar -tzf` 只读文件表、不解压数据流，所以残缺文件也能列出。
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

  # 源一致性：`.part` 可能来自另一个源（上一次运行走的是镜像）。
  # 不同源的字节流不能拼接 —— 曾因此产出"大小对得上但内容损坏"的文件。
  # 换源就从 0 重来（宁可慢，不可错）。
  if [ -s "$part" ]; then
    local prev=""
    [ -f "$part.src" ] && prev="$(cat "$part.src" 2>/dev/null || true)"
    if [ "$prev" != "$url" ]; then
      warn "    $(msg fetch.crossSource)"
      rm -f "$part" "$part.src"
    fi
  fi
  printf '%s' "$url" > "$part.src"

  if [ -z "$total" ]; then
    warn "    $(msg fetch.noSize)"
  else
    log "    $(msg fetch.size "$total")"
  fi

  local i have
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsSL -C - --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 \
         -4 --noproxy '*' -o "$part" "$url" || true
    if [ ! -s "$part" ]; then
      warn "    $(msg fetch.retry "$i" "$((i*3))")"
      sleep $((i*3)); continue
    fi
    have=$(stat -c %s "$part")
    if [ -n "$total" ] && [ "$have" -eq "$total" ]; then
      mv -f "$part" "$out"; rm -f "$part.src"; return 0
    fi
    if [ -n "$total" ] && [ "$have" -gt "$total" ]; then
      # 超出声明大小 = 拼接污染或服务端变了；重下而不是硬用
      warn "    $(msg fetch.oversize "$have" "$total")"
      rm -f "$part"; continue
    fi
    if [ -z "$total" ]; then
      mv -f "$part" "$out"; rm -f "$part.src"; return 0
    fi
    warn "    $(msg fetch.progress "$have" "$total" "$(awk "BEGIN{printf \"%.0f\", $have*100/$total}")")"
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
      log "$(msg fetch.exists "$(basename "$out")")"; return 0
    fi
    warn "$(msg fetch.existsBad "$(basename "$out")")"
    rm -f "$out"
  fi
  [ -f "$out.part" ] && log "  $(msg fetch.hasPartial)"

  local url
  for url in "$@"; do
    log "  $(msg fetch.source "$(echo "$url" | cut -d/ -f3)")"
    if fetch_one "$url" "$out"; then
      if [ -n "$want" ]; then
        local got; got="$(sha256sum "$out" | cut -d' ' -f1)"
        if [ "$got" != "$want" ]; then
          warn "  $(msg fetch.shaMismatch "$want" "$got")"
          rm -f "$out"; continue
        fi
        log "  $(msg fetch.verified "$(basename "$out")")"
      fi
      return 0
    fi
    warn "  $(msg fetch.sourceFailed "$(echo "$url" | cut -d/ -f3)")"
  done
  rm -f "$out.part"
  return 1
}

# ---------------------------------------------------- Alpine 源

ARCH="riscv64"
#
# 官方 dl-cdn 是本机唯一稳定可用的 Alpine 源；国内镜像对 v3.24 普遍未同步（实测
# 清华 403、阿里/南大/上交/华为 404）。所以镜像只作为官方源失败时的兜底，
# 不指望它更快。多一个源就自动获得"换源重试"，且校验值仍取自官方 manifest。
ALPINE_MIRROR="https://mirrors.ustc.edu.cn/alpine"

# ---------------------------------------------------- GitHub 直连探测 / 镜像选择

GITHUB_PROXY=""
OPENSBI_PROBE_URL="https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz"

# 直连探测：只看能否真取到字节。
# HEAD 能通不代表能下载：本机 github.com 一直答得好好的，302 之后的
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
    warn "$(msg mirror.directDown)"
    warn "$(msg mirror.trustNote)"
    printf '%s ' "$(msg mirror.ask)"
    local ans=""; read -r ans || true
    case "$ans" in y|Y|yes|YES) MIRROR_OK=yes ;; *) return 1 ;; esac
  fi
  log "$(msg mirror.probing)"
  for name in v4 v6; do
    speed=$(curl -fsSL -o /dev/null --max-time 30 -4 --noproxy '*' -r 0-1048575 \
      -w '%{speed_download}' "https://${name}.gh-proxy.org/${u}" 2>/dev/null || echo 0)
    speed=${speed%.*}
    printf '    %-4s %s B/s\n' "$name" "${speed:-0}"
    if [ "${speed:-0}" -gt "$best_speed" ]; then best_speed="$speed"; best="$name"; fi
  done
  [ -n "$best" ] || return 1
  GITHUB_PROXY="https://${best}.gh-proxy.org/"
  log "$(msg mirror.chosen "${best}.gh-proxy.org" "$best_speed")"
  return 0
}

# ---------------------------------------------------------------- ① OpenSBI 固件

bootstrap_opensbi() {
  local rel="riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz"
  local url="https://github.com/${rel}"
  local tarball="$FW_DIR/opensbi-1.9-rv-bin.tar.xz"

  if [ -f "$FW_DIR/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin" ]; then
    log "  $(msg opensbi.exists "firmware/opensbi-1.9-rv-bin/.../fw_jump.bin")"
    return 0
  fi

  # 直连优先；失败再走镜像（镜像需授权）。授权被拒则回退本地文件。
  local ok=0
  if probe_github_release; then
    log "  $(msg opensbi.directOk)"
    fetch "$tarball" "" "$url" && ok=1 || true
  else
    warn "  $(msg opensbi.directDown)"
  fi
  if [ "$ok" = 0 ]; then
    if pick_mirror; then
      fetch "$tarball" "" "${GITHUB_PROXY}${url}" && ok=1 || true
    fi
  fi
  if [ "$ok" = 0 ]; then
    warn "  $(msg opensbi.cantDownload)"
    warn "  $(msg opensbi.manualHint "$tarball" "$url")"
    warn "  $(msg opensbi.manualHint2 "$FW_DIR/")"
    die "$(msg opensbi.failed)"
  fi

  log "  $(msg opensbi.extracting)"
  verify_archive "$tarball" \
    || die "$(msg opensbi.badArchive)"
  tar -xf "$tarball" -C "$FW_DIR"
  local fw="$FW_DIR/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin"
  [ -f "$fw" ] || die "$(msg opensbi.noFwJump)"
  log "  $fw"
}

# --------------------------------------------------------------- ② EDK II 固件

bootstrap_edk2() {
  [ "$DO_EDK2" = 1 ] || { log "  $(msg edk2.skipped)"; return 0; }

  # Debian 的 qemu-efi-riscv64 包里就是 32 MiB 的 CODE + VARS，尺寸天然合规。
  # 版本号动态取（池目录里可能有多个版本，取最新的）。
  local pool="https://deb.debian.org/debian/pool/main/e/edk2/"
  local deb_name
  deb_name=$(fetch_text "$pool" 2>/dev/null \
    | grep -oE 'qemu-efi-riscv64_[^"]*_all\.deb' | sort -u | tail -1) || true
  [ -n "$deb_name" ] || { warn "  $(msg edk2.noListing)"; return 0; }
  log "  $(msg edk2.latest "$deb_name")"

  local deb="$OUT_DIR/$deb_name"
  fetch "$deb" "" "$pool$deb_name" || { warn "  $(msg edk2.downloadFailed)"; return 0; }

  deb_unpack "$deb" './usr/share/qemu-efi-riscv64/' || { warn "  $(msg edk2.noTool)"; return 0; }

  local src="$DEB_X/usr/share/qemu-efi-riscv64"
  local f
  for f in RISCV_VIRT_CODE.fd RISCV_VIRT_VARS.fd; do
    [ -f "$src/$f" ] || die "$(msg edk2.notFound "$f")"
    cp -f "$src/$f" "$OUT_DIR/$f"
    local sz; sz=$(stat -c %s "$OUT_DIR/$f")
    log "  $f  ($sz B = $(awk "BEGIN{printf \"%.2f\", $sz/1048576}") MiB)"
    # EDK II 强制要求两块各 32 MiB，尺寸不对就别让用户拿到一个会在固件里报错的产物
    [ "$sz" -eq 33554432 ] || warn "  $(msg edk2.badSize)"
  done
  deb_cleanup

  # 固件卷里压着 LZMA，剥掉后引导快约 5 倍（实测 23 分钟 → 2.5 分钟）。剥出来的那份
  # 另存一个名字，原始产物留着（想对照或想自己试都行）。
  if [ "${DO_STRIP:-1}" = 1 ]; then
    strip_fv_lzma "$OUT_DIR/RISCV_VIRT_CODE.fd" "$OUT_DIR/RISCV_VIRT_CODE.nocomp.fd"
    EDK2_CODE_FILE="RISCV_VIRT_CODE.nocomp.fd"
  fi

  build_edk2_tramp "$OUT_DIR/edk2-tramp.bin"
}

# EDK II 要一段 8 字节跳板才跑得起来，别删（删了只会看到 OpenSBI banner，之后一片安静）：
#   * CLI 把 --kernel 装在 0x80200000 —— 那正是 OpenSBI fw_jump 的落点；
#   * 而 EDK II 固件在 pflash 0x20000000（真实 virt 机器也是这个布局，见机器的 VIRT_FLASH）；
#   * 两者之间差一次跳转，于是给 0x80200000 放两条指令把它接过去：
#       lui t0, 0x20000    ; 机器码 200002b7
#       jr  t0             ; 机器码 00028067（= jalr x0, 0(t0)）
# 为什么不让模拟器直接跳 flash：fw_jump 的落点是编译进 OpenSBI 的，改不了；
# 模拟器也不该为某一份固件特判一个地址。
build_edk2_tramp() {  # build_edk2_tramp <输出文件>
  printf '\xb7\x02\x00\x20\x67\x80\x02\x00' > "$1"
  log "  $(msg edk2.tramp "$(basename "$1")" "$(stat -c %s "$1")")"
}

# ------------------------------------------------------------ ③ Alpine 内核 + initramfs

bootstrap_alpine() {
  local main="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_BRANCH/main/$ARCH/"
  local rel="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_BRANCH/releases/$ARCH/"

  # --- 内核：从目录列表动态取最新 linux-lts（不硬编码版本）
  local apk
  apk=$(fetch_text "$main" 2>/dev/null \
    | grep -oE 'linux-lts-[0-9][^"]*\.apk' | sort -u | tail -1) || true
  [ -n "$apk" ] || die "$(msg alpine.noKernelList)"
  log "  $(msg alpine.kernel "$apk")"

  local apk_path="$OUT_DIR/$apk"
  local mirror_main="$ALPINE_MIRROR/$ALPINE_BRANCH/main/$ARCH/$apk"
  fetch "$apk_path" "" "$main$apk" "$mirror_main" \
    || die "$(msg alpine.kernelFailed)"

  log "  $(msg alpine.extractImage)"
  local t="$OUT_DIR/.apk-x"; rm -rf "$t"; mkdir -p "$t"
  verify_archive "$apk_path" -z \
    || die "$(msg alpine.badApk "$apk_path")"

  # 只解 `boot/`，不要整包解压。apk 里有个指向 `/boot/vmlinuz-lts` 的相对符号链接
  # （lib/modules/*/vmlinuz），Windows 上建不了，会让 tar 以退出码 2 结束并带上
  # "Cannot create symlink" —— 整个归档其实完好，只是那一条无关链接失败。
  # 只取需要的成员既避开这个坑，也少解 20 MB 的模块树。
  tar -xzf "$apk_path" -C "$t" boot/ 2>/dev/null \
    || die "$(msg alpine.apkUnpackFailed)"
  local vmz="$t/boot/vmlinuz-lts"
  [ -f "$vmz" ] || vmz="$(find "$t" -name 'vmlinuz*' | head -1)"
  [ -n "$vmz" ] || die "$(msg alpine.noVmlinuz)"
  gzip -dc "$vmz" > "$OUT_DIR/Image"
  rm -rf "$t"
  local isz; isz=$(stat -c %s "$OUT_DIR/Image")
  [ "$isz" -gt 1000000 ] || die "$(msg alpine.imageTooSmall "$isz")"
  log "  $(msg alpine.imageOk "$isz" "$(awk "BEGIN{printf \"%.1f\", $isz/1048576}")")"

  # --- initramfs：从 latest-releases.yaml 取 minirootfs（含官方 sha256 可校验）
  log "  $(msg alpine.readingYaml)"
  local yaml="$OUT_DIR/latest-releases.yaml"
  local mirror_yaml="$ALPINE_MIRROR/$ALPINE_BRANCH/releases/$ARCH/latest-releases.yaml"
  fetch "$yaml" "" "${rel}latest-releases.yaml" "$mirror_yaml" \
    || die "$(msg alpine.noYaml)"

  local rootfs sha
  rootfs=$(grep -oE 'alpine-minirootfs-[0-9][^"]*riscv64\.tar\.gz' "$yaml" | sort -u | tail -1)
  [ -n "$rootfs" ] || die "$(msg alpine.noRootfsEntry)"
  # 取该条目后面的 sha256（同一块里 file: 与 sha256: 相邻）
  sha=$(awk -v f="$rootfs" '
    $0 ~ "file: *"f {found=1}
    found && /sha256:/ {gsub(/.*sha256: */,""); print; exit}
  ' "$yaml")
  [ -n "$sha" ] || warn "  $(msg alpine.noSha)"
  log "  minirootfs: $rootfs"

  local rfs="$OUT_DIR/$rootfs"
  local mirror_rfs="$ALPINE_MIRROR/$ALPINE_BRANCH/releases/$ARCH/$rootfs"
  fetch "$rfs" "$sha" "${rel}${rootfs}" "$mirror_rfs" \
    || die "$(msg alpine.rootfsFailed)"

  log "  $(msg alpine.packing)"
  verify_archive "$rfs" -z \
    || die "$(msg alpine.rootfsIncomplete)"

  # 这一步不经过磁盘：initramfs.ts 直接从 tar 头里读 mode 与 linkname，
  # 在内存里组装 cpio。原因见该文件头部的长注释 —— 一旦落盘，Windows 上符号链接
  # 建不出来（要提权）、执行位也存不住（内核 execve 报 EACCES，起不到 init）。
  # 顺带好处：不再解出一棵 7 MB 的树再走一遍磁盘，也少一个 .modes.json 中间文件。
  "$TSX" "$REPO_ROOT/tools/initramfs.ts" alpine "$rfs" "$OUT_DIR/initramfs.cpio.gz" \
    || die "$(msg alpine.packFailed)"
  local csz; csz=$(stat -c %s "$OUT_DIR/initramfs.cpio.gz")
  [ "$csz" -gt 500000 ] || die "$(msg alpine.tooSmall "$csz")"
  log "  initramfs.cpio.gz  ($csz B)"

  # 再出一份未压缩的。内核在解 initramfs 前会先认压缩格式，认不出就按裸 cpio 直接用 ——
  # 于是"在模拟器里跑一遍 inflate"这段指令整个省掉（实测数字见文件末尾的引导命令）。
  # 代价只是文件大一倍，而 tmp/ 本来就不入库。
  #
  # 是"推荐但可选"，所以问一句。无人值守时 read 会拿到 EOF（等同回答 no），不会挂住；
  # 想预先表态用 --decompress / --no-decompress。
  local want_cpio=0
  case "$DECOMPRESS" in
    yes) want_cpio=1 ;;
    no)  want_cpio=0 ;;
    *)
      echo
      log "  $(msg alpine.decompressNote)"
      printf '%s ' "$(msg alpine.decompressAsk)"
      local ans=""; read -r ans || true
      case "$ans" in y|Y|yes|YES) want_cpio=1 ;; esac
      ;;
  esac

  if [ "$want_cpio" = 1 ]; then
    "$TSX" "$REPO_ROOT/tools/initramfs.ts" decompress \
      "$OUT_DIR/initramfs.cpio.gz" "$OUT_DIR/initramfs.cpio" \
      || die "$(msg alpine.decompressFailed)"
    local usz; usz=$(stat -c %s "$OUT_DIR/initramfs.cpio")
    log "  $(msg alpine.decompressed "$usz")"
    INITRD_FILE="initramfs.cpio"
  else
    log "  $(msg alpine.decompressSkipped)"
  fi
}

# ------------------------------------------------- EDK II / U-Boot 共用的 .deb 拆包
#
# .deb 是 ar 归档，里面是 control.tar.* 与 data.tar.*（Debian 上游多数用 xz，新包开始
# 用 zstd）。拆外层要 AR_TOOL（bsdtar 或 7-Zip），拆内层多数情况 GNU tar 自己就行，
# 只有 zstd 得借 bsdtar（libarchive 带 zstd，GNU tar 未必编了）。
# 解出来的内容留在 $DEB_X 下，调用者取完自己调 deb_cleanup。
DEB_X=""

deb_unpack() {  # deb_unpack <deb> <要解的 deb 内路径（目录以 / 结尾）>
  local deb="$1" inner="$2"
  local x="$OUT_DIR/.deb-x"; rm -rf "$x"; mkdir -p "$x"

  # 拆 ar 容器：先看系统里已有的（①bsdtar ②7-Zip），都没有才谈下载（③）。
  if ! find_local_ar_tool "$deb"; then
    acquire_bsdtar "$deb" || return 1
  fi

  # bsdtar 与 7z 的调用语法不同：bsdtar 是 -xf ... -C，7z 是 x -y -o<dir>
  if [ "$AR_TOOL_IS_7ZIP" = 1 ]; then
    log "  $(msg edk2.unpack7z)"
    "$AR_TOOL" x -y -o"$x" "$deb" >/dev/null 2>&1 || die "$(msg edk2.unpackFailed7z)"
  else
    log "  $(msg edk2.unpackBsdtar)"
    "$AR_TOOL" -xf "$deb" -C "$x" 2>/dev/null || die "$(msg edk2.unpackFailedBsdtar)"
  fi

  local data; data="$(ls "$x"/data.tar* 2>/dev/null | head -1)"
  [ -n "$data" ] || die "$(msg edk2.noDataTar)"
  case "$data" in
    *.zst)
      [ "$AR_TOOL_IS_7ZIP" = 0 ] || die "$(msg edk2.zstdNeedsBsdtar)"
      log "  $(msg edk2.innerBsdtar "$(basename "$data")")"
      "$AR_TOOL" -xf "$data" -C "$x" "$inner" 2>/dev/null \
        || die "$(msg edk2.innerFailed "$(basename "$data")")"
      ;;
    *)
      log "  $(msg edk2.inner "$(basename "$data")")"
      verify_archive "$data" || die "$(msg edk2.dataIncomplete "$(basename "$deb")")"
      tar -xf "$data" -C "$x" "$inner" 2>/dev/null || true
      ;;
  esac
  DEB_X="$x"
  return 0
}

deb_cleanup() { [ -n "$DEB_X" ] && rm -rf "$DEB_X"; DEB_X=""; return 0; }

# ------------------------------------------------------------- ④ U-Boot 固件
#
# U-Boot 作为 S 模式负载跑在 OpenSBI 之上，自己去 virtio 盘上把内核与 initramfs
# 读进内存、再 booti 起来。Debian 的 u-boot-qemu 里有两份 ELF，别拿错：
#   qemu-riscv64/uboot.elf        给 QEMU 当 -bios 直接跑（按裸机布局链接）
#   qemu-riscv64_smode/uboot.elf  由 SBI 固件引导（我们要这个）
UBOOT_POOL="https://deb.debian.org/debian/pool/main/u/u-boot/"

bootstrap_uboot() {
  if [ -f "$OUT_DIR/uboot.elf" ]; then
    log "  $(msg uboot.exists)"
    return 0
  fi

  local deb_name
  deb_name=$(fetch_text "$UBOOT_POOL" 2>/dev/null \
    | grep -oE 'u-boot-qemu_[^"]*_all\.deb' | sort -u | tail -1) || true
  [ -n "$deb_name" ] || die "$(msg uboot.noListing)"
  log "  $(msg uboot.latest "$deb_name")"

  local deb="$OUT_DIR/$deb_name"
  fetch "$deb" "" "$UBOOT_POOL$deb_name" || die "$(msg uboot.downloadFailed)"

  deb_unpack "$deb" './usr/lib/u-boot/qemu-riscv64_smode/' || die "$(msg uboot.noTool)"
  local src="$DEB_X/usr/lib/u-boot/qemu-riscv64_smode/uboot.elf"
  [ -f "$src" ] || die "$(msg uboot.notFound)"
  cp -f "$src" "$OUT_DIR/uboot.elf"
  deb_cleanup
  log "  $(msg uboot.extracted "$(basename "$deb_name" .deb)" "$(stat -c %s "$OUT_DIR/uboot.elf")")"
}

# ------------------------------------------------- 引导盘（FAT16，tools/mkfat.ts）
#
# U-Boot 的 fatload 与 UEFI 的 ESP 都按**文件**读盘，不认裸块号，所以盘上得有文件系统。
# 镜像由 tools/mkfat.ts 手写生成（为什么不借 mtools / mkfs.vfat 见那个文件的注释），
# 这里只负责把产物塞进去、再把"盘上叫什么"告诉调用者。
FAT_PART_FAT16=0x0C
FAT_PART_ESP=0xEF

build_fat_disk() {  # build_fat_disk <输出.img> <分区类型> <镜像内路径=宿主文件...>
  local img="$1" parttype="$2"; shift 2
  "$TSX" "$REPO_ROOT/tools/mkfat.ts" "$img" "--part-type=$parttype" "$@" \
    || die "$(msg fat.failed)"
}

# U-Boot 的命令脚本：扫盘 → 逐个 fatload 到内存 → booti。
# 盘上就两个文件、名字固定，所以命令也固定（不现场拼字符串，便于对着 README 读）。
#
# ⚠️ booti 的第三个参数（设备树）不能省：这个构建的 qemu-riscv64_smode U-Boot 自己的
# gd->fdt_blob 在交接时会变成 0（实测 "Working FDT set to 0" → "Device tree not found"），
# 必须显式把 `$fdtcontroladdr`（U-Boot 启动时记下的控制 FDT 地址）传进去。
uboot_cmd_script() {  # uboot_cmd_script <输出文件>
  cat > "$1" <<EOF
virtio scan
part list virtio 0
fatls virtio 0:1
fatload virtio 0:1 \${kernel_addr_r} Image
fatload virtio 0:1 \${ramdisk_addr_r} $(basename "$INITRD_FILE")
setenv bootargs console=ttyS0 rdinit=/init earlycon=sbi
booti \${kernel_addr_r} \${ramdisk_addr_r}:\${filesize} \${fdtcontroladdr}
EOF
}

# U-Boot 那条路要的盘：内核 + initramfs + 命令脚本，一次做齐。
bootstrap_uboot_disk() {
  local img="$OUT_DIR/uboot-disk.img"
  build_fat_disk "$img" "$FAT_PART_FAT16" \
    "Image=$OUT_DIR/Image" \
    "$(basename "$INITRD_FILE")=$OUT_DIR/$INITRD_FILE"
  uboot_cmd_script "$OUT_DIR/uboot-cmd.txt"
  log "  $(msg uboot.diskMade "$(basename "$img")" "$(( $(stat -c %s "$img") / 1048576 ))")"
}

# EDK II 的固件卷里压了一层 LZMA：原样交给模拟器，固件自己解压要十分钟（实测），
# 而这一步纯属白烧指令。tools/uncompress-fv.ts 在盘上先把它剥掉，引导快约 5 倍。
# 剥过的文件叫 RISCV_VIRT_CODE.nocomp.fd，两个入口打印命令时用的就是它。
strip_fv_lzma() {  # strip_fv_lzma <原始.fd> <输出.fd>
  log "  $(msg edk2.stripping)"
  "$TSX" "$REPO_ROOT/tools/uncompress-fv.ts" "$1" "$2" \
    || die "$(msg edk2.stripFailed)"
}

# EDK II 的 ESP：固件里有 UEFI Shell 与 `initrd` 命令（OvmfPkg/LinuxInitrdDynamicShellCommand），
# 它把文件注册成 Linux initrd 的 device path，内核的 EFI stub 就会去读 —— 于是不需要
# 任何第三方引导器。startup.nsh 是 shell 启动时自动执行的脚本，两条命令就够。
bootstrap_esp() {
  local esp="$OUT_DIR/esp.img"
  local nsh="$OUT_DIR/startup.nsh"
  {
    echo '@echo -off'
    echo "initrd \\$(basename "$INITRD_FILE")"
    echo "\\Image console=ttyS0 rdinit=/init earlycon=sbi"
  } > "$nsh"

  build_fat_disk "$esp" "$FAT_PART_ESP" \
    "startup.nsh=$nsh" \
    "Image=$OUT_DIR/Image" \
    "$(basename "$INITRD_FILE")=$OUT_DIR/$INITRD_FILE"
  log "  $(msg esp.made "$(basename "$esp")" "$(( $(stat -c %s "$esp") / 1048576 ))")"
}

# ----------------------------------------------------------------------- 主流程

# 三个入口共用的开场与收尾（编号由入口自己排：每条路要的素材不一样）
bs_banner() {
  log "$(msg common.banner)"
  log "$(msg common.repo "$REPO_ROOT")"
  log "$(msg common.outdir "$OUT_DIR")"
}

bs_list_artifacts() {
  echo
  log "$(msg common.done)"
  ls -la "$OUT_DIR" | awk 'NR>3 && $5>0 {printf "  %12d B  %s\n", $5, $9}'
}

bs_rel_out() { printf '%s' "${OUT_DIR#$REPO_ROOT/}"; }
bs_fw_rel()  { printf '%s' 'firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin'; }

# initramfs 的解释文字随"这次到底产出了哪一份"变，避免打印一条指向不存在文件的命令
bs_initrd_note() {
  if [ "$INITRD_FILE" = "initramfs.cpio" ]; then
    msg tail.uncompressed
  else
    msg tail.compressedHint "$(bs_rel_out)"
  fi
}

# ① OpenSBI 直接跳转内核：fw_jump 落在 0x80200000，内核就在那儿等它
tail_direct() {
  cat <<EOF

$(msg tail.title)

  # $(msg tail.alpineCmd)
$(msg tail.earlycon)
$(bs_initrd_note)

  npx tsx src/cli.ts \\
    --bios $(bs_fw_rel) \\
    --kernel $(bs_rel_out)/Image --initrd $(bs_rel_out)/$INITRD_FILE \\
    --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats

EOF
}

# ② U-Boot 拉内核：OpenSBI → U-Boot → 由 U-Boot 自己从 FAT 盘上 fatload + booti
tail_uboot() {
  cat <<EOF

$(msg tail.title)

  # $(msg tail.ubootCmd)
$(msg tail.ubootNote)

  npx tsx src/cli.ts \\
    --bios $(bs_fw_rel) \\
    --kernel $(bs_rel_out)/uboot.elf \\
    --disk $(bs_rel_out)/uboot-disk.img \\
    --script $(bs_rel_out)/uboot-cmd.txt -n 3000000000 --stats

EOF
}

# ③ EDK II：固件在 flash 里，内核与 initramfs 在 ESP 上。
#
# ⚠️ 必须带 --bios：CLI 要求 --kernel 或 --bios 至少有一个（只有 --flash-* 会被当成
# 参数错误、打印帮助退出 2），而且 EDK II 在 RISC-V 上要用 SBI 的定时器/IPI/复位，
# 少了 OpenSBI 根本走不到 UEFI 引导界面。旧版脚本打印的命令漏了这个开关，是坏的。
tail_edk2() {
  cat <<EOF

$(msg tail.title)

  # $(msg tail.edk2Cmd)
$(msg tail.edk2Note)

  # $(msg tail.edk2)
  npx tsx src/cli.ts \\
    --bios $(bs_fw_rel) \\
    --kernel $(bs_rel_out)/edk2-tramp.bin \\
    --flash-code $(bs_rel_out)/$EDK2_CODE_FILE \\
    --flash-vars $(bs_rel_out)/RISCV_VIRT_VARS.fd \\
    --disk $(bs_rel_out)/esp.img -n 3000000000 --stats

EOF
}

