/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * NX（X=0）页取指拦截回归测试。
 *
 * 覆盖三件事：
 *  1. 4KB 粒度 RW- 页取指必须 fault；
 *  2. 2MB 超级页 RW- 取指必须 fault；
 *  3. 先以 RWX 建好取指缓存，再改成 RW- 并让 MMU 重新同步，取指必须重新 fault
 *     （缓存不能把已撤销的 X 权限"记住"）。
 *
 * 两个易错点，之前的临时探针两个都踩了：
 *  - 异常码是 InstPageFault(12)，权限违规走缺页异常，不是 InstAccessFault(1)；
 *  - 测试虚拟地址必须落在 TEST_RAM_SIZE 之内。TEST_RAM_SIZE 是 4MB，
 *    所以 TEST_BASE + 0x400000 正好等于 RAM 末尾、属于越界——那样即使翻译成功，
 *    随后的物理读也会因为 BusError 报 InstAccessFault，把"权限拦截"和"总线越界"
 *    两个完全不同的原因混在一起。这里一律使用 RAM 内的地址。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSR, Exc } from '../src/cpu/csr.ts';
import { Sv39Mapper, PTE_A, PTE_D, PTE_R, PTE_W, PTE_X, TEST_BASE, halt, makeCpu } from './harness.ts';

const ROOT = TEST_BASE + 0x300000n;
const POOL = TEST_BASE + 0x301000n;
/** 2MB 对齐、且位于 4MB RAM 内 */
const VA = TEST_BASE + 0x200000n;

/** 建一张 Sv39 页表并把 satp 指向它，使 MMU 生效（priv=S） */
function enableSv39(h: ReturnType<typeof makeCpu>): Sv39Mapper {
  const pt = new Sv39Mapper(h, ROOT, POOL);
  h.cpu.priv = 1; // Priv.S
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp(8n, 0n));
  h.cpu.syncMmu();
  return pt;
}

test('4KB RW-（X=0）页取指必须 fault，异常码为 InstPageFault', () => {
  const h = makeCpu([...halt()]);
  const pt = enableSv39(h);
  pt.map(VA, VA, PTE_R | PTE_W | PTE_A | PTE_D, 0);

  assert.equal(h.cpu.mmu.fetch16(VA), null, '4KB NX 页居然取到了指令！');
  assert.equal(h.cpu.mmu.faultCause, Exc.InstPageFault);
});

test('2MB RW-（X=0）超级页取指必须 fault，异常码为 InstPageFault', () => {
  const h = makeCpu([...halt()]);
  const pt = enableSv39(h);
  pt.map(VA, VA, PTE_R | PTE_W | PTE_A | PTE_D, 1);

  assert.equal(h.cpu.mmu.fetch16(VA), null, '2MB NX 页居然取到了指令！');
  assert.equal(h.cpu.mmu.faultCause, Exc.InstPageFault);
});

test('RWX 建缓存后改 RW-，取指必须重新 fault（旧 X 权限不得残留）', () => {
  const h = makeCpu([...halt()]);
  const pt = enableSv39(h);

  // 先给 X，取一次指，让快路径/TLB 里留下"可执行"的条目
  pt.map(VA, VA, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  assert.notEqual(h.cpu.mmu.fetch16(VA), null, 'RWX 页首次取指应当成功（用于建立缓存）');

  // 摘掉 X，并让 CPU 把新的 satp/mstatus 同步进 MMU（真实硬件里由 sfence.vma 触发）
  pt.map(VA, VA, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp(8n, 0n));
  h.cpu.syncMmu();

  assert.equal(h.cpu.mmu.fetch16(VA), null, '摘掉 X 后取指仍成功 → 缓存的旧 X 权限未被清掉（BUG）');
  assert.equal(h.cpu.mmu.faultCause, Exc.InstPageFault);
});
