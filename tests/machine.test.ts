/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addi,
  csrs,
  csrc,
  csrw,
  ecall,
  li,
  lw,
  mret,
  sd,
  sw,
} from '../tools/encoder.ts';
import { CSR } from '../src/cpu/csr.ts';
import { Machine, VIRT_KERNEL, VIRT_TEST, VIRT_UART0, type MachineOptions } from '../src/machine.ts';
import { MemoryDisk } from '../src/dev/disk.ts';

const S_ENTRY = VIRT_KERNEL + 0x100n;

/** 构造一台机器：把 raw 二进制作为 kernel 加载（裸机程序） */
function build(program: Uint8Array, opts: MachineOptions = {}) {
  const out: number[] = [];
  const m = new Machine({
    memSize: 8n * 1024n * 1024n,
    stdout: (b) => out.push(b),
    ...opts,
    kernel: program,
  });
  return { m, out, text: () => Buffer.from(out).toString('utf8') };
}

function bytes(words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const dv = new DataView(b.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return b;
}

/** M 模式启动 → 切到 S 模式执行 SBI 调用的样板代码 */
function mModeStub(): number[] {
  return [
    ...li(5, S_ENTRY),
    csrw(CSR.MEPC, 5),
    ...li(6, 0x1800n), // MPP 掩码
    csrc(CSR.MSTATUS, 6),
    ...li(6, 0x800n), // MPP = S
    csrs(CSR.MSTATUS, 6),
    mret(),
  ];
}

test('裸机程序：通过 Test Finisher 退出', () => {
  // M 模式：直接写 0x5555 到 sifive_test
  const program = bytes([...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0)]);
  const { m } = build(program);
  const stats = m.run({ maxInstructions: 1000 });
  assert.equal(m.cpu.halted, true);
  assert.equal(m.exitCode, 0);
  assert.equal(m.exitReason, 'test-pass');
  assert.ok(stats.instructions < 20, `应在少量指令内退出（实际 ${stats.instructions}）`);
});

test('裸机程序：写 0x3333 表示失败', () => {
  const program = bytes([...li(1, VIRT_TEST), ...li(2, 0x3333n), sw(1, 2, 0)]);
  const { m } = build(program);
  m.run({ maxInstructions: 1000 });
  assert.equal(m.exitCode, 1);
  assert.equal(m.exitReason, 'test-fail');
});

test('裸机程序：直接写 UART 输出字符串', () => {
  const msg = 'riscv64!\n';
  const code: number[] = [...li(1, VIRT_UART0)];
  for (const ch of msg) {
    code.push(...li(2, BigInt(ch.charCodeAt(0))));
    code.push(sw(1, 2, 0)); // THR
  }
  code.push(...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0));
  const { m, text } = build(bytes(code));
  m.run({ maxInstructions: 5000 });
  assert.equal(text(), msg);
  assert.equal(m.exitCode, 0);
});

test('内建 SBI：M 模式切换到 S 模式并调用 console_putchar', () => {
  const smode: number[] = [];
  const msg = 'Hello SBI';
  for (const ch of msg) {
    smode.push(...li(17, 1n)); // a7 = legacy console_putchar
    smode.push(...li(10, BigInt(ch.charCodeAt(0)))); // a0 = 字符
    smode.push(ecall());
  }
  smode.push(...li(17, 8n)); // a7 = legacy shutdown
  smode.push(ecall());

  const { m, text } = build(bytes(mModeStub()));
  m.bus.writeBytes(S_ENTRY, bytes(smode));
  m.run({ maxInstructions: 20000 });

  assert.equal(m.cpu.halted, true, `应正常关机（exit=${m.exitReason}）`);
  assert.equal(text(), msg);
  assert.equal(m.exitReason, 'sbi-shutdown');
});

