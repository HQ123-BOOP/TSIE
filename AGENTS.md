# AGENTS.md

Orientation for AI coding agents working on this repository. Human-facing documentation,
the full feature list, and memory map live in [README.md](README.md) — this file only covers
what you need to work here without breaking things.

## What this is

**TSIE** (TSIE Is an Emulator) — a RISC-V 64-bit full-system emulator written from scratch in
TypeScript. Instruction decode, privileged architecture, virtual memory, and every peripheral
are hand-written; there is no delegation to an external emulator or VM.

- ISA: **RV64GC** = RV64IMAFDC + Zicsr + Zifencei, plus Zba / Zbb / Zbs / Zicntr.
- Privilege: M / S / U, full m/s CSR set, exception delegation, CLINT + PLIC interrupts, WFI.
- Memory: Sv39 / Sv48 paging with a TLB, plus a `fastRam` direct-read path.
- Targets: the QEMU `virt` machine layout; runs real OpenSBI, U-Boot, EDK II, and Linux.
- License: **Apache-2.0**. Only runtime dependency is `ws` (browser display).

## Commands

```bash
npm install          # ws is the only runtime dep
npm test             # 234 unit tests across 26 files (node:test)
npm run typecheck    # tsc --noEmit — must stay at 0 errors
npm run demo         # bare-metal "Hello, RISC-V 64!"; drives UART directly, needs no firmware
npm run bench        # bare-metal throughput benchmark
```

Boot real firmware (the strongest end-to-end check):

```bash
npx tsx src/cli.ts \
  --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin
```

Expected: the OpenSBI banner, then a platform report reading `Platform Name : tsie,virt` and
`Platform Timer Device : aclint-mtimer @ 10000000Hz`. OpenSBI derives the ISA line from `misa`
(it prints `Boot HART Base ISA : rv64imafdcb` and `Boot HART ISA Extensions : zicntr`), which is
independent of the longer `riscv,isa` string the device tree advertises.
`tsx src/cli.ts --help` lists every option.

## Hard rules

1. **Never commit non-permissive binary artifacts.** The repo is Apache-2.0. GPL-2.0 material
   (Linux kernels, U-Boot, OpenSBI builds, disk images) must not enter git. `firmware/`,
   `linux-image/`, `tmp/`, and `dist/` are gitignored for this reason — keep it that way.
2. **Every `.ts` file carries the SPDX header.** Two lines, before the module docs:
   `// SPDX-License-Identifier: Apache-2.0` and `// SPDX-FileCopyrightText: 2026 TSIE`.
3. **`npm run typecheck` must stay at 0 errors**, and `npm test` at 0 failures. The tsconfig
   is strict with `noUnusedLocals` / `noUnusedParameters` / `noImplicitOverride`.
4. **Commit messages follow Conventional Commits, in English** — `type(scope): subject`,
   with a scope naming the module (`cpu`, `mmu`, `dev`, `cli`, `display`, `readme`, …).
   Commit each completed step rather than batching unrelated work.

## Architecture

Data flows `Machine` → `Bus` → device, with `Cpu` at the core:

- `src/core/bits.ts` — 64-bit immediate extraction and sign extension.
- `src/mem/` — physical address space: `Bus` dispatch, `RAM` (exposes a `DataView` that the
  MMU hot path reads directly).
- `src/cpu/cpu.ts` — fetch/decode/execute, traps, interrupts, instruction cache. The largest
  and most performance-sensitive file.
- `src/cpu/csr.ts`, `mmu.ts`, `fpu.ts` — CSR file, page-table walk + TLB, IEEE-754.
- `src/dev/` — UART, CLINT, PLIC, RTC, flash, and the VirtIO family over both MMIO and PCIe.
- `src/display/web.ts` — pushes framebuffer deltas to a browser over WebSocket.
- `src/machine.ts` — assembles the `virt` machine, generates the device tree, owns the main loop.
- `src/loader/` — ELF64 loading and flattened-device-tree construction.
- `tools/encoder.ts` — RISC-V instruction encoder, used by tests and examples.

## Non-obvious behavior you must not "fix"

These look like bugs and are not. Each is load-bearing; changing them breaks real guests.

- **Misaligned accesses are emulated byte-by-byte by default** (`misaligned: 'slow'`), matching
  real `virt` hardware and QEMU. This is required to boot Linux: module relocation
  (`apply_r_riscv_64_rela`) performs unaligned 8-byte stores. Strict spec behavior is opt-in via
  `--misaligned trap` and is what the MMU unit tests use.
- **The instruction cache is invalidated only on `satp` writes, `fence.i`, and reset.**
  Writing `mstatus`, `sfence.vma`, and traps/returns deliberately do *not* invalidate it —
  instruction fetch does not consult `mstatus`, and the spec assigns I-cache coherence to
  `fence.i`, not `sfence.vma`. Removing those invalidations took the hit rate from 73.7% to
  99.4% and throughput up ~35%.
- **TLB keys are `bigint`.** The kernel's VPN is the full `vaddr >> 12` value (up to 52 bits).
  Packing it into a `Number`, or bit-concatenating it with the ASID, causes collisions across
  ASIDs and produces an exception storm.
- **`mtime` is deliberately jittered per instruction** (deterministic xorshift), and the DTB
  injects a 4096-byte `rng-seed`. The simulator's timing is otherwise fully deterministic, so
  without both of these the kernel's jitter-entropy init spins forever.
- **The DTB is placed after the images**, not at a fixed address — a large initrd would
  overwrite a fixed address. It is passed to the guest in `a1`.
- **There is no built-in SBI firmware.** It was removed; `--bios` with an external OpenSBI is
  mandatory for anything that executes SBI calls (that is, anything running Linux).

## Performance work

Throughput is roughly 2–4 MIPS, and the `bigint` data path is the deliberate tradeoff: exact
semantics over speed. **Absolute numbers are not comparable across sessions** — host load swings
them by more than 2×. Only same-machine, back-to-back A/B measurements mean anything.

Measure before changing anything. The hot path has repeatedly defied intuition here: several
plausible optimizations were implemented, measured, found to gain nothing, and reverted. Use
`--stats` (which reports instruction-cache hit rate and TLB walk counts) plus a `node --cpu-prof`
profile to locate real cost before optimizing.

## Testing

`node:test` via `npx tsx --test`, with helpers in `tests/harness.ts` (`makeCpu`, `Sv39Mapper`,
`halt`, PTE constants). Instruction-level tests build programs with `tools/encoder.ts`.
Run one file directly:

```bash
npx tsx --test tests/mmu.test.ts
```

Prefer synthetic in-process guest-driver tests over booting a full OS — they run in
milliseconds instead of minutes.

CI runs the same checks on every push to `main` and every pull request
(`.github/workflows/ci.yml`): `typecheck`, `npm test`, `npm run build`, loading the built
`dist/cli.js`, and `npm run demo` — on Ubuntu and Windows alike, with a single Node version
(24, the active LTS). A second job enforces the SPDX headers and the ban on committing GPL or
binary artifacts. Pushing a `v*` tag additionally builds and attaches an npm tarball to the
GitHub Release (`.github/workflows/release.yml`), and the tag must match the version in
`package.json`. The commands above are still what you run locally; CI only makes them
non-optional.
