#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
#
# 引导路 ③：EDK II (UEFI) 里把 Linux 拉起来。
#
#   EDK II 固件（CFI flash 里的 CODE + VARS）──BDS──▶  UEFI Shell
#       └─ 自动执行 ESP 上的 startup.nsh：initrd 注册 initrd → 启动内核的 EFI stub
#
# 这条路不下载任何第三方引导器：固件自己带 UEFI Shell 与 `initrd` 命令
# （OvmfPkg/LinuxInitrdDynamicShellCommand），它把盘上的文件注册成 Linux initrd 的
# device path，内核 EFI stub 便找得到 —— 命令行则由 shell 启动内核时作为参数传入。
#
# 完整用法：tools/bootstrap-edk2.sh --help
# 实现细节见 tools/lib/bootstrap-common.sh（三个入口共用）。

BOOT_PATH=edk2
# shellcheck source=lib/bootstrap-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/bootstrap-common.sh"

# 这条路自己的选项（公共选项由 bs_arg_common 处理）
DO_EDK2=1
DO_ESP=1
DO_STRIP=1     # 剥掉固件卷里的 LZMA 层（引导快约 5 倍；-NoStrip 可关）

while [ $# -gt 0 ]; do
  case "$1" in
    --no-esp) DO_ESP=0 ;;   # 只要固件，不建 ESP（内核/initramfs 也就不必取）
    --firmware-only) DO_ESP=0; DO_ALPINE=0 ;;
    --no-strip) DO_STRIP=0 ;;   # 不剥 LZMA：产物与上游一致，但每次引导要多烧十分钟
    --strip) DO_STRIP=1 ;;
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
# 第二条要的东西按发行版分岔：Alpine 是内核 + initramfs，Debian 是它自己的整盘镜像。
# --firmware-only 两边一样，都表示"不要素材，只要固件"。
if [ "${DO_ALPINE:-1}" = 1 ]; then
  if [ "$DISTRO" = debian ]; then
    log "② $(msg stage.debian)"
    bootstrap_debian
  else
    log "② $(msg stage.alpine)"
    bootstrap_alpine
  fi
  echo
  log "③ $(msg stage.edk2)"
else
  log "② $(msg stage.edk2)"
fi
bootstrap_edk2
# ESP 只有 Alpine 那条路要做：Debian 镜像的 p15 上就是它自己的 ESP，上面是 GRUB，
# 固件的 BDS 会按"可移动介质"规则去 \EFI\BOOT\BOOTRISCV64.EFI 把它起来。
if [ "$DO_ESP" = 1 ] && [ "$DISTRO" = alpine ]; then
  echo
  log "④ $(msg stage.esp)"
  bootstrap_esp
fi
bs_list_artifacts
tail_edk2