test('内建 SBI：BASE 扩展 probe / get_impl_id', () => {
  const smode = [
    // probe_extension(TIMER)
    ...li(17, 0x10n),
    ...li(16, 3n), // probe_extension
    ...li(10, 0n), // TIMER
    ecall(),
    addi(28, 11, 0), // a1 = probe 结果
    addi(31, 10, 0), // a0 = 错误码
    // get_impl_id
    ...li(17, 0x10n),
    ...li(16, 1n),
    ecall(),
    addi(29, 11, 0),
    // get_spec_version
    ...li(17, 0x10n),
    ...li(16, 0n),
    ecall(),
    addi(30, 11, 0),
    ...li(17, 8n), // shutdown
    ecall(),
  ];
  const { m } = build(bytes(mModeStub()));
  m.bus.writeBytes(S_ENTRY, bytes(smode));
  m.run({ maxInstructions: 20000 });
  assert.equal(m.cpu.halted, true);
  assert.equal(m.cpu.x[31], 0n, 'a0 = SBI_SUCCESS');
  assert.equal(m.cpu.x[28], 1n, 'TIMER 扩展应可用');
  assert.equal(m.cpu.x[29], 0x999n, '实现 ID');
  assert.equal(m.cpu.x[30], 2n, 'SBI 版本 0.2 → 2');
});

test('内建 SBI：set_timer 编程 mtimecmp', () => {
  const smode = [
    ...li(17, 0n), // EID = TIMER
    ...li(10, 5000n), // stime_value
    ecall(),
    ...li(17, 8n),
    ecall(),
  ];
  const { m } = build(bytes(mModeStub()));
  m.bus.writeBytes(S_ENTRY, bytes(smode));
  m.run({ maxInstructions: 20000 });
  assert.equal(m.clint.mtimecmp, 5000n);
});

test('启动约定：a0 = hartid，a1 = DTB 地址', () => {
  const program = bytes([...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0)]);
  const { m } = build(program);
  assert.equal(m.cpu.x[10], 0n, 'a0 = hartid');
  assert.equal(m.cpu.x[11], m.dtbAddress, 'a1 = DTB 物理地址');
  assert.ok(m.dtbAddress > VIRT_KERNEL);
});

test('DTB：结构与内容', () => {
  const { m } = build(bytes([...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0)]));
  // /chosen 里有 4096 字节 rng-seed，DTB 总长超过 4K：按头部 totalsize 读全量
  const head = m.bus.readBytes(m.dtbAddress, 8);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  assert.equal(hv.getUint32(0, false), 0xd00dfeed, 'FDT magic');
  const total = hv.getUint32(4, false);
  const dtb = m.bus.readBytes(m.dtbAddress, total);
  assert.ok(total > 100 && total < 16384, `totalsize=${total} 合理`);
  const text = Buffer.from(dtb).toString('latin1');
  assert.ok(text.includes('rng-seed'), '应包含 rng-seed（熵注入）');
  for (const s of ['riscv-virtio', 'ns16550a', 'riscv,clint0', 'riscv,plic0', 'sifive,test0', 'riscv,sv48']) {
    assert.ok(text.includes(s), `DTB 应包含 ${s}`);
  }
  assert.ok(text.includes('virtio,mmio') === false, '未挂载磁盘时不应有 virtio 节点');
});

test('DTB：挂载磁盘时出现 virtio 节点与内核命令行', () => {
  const disk = MemoryDisk.zero(16);
  const { m } = build(bytes([...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0)]), {
    disk,
    cmdline: 'console=ttyS0 root=/dev/vda',
  });
  const head = m.bus.readBytes(m.dtbAddress, 8);
  const total = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, false);
  const dtb = m.bus.readBytes(m.dtbAddress, total);
  const text = Buffer.from(dtb).toString('latin1');
  assert.ok(text.includes('virtio,mmio'), '应包含 virtio 节点');
  assert.ok(text.includes('console=ttyS0 root=/dev/vda'), '应包含 bootargs');
  assert.ok(m.virtio !== undefined);
});

