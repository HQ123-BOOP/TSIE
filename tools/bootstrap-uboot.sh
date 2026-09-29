#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
#
# 引导路 ②：U-Boot 拉内核。
#
#   OpenSBI fw_jump  ──▶  U-Boot（S 模式负载）──从 FAT 盘 fatload──▶  内核 Image + initramfs
#
# 比直接跳转多一层真实的引导器：U-Boot 自己去 virtio 盘上按**文件**读内核与 initramfs，
# 再用 booti 交接。所以这条路除内核与 initramfs 外，还要 U-Boot 固件与一块 FAT 盘。
#
# 完整用法：tools/bootstrap-uboot.sh --help
# 实现细节见 tools/lib/bootstrap-common.sh（三个入口共用）。

BOOT_PATH=uboot
# shellcheck source=lib/bootstrap-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/bootstrap-common.sh"

# 这条路自己的选项（公共选项由 bs_arg_common 处理）
DECOMPRESS="ask"          # U-Boot 从盘上读的那份 initramfs 要不要先解压

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
bs_init

bs_banner
echo
log "① $(msg stage.opensbi)"
bootstrap_opensbi
echo
log "② $(msg stage.alpine)"
bootstrap_alpine
echo
log "③ $(msg stage.uboot)"
bootstrap_uboot
echo
log "④ $(msg stage.disk)"
bootstrap_uboot_disk
bs_list_artifacts
tail_uboot
