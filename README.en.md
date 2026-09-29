<div align="center">

# TSIE

<img src="https://img.shields.io/github/v/release/HQ123-BOOP/TSIE" alt="Release">
<img src="https://img.shields.io/github/license/HQ123-BOOP/TSIE" alt="License">
<img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript">
<img src="https://github.com/HQ123-BOOP/TSIE/actions/workflows/ci.yml/badge.svg" alt="CI">

**A RISC-V 64-bit emulator built from scratch in TypeScript.**

English | [中文](README.md)

</div>

There is no runtime dependency beyond `ws` (the WebSocket library behind the live browser
display); instruction decode, the privileged architecture, virtual memory and every peripheral are
hand-written. It is useful for studying the RISC-V architecture, for running bare-metal programs,
or as a test bed for building RISC-V toolchains and operating systems.

## Features at a glance

| Module | Capability |
| --- | --- |
| **ISA** | RV64I / M (multiply/divide) / A (atomics) / F+D (single- and double-precision float) / C (compressed) / Zicsr / Zifencei, that is **RV64GC**; plus Zba / Zbb / Zbs bit manipulation and Zicntr counters (`misa` reports the B bit) |
| **Privilege** | M / S / U privilege levels, the full m/s CSR set, mret/sret, exception delegation (medeleg/mideleg), interrupts (CLINT+PLIC), WFI |
| **Virtual memory** | Sv39 / Sv48 multi-level page-table walks, a TLB (superpages supported), sfence.vma, hardware A/D bit updates, SUM/MXR/MPRV semantics |
| **Peripherals** | NS16550 UART (interrupts + FIFO + loopback), CLINT (mtime/msip), PLIC (claim/complete), Goldfish RTC, SiFive Test |
| **VirtIO** | block device / network card (two backends: slirp and a host proxy) / 9P (shared host directory) / GPU / keyboard input. **Both MMIO and PCIe attachment** (the GPU goes over PCI, matching EDK II's `IsPciDisplay`) |
| **Display** | the virtio-gpu picture can be pushed live to a browser over WebSocket (dirty-rectangle deltas), and browser keystrokes are fed back to the guest |
| **Firmware** | runs real firmware directly: measured OpenSBI 1.9 + U-Boot 2025.01 + **Debian 13 (trixie) booting all the way to `login:`**, plus the EDK II (UEFI) boot chain (TianoCore logo on screen included). **SBI calls need an external OpenSBI — the built-in SBI firmware has been removed** |
| **Loading** | ELF64 loading (vaddr/paddr offsets handled automatically), raw binaries, a flattened device tree (DTB) generator (with `rng-seed` entropy injection) |
| **Tools** | one-shot fetch of all boot material (`tools/bootstrap.sh` / `.ps1`, bilingual), cpio initramfs packing (`tools/initramfs.ts`), **standalone executable builds (`npm run sea`)**, an instruction encoder (`tools/encoder.ts`), CPU profile summarising (`tools/prof-summary.ts`), instruction-level unit tests, CLI |

## Quick start

```bash
npm install        # ws is the only runtime dep; dev deps are typescript / tsx / esbuild / postject / @types/*
npm test           # runs the 249 unit tests
npm run demo       # bare-metal "Hello, RISC-V 64!" (drives the UART directly, needs no firmware)
npm run bench      # throughput benchmark
```

### One-shot fetch of all boot material (do this before running real firmware)

Running OpenSBI / EDK II / Linux needs a few external pieces. `tools/bootstrap.sh` (Git Bash) and
`tools/bootstrap.ps1` (**requires PowerShell 7+**: the 5.1 that ships with Windows is detected,
prints an install hint and exits with code 1) fetch and assemble all of them, then print boot
commands you can copy straight out of the terminal:

```bash
tools/bootstrap.sh                 # interactive: asks whether to use a mirror when GitHub is unreachable
tools/bootstrap.sh --no-edk2       # skip EDK II (saves about 70 MB)
tools/bootstrap.sh --decompress    # pre-agree to decompressing the initramfs (unattended; boots 38.9% faster)
tools/bootstrap.sh --help          # full usage (the content is the comment block at the top of the script)

# the PowerShell switches mean the same, only written differently: -Help / --help / -h all print help
pwsh tools/bootstrap.ps1 -NoEdk2
pwsh tools/bootstrap.ps1 -Help
```

**Both scripts switch between Chinese and English**: `--lang en` / `-Lang en`, or the environment
variable `TSIE_LANG=en`, defaulting to the system locale (Chinese when it cannot tell).
`--lang en --help` prints the English usage, and the `tools/initramfs.ts` called in between follows
the same language too (the scripts pass the choice down through `TSIE_LANG`).
The text has a **single source**, `tools/i18n/messages.tsv` (`key<TAB>Chinese<TAB>English`); TSV
rather than JSON because bash / PowerShell / Node can all read it with zero dependencies.

Artifacts land in the gitignored `tmp/boot/` and `firmware/` — these are GPL-2.0 / third-party
binaries and **must not enter git** (this project is Apache-2.0).

Both scripts **discover version numbers dynamically**: the moment upstream cuts a new release, a
hard-coded URL will 404. The manual steps further down this README are for people who "want to
control every step themselves", and they follow the same principle.

### Packing a standalone executable (no Node install needed on the user's machine)

```bash
npm run sea        # → tmp/sea/tsie (tsie.exe on Windows), about 90–100 MB
```

This uses Node's official **SEA** (Single Executable Application) to pack the CLI together with the
Node runtime into one executable. Startup is also about 9x faster than `npx tsx` (**90 ms vs
830 ms**, because tsx's transpilation is gone). Three known limitations:

- **No cross-compilation**: the SEA blob is platform-independent, but injecting it requires the
  **node executable of the target platform**, so the Windows build can only be made on Windows and
  the Linux build only on Linux (in CI, both platforms build once each).
- Injection breaks node's own code signature (postject warns about it), and distributing it
  publicly requires your own signature, otherwise Windows SmartScreen / macOS Gatekeeper will block it.
- About 90–100 MB (the whole Node runtime is embedded), far larger than the 455 KB npm package — it
  is for people who "do not want to install Node", not a way to save space.

Binaries in the releases are at <https://github.com/HQ123-BOOP/TSIE/releases>.

### Booting OpenSBI (verified ✅)

The emulator can run the real OpenSBI firmware directly (v1.9 measured working).
(`tools/bootstrap.sh` / `.ps1` does all of this and unpacks it for you; the commands below are the
manual path.)

```bash
# download the prebuilt firmware (about 30 MB, covers all platforms)
curl -L -o firmware/opensbi.tar.xz \
  https://github.com/riscv-software-src/opensbi/releases/download/v1.9/opensbi-1.9-rv-bin.tar.xz
# unpacks firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin

# run the firmware alone (prints the OpenSBI banner and platform info)
tsx src/cli.ts --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin

# firmware + kernel (fw_jump jumps to 0x80200000 by default and expects the DTB at 0x82200000, matching this emulator)
tsx src/cli.ts --bios .../fw_jump.bin --kernel hello-sbi.bin
```

OpenSBI recognises this emulator correctly (`Platform Name: tsie,virt`, `rv64imafdc`, the ACLINT
timer, an 8250 serial port, 16 PMPs) and hands control over to an S-mode kernel.

Source and build instructions are in the official repository:
<https://github.com/riscv-software-src/opensbi> (a mirror usable from China:
<https://gitee.com/tinylab/qemu-opensbi.git>).

### Booting U-Boot (verified ✅)

It can run real U-Boot directly (as an S-mode payload) and let it drive a VirtIO block device:

```bash
# unpack qemu-riscv64_smode/uboot.elf from Debian's u-boot-qemu package (keep it in tmp/, GPL-2.0 does not enter git)
# attach a raw disk and use --script to inject commands into the U-Boot console:
tsx src/cli.ts --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin \
  --kernel tmp/uboot/uboot.elf --disk tmp/disk.raw --script <cmd-file> -n 60000000
```

`--script` feeds every line of the file in as a console command, one at a time (with the autoboot
stop key, for interactive firmware). Measured output:

```
=> virtio scan
=> virtio info
Device 0: QEMU VirtIO Block Device
            Capacity: 8.0 MB = 0.0 GB (16384 x 512)
=> virtio write 0x80200000 0 1      # write to disk
1 blocks written: OK
=> virtio read 0x80300000 0 1       # read from disk
1 blocks read: OK
```

The VirtIO block device is implemented against the virtio-v1.x MMIO specification (the register
layout was checked against U-Boot's `virtio_mmio.h` one by one), and it advertises
`VIRTIO_F_VERSION_1`, so modern drivers recognise it directly.
U-Boot download: the Debian package `u-boot-qemu` (`ftp.debian.org/debian/pool/main/u/u-boot/`),
source: <https://github.com/u-boot/u-boot> (GPL-2.0 — do not commit the artifacts into an Apache-2.0
repository).


### Booting Linux (Alpine, verified booting to a shell ✅)

Companion tool: `tools/initramfs.ts` — turns a minirootfs archive straight into a kernel-usable
cpio-newc initramfs (the `alpine` subcommand), strips the compression layer off an existing
compressed initramfs (the `decompress` subcommand), or validates the archive structure (the `verify`
subcommand).
It **never touches a disk**: mode bits and symlink targets come straight out of the tar headers, so
on Windows you will not run into "symlinks cannot be created and execute bits cannot be stored, hence
`Failed to execute /init (error -13)`".

```bash
# 1) download the Alpine riscv64 kernel and the minimal root filesystem
#    ⚠️ always resolve version numbers **dynamically**: packages on this branch move fast and hard-coded URLs 404
#    (the linux-lts-6.18.44 this README used to name is a dead link already).
BASE=https://dl-cdn.alpinelinux.org/alpine/latest-stable
APK=$(curl -fsSL $BASE/main/riscv64/ | grep -oE 'linux-lts-[0-9][^"]*\.apk' | sort -u | tail -1)
ROOTFS=$(curl -fsSL $BASE/releases/riscv64/latest-releases.yaml \
  | grep -oE 'alpine-minirootfs-[0-9][^"]*riscv64\.tar\.gz' | sort -u | tail -1)
curl -O $BASE/main/riscv64/$APK
curl -O $BASE/releases/riscv64/$ROOTFS
# an apk is really a tar.gz: unpack boot/vmlinuz-lts, then gzip -dc it into a flat Image
mkdir apk && tar -xzf "$APK" -C apk/ boot/ && gzip -dc apk/boot/vmlinuz-lts > Image

# 2) pack the initramfs (converted straight from the minirootfs archive, /init and device nodes such as dev/console included)
npx tsx tools/initramfs.ts alpine alpine-minirootfs-*.tar.gz initramfs.cpio.gz
npx tsx tools/initramfs.ts verify initramfs.cpio.gz        # structural check

# 2b) then drop the compression layer — booting is much faster (step 3 below uses this)
#     before unpacking the initramfs the kernel sniffs the compression format, and **falls back to raw cpio when it cannot tell**,
#     so the whole "run inflate inside the emulator" stretch disappears. Same machine, same kernel (both reach ~ #):
#       initramfs.cpio.gz  1,270,638,213 instructions, t=120.26s to /init
#       initramfs.cpio       776,011,912 instructions, t=64.67s to /init
#     ⇒ saves 495 million instructions (38.9%). The only cost is a file twice as large (3.4 MB → 6.9 MB).
npx tsx tools/initramfs.ts decompress initramfs.cpio.gz initramfs.cpio

# 3) boot (measured throughput about 2–4 MIPS, varying with host load; a full boot needs hundreds of millions of instructions, so a few minutes)
tsx src/cli.ts --bios .../fw_jump.bin \
  --kernel tmp/alpine/Image-lts --initrd tmp/alpine/initramfs.cpio \
  --append "console=ttyS0 rdinit=/init earlycon=sbi" -n 1500000000 --stats
```

Measured progress (Linux **6.18.53**, rv64gc): kernel start → memory management (DMA32 512MB /
131072 pages) → SBI TIME/IPI/RFENCE/DBCN/HSM all recognised → timers and clocksources → VFS /
TCP-IP / PCI / USB subsystems → initramfs unpacking → **`Run /init as init process`, landing on
BusyBox's `~ #` prompt** (virtual time about t=64.7s, the measured figures from step 2b above).

A fuller chain has also been brought up: Alpine 3.24.2's ext4 rootfs with a slimmed kernel
(`Image-min-7.2.3`), booted straight through OpenSBI, **mounts the root filesystem and reaches
`alpine-tsie:~#`**; `init=/bin/sh` skips OpenRC and cuts one verification round to a few minutes.
virtio-gpu also completes mode-set and puts a picture on screen on the same chain (see the next
section).

Troubleshooting notes (pitfalls already stepped in, so you do not repeat them):
- `relocate_enable_mmu` in `head.S` uses an instruction page fault as a "portal" (stvec points at a
  virtual address, and after the page-table switch it is the trap that enters virtual address space) —
  **one instruction page fault early in boot is kernel design, not a bug**
- TLB keys must be bigint: under Sv48 `Number(vaddr>>12)*65536+asid` gets close to 2^53, which
  collides different virtual addresses and breaks address-based `sfence.vma` invalidation. The
  stronger conclusion: the VPN is the **entire** `vaddr>>12` value (a kernel half-address reaches
  52 bits), so it neither fits into a Number nor survives bit concatenation with the asid (the
  kernel's vpn high bits are always 1, which collides across ASIDs → an exception storm)
- cpio-newc pads the name aligned to `110 + len(name+\0)` (the kernel's
  `N_ALIGN(len)=(((len+1)&~3)+2)`, where `+2` compensates for the header's 110%4=2), and the name
  must end with a NUL, otherwise you get "broken padding" and "name without nulterm" respectively

### Booting Debian 13 (full distribution, verified up to `login:` ✅)

The whole chain with a real distribution: OpenSBI → U-Boot `bootefi` → EFI stub kernel (6.12.101+deb13)
→ initramfs → switch_root → systemd → `serial-getty@ttyS0` → **`localhost login:`**.

Three key settings are needed (for the other pitfalls see the troubleshooting notes above):

1. **Disk**: the Debian 13 generic riscv64 image (GPT: p1=rootfs ext4, p15=ESP); over VirtIO, U-Boot
   `load`s the kernel and initrd straight from p1 (no GRUB / ESP contents needed).
   The kernel is in MZ+PE EFI stub format, which `booti` does not understand, so you must go through
   `bootefi`.
2. **Entropy**: the emulator's timing is deterministic, jitter entropy gathers nothing, and the
   kernel's RNG initialisation spins forever (udev never starts). This emulator injects 4096 bytes of
   `crypto.getRandomValues()` true randomness into the DTB at `/chosen/rng-seed` — so the kernel
   prints `random: crng init done` very early on.
3. **Virtual clock**: `timebaseFrequency` is set to 100 MHz (the emulator runs at about 2–4 MIPS,
   roughly 100x slower than real hardware; at the 10 MHz default, 10M instructions = 1 virtual
   second, so the kernel soft lockup and the systemd per-service timeouts would wrongly kill slow
   tasks on virtual time). WFI fast-forward is already scaled by the timebase, so sleep convergence
   is unaffected.

Measured figures (512 MiB of memory, uncompressed initrd 66 MB): 18.24B instructions / about
3.9 hours / 1.31 MIPS average, reaching login: at about 90 seconds of virtual time (the same order
of magnitude as real hardware).
Two more speed-ups worth noting: use an uncompressed cpio initrd to skip the zstd decompression
bottleneck (that compressed stretch burns 1B+ instructions at <1 MIPS); the boot script is
`tmp/debian-uboot.ts` (including details such as how to write fdt set cell values; the template is
reusable).

### Command line

```bash
# run a bare-metal image
tsx src/cli.ts --kernel hello.bin --stats

# run Linux (needs a kernel image and a root filesystem)
tsx src/cli.ts \
  --kernel Image \
  --disk rootfs.ext4 \
  --append "console=ttyS0 root=/dev/vda" \
  --memory 1G

# attach OpenSBI firmware. Required to boot Linux — the built-in SBI firmware was removed,
# so without --bios you can only run bare-metal programs that make no SBI calls
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux

# interactive mode: keyboard input is wired to the serial receiver (type commands right after logging into a Linux shell)
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --initrd initramfs.cpio \
  --append "console=ttyS0 rdinit=/init" --interactive

# graphics: attach virtio-gpu and push the picture to a browser live; click the page once to focus it,
# then keystrokes are fed back to the guest (over virtio-input). --pci moves the GPU onto PCIe,
# so EDK II enumerates it by itself as a PCI display device and the firmware needs no patch
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --disk rootfs.ext4 \
  --append "console=ttyS0 root=/dev/vda rw" --gpu 1024x768 --pci \
  --display 8094 --input

# run UEFI firmware (EDK II): CFI flash must be supplied as a CODE / VARS pair
tsx src/cli.ts --flash-code RISCV_VIRT_CODE.fd --flash-vars RISCV_VIRT_VARS.fd

# share a host directory with the guest (virtio-9p; on the guest side mount -t 9p ... hostshare /mnt)
tsx src/cli.ts --bios fw_jump.bin --kernel vmlinux --disk rootfs.ext4 \
  --append "console=ttyS0 root=/dev/vda rw" --9p /path/to/share

# dump the device tree, trace instructions
tsx src/cli.ts --kernel hello.bin --dump-dtb virt.dtb --trace --trace-from 0x80200000
```

For the full option list see `tsx src/cli.ts --help`.

## Memory map (QEMU virt compatible)

| Address | Device |
| --- | --- |
| `0x0000_1000` | (reserved) |
| `0x0010_0000` | SiFive Test (write `0x5555` to exit 0 / `0x3333` to exit 1) |
| `0x0010_1000` | Goldfish RTC |
| `0x0200_0000` | CLINT (msip / mtimecmp / mtime) |
| `0x0C00_0000` | PLIC |
| `0x1000_0000` | NS16550 UART0 |
| `0x1000_1000` | VirtIO-MMIO block device |
| `0x1000_2000` | VirtIO-MMIO network card |
| `0x1000_3000` | VirtIO-MMIO 9P |
| `0x1000_4000` | VirtIO-MMIO GPU (moves to PCIe with `--pci`) |
| `0x1000_5000` | VirtIO-MMIO keyboard input |
| `0x2000_0000` | CFI NOR flash (32 MiB each, EDK II's CODE / VARS) |
| `0x3000_0000` | PCIe ECAM (256 MiB) |
| `0x4000_0000` | PCIe MMIO32 (1 GiB) |
| `0x8000_0000` | RAM (512 MiB by default, adjustable with `-m`) |
| `0x8020_0000` | default kernel load address |
| End of the images | the DTB is in fact placed dynamically (2MB aligned, right after the kernel/initrd — a fixed address would be overwritten by a large initrd) |

PLIC interrupt sources: 1 = VirtIO block device, 2 = network card, 3 = 9P, 4 = GPU, 5 = keyboard
input, 10 = UART0, 11 = RTC, 32–35 = PCIe INTx (matching QEMU virt).

## Programming interface

```ts
import { Machine, MemoryDisk } from './src/index.ts';

const machine = new Machine({
  memSize: 128n * 1024n * 1024n,
  kernel: kernelBytes,           // ELF64 or raw binary
  disk: MemoryDisk.zero(2048),   // 1 MiB empty disk (VirtIO)
  cmdline: 'console=ttyS0',
  stdout: (byte) => process.stdout.write(Buffer.from([byte])),
});

const stats = machine.run({ maxInstructions: 1e9 });
console.log(stats.ips);          // instructions per second
console.log(machine.dumpState()); // PC / mstatus / satp and the rest of the state
```

At a lower level you can drive `Cpu` directly (with `Bus` + `RAM` to build a custom address space),
or hand-write machine code with the instruction encoder in `tools/encoder.ts`:

```ts
import { li, sd, sw } from './tools/encoder.ts';
import { VIRT_TEST } from './src/index.ts';

const program = [
  ...li(1, 0x80200000n),
  ...li(2, 0x1234n),
  sd(1, 2, 0),
  ...li(3, VIRT_TEST),
  ...li(4, 0x5555n),
  sw(3, 4, 0),      // write SiFive Test, exit cleanly
];
```

(`halt()` is a test helper in `tests/harness.ts`, not part of `tools/encoder.ts`.)

## Directory layout

```
src/
├── core/bits.ts          64-bit bit-manipulation helpers (immediate extraction, sign extension, etc.)
├── mem/                  physical address space: Bus / RAM / device interfaces
├── cpu/
│   ├── cpu.ts            fetch-decode-execute, traps and interrupts
│   ├── csr.ts            CSR register file (WARL / read-only / aliases)
│   ├── mmu.ts            Sv39/Sv48 page-table walk + TLB
│   └── fpu.ts            IEEE754 floating point (NaN boxing, rounding modes, exception flags)
├── dev/                  device models
│   ├── uart.ts / clint.ts / plic.ts / rtc.ts / test.ts
│   ├── virtio.ts         transport-independent VirtIO base class
│   ├── virtio-mmio.ts    VirtIO MMIO transport
│   ├── pci/ecam.ts       PCIe host bridge (ECAM)
│   ├── pci/virtio-pci.ts VirtIO PCI transport
│   ├── virtio-blk.ts / net.ts / net-slirp.ts / net-proxy.ts
│   ├── ninep.ts / virtio-9p.ts
│   └── virtio-gpu.ts / virtio-input.ts / flash.ts / disk.ts / bmp.ts
├── display/web.ts        pushes the virtio-gpu picture to a browser (WebSocket + dirty-rectangle deltas)
├── loader/               ELF64 loading + DTB generation
├── machine.ts            assembles the virt machine and owns the main loop
├── index.ts              public API exports
└── cli.ts                command-line entry point
tools/bootstrap.sh        one-shot fetch of all boot material (OpenSBI + EDK II + Alpine kernel/initramfs)
tools/bootstrap.ps1       the same, PowerShell 7 version (both scripts are bilingual, see tools/i18n/)
tools/i18n/               message table messages.tsv + usage text (one per language, shared by three consumers)
tools/initramfs.ts        tar.gz → cpio-newc initramfs; also the decompress / verify subcommands
tools/uncompress-fv.ts    strips the LZMA compression layer out of EDK II firmware (UEFI boots about 5x faster)
tools/prof-summary.ts     summarises node --cpu-prof samples, listing hot spots by self time
tools/encoder.ts          RISC-V instruction encoder (used by tests and examples)
tools/bench.ts            throughput benchmark; bench-hilo.ts measures the itemised cost of high/low-word arithmetic
tests/                    249 unit tests (node:test, 28 files)
```

## Testing

```bash
npm test                              # all 249 (28 files)
npx tsx --test tests/mmu.test.ts      # a single module
npm run typecheck                     # type check (currently 0 errors)
```

CI runs three groups of jobs on every push to `main` and every PR: `check` (typecheck / tests / build /
loading the build output / bare-metal demo, once each on Ubuntu and Windows), `sea` (packing the CLI
into a standalone executable and smoke-testing it, again on both platforms), and `hygiene` (SPDX
headers, no GPL or binary artifacts in git, LF-only line endings, no build caches in git, the message
table complete with no dead keys, and help plus tool output correct in both languages).
Tagging `v*` additionally builds and attaches the npm tarball together with the standalone
executables for both platforms to the GitHub Release.

Coverage: all RV64I integer and memory instructions, the M extension (including divide-by-zero and
overflow), the A extension (LR/SC/AMO), the F/D extensions (rounding modes, NaN boxing, FCLASS),
RVC compressed instructions, Zba/Zbb/Zbs/Zicntr, CSR/trap/interrupt delegation, Sv39/Sv48 translation
and permissions, strict NX (fetching from an X=0 page must fault), every peripheral protocol
(UART / virtio-blk / net / 9p / gpu / input / PCI), and whole-machine end-to-end cases (timer
interrupts, WFI, counter carry guardrails).

## Performance and design trade-offs

- **The data path uses `bigint`**: the semantics match hardware exactly (no 2^53 precision trap) and
  it reads well; the price is speed, since interpretation is inherently slower than a JIT emulator.
- The hot path has several layers of optimisation (measured on Linux boots): caching satp-derived
  values, trimming the TLB key bigint, reading RAM directly (bypassing bus dispatch and boxing),
  merging interrupt state, batch-sampling `performance.now()`, moving timer-expiry detection onto a
  64-instruction tick, pooling icache entries, sign-extending immediates with integer shifts.
  Current throughput: bare-metal benchmark **3–6 MIPS**, Linux guest **about 2 MIPS**.
  ⚠️ Absolute numbers are very sensitive to host load (the same code reaches 6 MIPS in a quiet
  period and drops to 3.2 with several other node processes running), so **only same-machine
  back-to-back A/B comparisons mean anything**; do not draw conclusions from absolute numbers across
  sessions. The historical figures in the boot sections below are a true record of that run at the
  time, not the current best.
- If you need more performance, these routes are open (the interfaces are already in place):
  1. represent 64-bit values as two 32-bit `number` components, hi and lo. The arithmetic layer
     itself has already been measured with `tools/bench-hilo.ts`: **4.4x** for the individual
     operations and **8.35x** for one instruction's mixed arithmetic — the hypothesis holds, but the
     net gain will be lower still (you have to subtract re-composition at the MMU/bus boundary,
     longer mul/div code and a full rewrite of execute), and it is an all-or-nothing change;
  2. introduce a code cache (basic-block cache) into the fetch path;
  3. the endgame is a WASM JIT.
- **Misaligned accesses are emulated byte by byte by default (permissive)**, matching real RISC-V
  virt hardware and QEMU. This is a prerequisite for booting Linux: kernel module relocation
  (`apply_r_riscv_64_rela`) performs unaligned 8-byte stores, and raising an exception per the spec
  would Oops immediately. For spec-exact behaviour add `--misaligned trap` (the unit tests verify
  spec semantics in that mode).

## Known limitations

- Single hart (multi-core and hartip are not implemented yet)
- PMP registers are readable and writable but enforce no permissions (no impact on booting Linux)
- Floating-point rounding can differ by 1 ulp in extreme edge cases (a consequence of JS
  double-precision intermediates)
- No H extension (hypervisor), no vector extension, and no debug module (dcsr and friends)

## Star History

<a href="https://www.star-history.com/?repos=HQ123-BOOP%2FTSIE&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=HQ123-BOOP/TSIE&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=HQ123-BOOP/TSIE&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=HQ123-BOOP/TSIE&type=date&legend=top-left" />
 </picture>
</a>

## License

Apache-2.0

# Disclaimer

This program is licensed under **Apache-2.0**; see LICENSE for the specific rights and limitations
under the licence. **To the extent permitted by applicable law, this program is provided AS IS,
without any express or implied warranty.**