test('CLINT 定时器中断经由 SBI 转成 S 模式定时器中断', () => {
  const SPIN = S_ENTRY + 0x80n;
  // S 模式：开中断、设定定时器后自旋等待
  const smode = [
    ...li(1, S_ENTRY + 0x100n), // 中断入口
    csrw(CSR.STVEC, 1),
    ...li(2, (1n << 5n) | (1n << 9n)), // sie: STIE | SEIE
    csrw(CSR.SIE, 2),
    ...li(3, 2n), // sstatus.SIE
    csrs(CSR.SSTATUS, 3),
    ...li(17, 0n), // sbi_set_timer(50)
    ...li(10, 50n),
    ecall(),
  ];
  // 自旋：j .
  const spin = [...li(4, SPIN), 0x00028067]; // jalr? 用 jal x0,0 死循环
  // 中断处理：标记并退出
  const handler = [addi(20, 0, 1), ...li(6, VIRT_TEST), ...li(7, 0x5555n), sw(6, 7, 0)];

  const { m } = build(bytes(mModeStub()));
  m.bus.writeBytes(S_ENTRY, bytes(smode));
  m.bus.writeBytes(SPIN, bytes([0x0000006f])); // jal x0, 0 → 原地跳转
  m.bus.writeBytes(S_ENTRY + 0x100n, bytes(handler));
  void spin;

  m.run({ maxInstructions: 500000 });
  assert.equal(m.cpu.halted, true, `应通过定时器中断退出（exit=${m.exitReason}）`);
  assert.equal(m.cpu.x[20], 1n, '中断处理程序应被执行');
  assert.equal(m.exitReason, 'test-pass');
});

test('机器状态快照与统计', () => {
  const { m } = build(bytes([...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0)]));
  const stats = m.run({ maxInstructions: 1000 });
  const dump = m.dumpState();
  assert.ok(dump.includes('instret'));
  assert.ok(dump.includes('mstatus'));
  assert.ok(stats.instructions > 0);
  assert.ok(stats.ips > 0);
  assert.ok(m.clint.mtime > 0n, 'mtime 应随时间推进');
});

test('WFI 后靠定时器中断唤醒', () => {
  const HANDLER = S_ENTRY + 0x100n;
  const smode = [
    ...li(1, HANDLER),
    csrw(CSR.STVEC, 1),
    ...li(2, 1n << 5n), // STIE
    csrw(CSR.SIE, 2),
    ...li(3, 2n),
    csrs(CSR.SSTATUS, 3),
    ...li(17, 0n), // set_timer(30)
    ...li(10, 30n),
    ecall(),
    0x10500073, // wfi
    addi(21, 21, 1), // 唤醒后才会执行到
    ...li(1, VIRT_TEST),
    ...li(2, 0x5555n),
    sw(1, 2, 0),
  ];
  // 处理函数：标记、把定时器推远后立即返回
  // 注意：WFI 正常完成，sepc 已指向 WFI 之后的一条指令
  const handler = [
    addi(20, 0, 1),
    ...li(17, 0n),
    ...li(10, 0xffffffffn),
    ecall(),
    0x10200073, // sret
  ];
  const { m } = build(bytes(mModeStub()));
  m.bus.writeBytes(S_ENTRY, bytes(smode));
  m.bus.writeBytes(HANDLER, bytes(handler));
  m.run({ maxInstructions: 500000 });

  assert.equal(m.cpu.halted, true, '唤醒后应正常退出');
  assert.equal(m.cpu.x[20], 1n, '中断处理函数被执行');
  assert.equal(m.cpu.x[21], 1n, 'WFI 之后继续执行了后续指令');
});

test('加载 ELF：程序头与入口地址', async () => {
  const { loadElf } = await import('../src/loader/elf.ts');
  const { Bus } = await import('../src/mem/bus.ts');
  const { RAM } = await import('../src/mem/ram.ts');

  // 手工构造一个最小 ELF64：一个 PT_LOAD（vaddr 0xffffffff80000000，paddr 0x80200000）
  const code = bytes([...li(1, VIRT_TEST), ...li(2, 0x5555n), sw(1, 2, 0)]);
  const elf = buildMinimalElf(code, 0xffffffff80000000n, 0x80200000n);
  const bus = new Bus();
  const ram = new RAM(8n * 1024n * 1024n);
  bus.addDevice(0x80000000n, ram);
  const img = loadElf(bus, elf, { ramBase: 0x80000000n, ramSize: 8n * 1024n * 1024n });
  assert.equal(img.entry, 0x80200000n, '入口应按 bias 平移');
  assert.equal(img.physStart, 0x80200000n);
  assert.equal(ram.read(0x200000n, 4), code.length > 0 ? BigInt(new DataView(code.buffer).getUint32(0, true)) : 0n);
});

