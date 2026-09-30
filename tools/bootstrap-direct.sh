#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
#
# 引导路 ①：OpenSBI 直接跳转内核。
#
#   OpenSBI fw_jump.bin  ──跳转──▶  内核 Image（+ initramfs）
#
# 最短的一条路：没有中间固件，fw_jump 按约定跳到 0x80200000，内核就在那儿。
# 需要 OpenSBI 固件与 Alpine 内核/initramfs，两样都落 gitignored 目录。
#
# 这条路只跑 Alpine：Debian 的 riscv64 内核是 EFI stub 的 PE 镜像（文件开头是 MZ），
# fw_jump 直跳过去第一条指令就是非法指令 —— 必须由固件按 EFI 方式加载，也就是必须走
# 另外两条路。所以 --distro debian 在这里直接报错退出。
#
# 完整用法：tools/bootstrap-direct.sh --help
# 实现细节见 tools/lib/bootstrap-common.sh（三个入口共用）。

BOOT_PATH=direct
# shellcheck source=lib/bootstrap-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/bootstrap-common.sh"

# 这条路自己的选项（公共选项由 bs_arg_common 处理）
DECOMPRESS="ask"          # ask | yes | no：是否额外产出一份未压缩 initramfs

while [ $# -gt 0 ]; do
  case "$1" in
    --decompress)    DECOMPRESS="yes" ;;
    --no-decompress) DECOMPRESS="no" ;;
    *)
      if bs_arg_common "$@"; then shift $((BS_CONSUMED - 1))
      else die "$(msg common.unknownArg "$1")"
      fi
      ;;
  esac
  shift
done
bs_args_done
# Debian 在这条路上没有任何可行做法（见文件头），所以不下载、不生成，直接说清楚退出去。
[ "$DISTRO" = alpine ] || die "$(msg distro.directNoDebian)"
bs_init

bs_banner
echo
log "① $(msg stage.opensbi)"
bootstrap_opensbi
echo
log "② $(msg stage.alpine)"
bootstrap_alpine
bs_list_artifacts
tail_direct