/** 构造最小 ELF64（小端、EM_RISCV、单个 PT_LOAD） */
function buildMinimalElf(payload: Uint8Array, vaddr: bigint, paddr: bigint): Uint8Array {
  const ehsize = 64;
  const phentsize = 56;
  const phoff = ehsize;
  const dataOff = phoff + phentsize;
  const buf = new Uint8Array(dataOff + payload.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64 LE
  dv.setUint16(16, 2, true); // e_type = EXEC
  dv.setUint16(18, 243, true); // e_machine = RISC-V
  dv.setUint32(20, 1, true); // e_version
  dv.setBigUint64(24, vaddr, true); // e_entry
  dv.setBigUint64(32, BigInt(phoff), true); // e_phoff
  dv.setBigUint64(40, 0n, true); // e_shoff
  dv.setUint32(48, 0, true); // e_flags
  dv.setUint16(52, ehsize, true);
  dv.setUint16(54, phentsize, true);
  dv.setUint16(56, 1, true); // e_phnum
  // 程序头
  dv.setUint32(phoff, 1, true); // p_type = PT_LOAD
  dv.setUint32(phoff + 4, 5, true); // p_flags = RX
  dv.setBigUint64(phoff + 8, BigInt(dataOff), true); // p_offset
  dv.setBigUint64(phoff + 16, vaddr, true); // p_vaddr
  dv.setBigUint64(phoff + 24, paddr, true); // p_paddr
  dv.setBigUint64(phoff + 32, BigInt(payload.length), true); // p_filesz
  dv.setBigUint64(phoff + 40, BigInt(payload.length), true); // p_memsz
  dv.setBigUint64(phoff + 48, 0x1000n, true); // p_align
  buf.set(payload, dataOff);
  return buf;
}

test('lw 指令可用于检查内存写入结果', () => {
  // 在 M 模式：写 0x1234 到 0x80210000，再读回校验
  const buf = VIRT_KERNEL + 0x10000n;
  const program = bytes([
    ...li(1, buf),
    ...li(2, 0x1234n),
    sd(1, 2, 0),
    lw(3, 1, 0),
    ...li(4, VIRT_TEST),
    ...li(5, 0x5555n),
    sw(4, 5, 0),
  ]);
  const { m } = build(program);
  m.run({ maxInstructions: 2000 });
  assert.equal(m.cpu.x[3], 0x1234n);
  assert.equal(m.exitCode, 0);
});

// ----------------------------------------------------------------------
// DTB 的 PLIC 上下文顺序（回归：外设中断被写进 M 模式上下文，用户态输出全丢）
// ----------------------------------------------------------------------

/**
 * 从生成好的 DTB 里取出某个节点的属性的 u32 cell 数组。
 * nodeName 为节点名前缀（如 'plic@'），因为 CLINT 也有 interrupts-extended。
 */
function dtbPropU32(m: Machine, nodeName: string, propName: string): number[] {
  const dtb = m.bus.readBytes(m.dtbAddress, 8192);
  const dv = new DataView(dtb.buffer, dtb.byteOffset, dtb.byteLength);
  // fdt_header：0x08 = off_dt_struct，0x0c = off_dt_strings
  const offStruct = dv.getUint32(0x08);
  const offStrings = dv.getUint32(0x0c);
  const readName = (at: number) => {
    let n = 0;
    while (dtb[at + n] !== 0) n++;
    return Buffer.from(dtb.subarray(at, at + n)).toString('latin1');
  };

  let p = offStruct;
  let inNode = false;
  for (;;) {
    const token = dv.getUint32(p);
    p += 4;
    if (token === 9) break; // FDT_END
    if (token === 1) { // FDT_BEGIN_NODE
      inNode = readName(p).startsWith(nodeName);
      while (dtb[p] !== 0) p++;
      p = (p + 4) & ~3;
      continue;
    }
    if (token === 2) { inNode = false; continue; } // FDT_END_NODE
    if (token === 4) continue; // FDT_NOP
    if (token !== 3) break; // FDT_PROP
    const len = dv.getUint32(p);
    const nameOff = dv.getUint32(p + 4);
    p += 8;
    if (inNode && readName(offStrings + nameOff) === propName) {
      const cells: number[] = [];
      for (let i = 0; i + 4 <= len; i += 4) cells.push(dv.getUint32(p + i));
      return cells;
    }
    p = (p + len + 3) & ~3;
  }
  throw new Error(`DTB 的 ${nodeName} 节点里找不到属性 ${propName}`);
}

test('DTB：PLIC 的 interrupts-extended 顺序必须与上下文编号一致（M 在前、S 在后）', () => {
  const m = new Machine({ memSize: 64n * 1024n * 1024n } as MachineOptions);
  const cells = dtbPropU32(m, 'plic@', 'interrupts-extended');
  assert.deepEqual(
    cells,
    [1, 11 /* MExternal */, 1, 9 /* SExternal */],
    '上下文 0 必须对应 M 模式、上下文 1 对应 S 模式；顺序颠倒会让 Linux ' +
    '把 S 模式的中断使能写进 M 模式上下文，外设中断永远进不了内核',
  );
});

test('DTB 声明的 S 模式上下文确实能投递到 CPU 的 SEIP', () => {
  const m = new Machine({ memSize: 64n * 1024n * 1024n } as MachineOptions);
  const cells = dtbPropU32(m, 'plic@', 'interrupts-extended');

  // 复现 Linux PLIC 驱动：按顺序逐个上下文配对，挑出 SExternal 的那个
  let sCtx: number = -1;
  for (let i = 1; i < cells.length; i += 2) {
    if (cells[i] === 9 /* SExternal */) { sCtx = (i - 1) / 2; break; }
  }
  assert.equal(sCtx, 1, 'S 模式应为上下文 1');

  // 按驱动的方式初始化并使能串口中断（中断源 10）
  m.plic.write(BigInt(10) * 4n, 1n, 4); // priority[10] = 1
  m.plic.write(0x200000n + BigInt(sCtx) * 0x1000n, 0n, 4); // 阈值 = 0（+0x000）
  m.plic.write(0x2000n + BigInt(sCtx) * 0x80n, 1n << 10n, 4); // enable 源 10
  m.plic.setIrq(10, true);

  const levels = m.plicContextLevels;
  assert.equal(levels[sCtx], true, 'S 模式上下文应输出高电平');
  assert.equal(levels[1 - sCtx], false, 'M 模式上下文不应被误使能');
  assert.equal(Number(m.plic.read(0x200000n + BigInt(sCtx) * 0x1000n + 4n, 4)), 10, 'S 模式应能 claim 到中断源 10（claim 在 +0x004）');
});

test('runInteractive：分块运行并在块间让出事件循环', async () => {
  const m = new Machine({ memSize: 64n * 1024n * 1024n } as MachineOptions);
  let chunks = 0;
  let timerFired = false;
  // 块间让出事件循环后，这个定时器应该有机会执行
  setTimeout(() => { timerFired = true; }, 0);
  const stats = await m.runInteractive({
    maxInstructions: 10_000,
    chunk: 2_000,
    afterChunk: () => { chunks++; },
  });
  assert.ok(chunks >= 4, `应分块执行多次（实际 ${chunks} 次）`);
  assert.equal(timerFired, true, '块与块之间应让出事件循环，异步任务得以执行');
  assert.equal(stats.instructions, 10_000, '总指令数应等于预算');
});

test('runInteractive：afterChunk 返回 false 可终止整个运行', async () => {
  const m = new Machine({ memSize: 64n * 1024n * 1024n } as MachineOptions);
  const stats = await m.runInteractive({
    maxInstructions: 100_000,
    chunk: 10_000,
    afterChunk: (total) => (total >= 20_000 ? false : undefined),
  });
  assert.ok(stats.instructions <= 20_000, `onStep 终止应尽早停止（实际 ${stats.instructions}）`);
});
