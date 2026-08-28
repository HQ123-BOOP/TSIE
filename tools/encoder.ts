/**
 * RISC-V 指令编码器（手写机器码，用于单元测试与裸机示例程序）。
 * 所有函数返回 32 位（压缩指令为 16 位）无符号机器码。
 */

const OP_LUI = 0x37;
const OP_AUIPC = 0x17;
const OP_JAL = 0x6f;
const OP_JALR = 0x67;
const OP_BRANCH = 0x63;
const OP_LOAD = 0x03;
const OP_STORE = 0x23;
const OP_IMM = 0x13;
const OP_IMM32 = 0x1b;
const OP_OP = 0x33;
const OP_OP32 = 0x3b;
const OP_FENCE = 0x0f;
const OP_SYSTEM = 0x73;
const OP_AMO = 0x2f;
const OP_LOAD_FP = 0x07;
const OP_STORE_FP = 0x27;
const OP_FP = 0x53;
const OP_MADD = 0x43;
const OP_MSUB = 0x47;
const OP_NMSUB = 0x4b;
const OP_NMADD = 0x4f;

type Reg = number;

function R(opcode: number, rd: Reg, f3: number, rs1: Reg, rs2: Reg, f7: number): number {
  return (((f7 & 0x7f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((f3 & 0x7) << 12) | ((rd & 0x1f) << 7) | opcode) >>> 0;
}
function I(opcode: number, rd: Reg, f3: number, rs1: Reg, imm: number): number {
  return (((imm & 0xfff) << 20) | ((rs1 & 0x1f) << 15) | ((f3 & 0x7) << 12) | ((rd & 0x1f) << 7) | opcode) >>> 0;
}
function S(opcode: number, f3: number, rs1: Reg, rs2: Reg, imm: number): number {
  const lo = imm & 0x1f;
  const hi = (imm >> 5) & 0x7f;
  return (((hi << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((f3 & 0x7) << 12) | (lo << 7) | opcode) >>> 0);
}
function B(opcode: number, f3: number, rs1: Reg, rs2: Reg, imm: number): number {
  return (
    ((((imm >> 12) & 1) << 31) |
      (((imm >> 5) & 0x3f) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      ((f3 & 0x7) << 12) |
      (((imm >> 1) & 0xf) << 8) |
      (((imm >> 11) & 1) << 7) |
      opcode) >>>
    0
  );
}
function U(opcode: number, rd: Reg, imm: number): number {
  return (((imm & 0xfffff000) | ((rd & 0x1f) << 7) | opcode) >>> 0);
}
function J(opcode: number, rd: Reg, imm: number): number {
  return (
    ((((imm >> 20) & 1) << 31) |
      (((imm >> 1) & 0x3ff) << 21) |
      (((imm >> 11) & 1) << 20) |
      (((imm >> 12) & 0xff) << 12) |
      ((rd & 0x1f) << 7) |
      opcode) >>>
    0
  );
}

// ---------------- RV64I ----------------
export const lui = (rd: Reg, imm: number) => U(OP_LUI, rd, imm);
export const auipc = (rd: Reg, imm: number) => U(OP_AUIPC, rd, imm);
export const jal = (rd: Reg, imm: number) => J(OP_JAL, rd, imm);
export const jalr = (rd: Reg, rs1: Reg, imm = 0) => I(OP_JALR, rd, 0, rs1, imm);

export const beq = (rs1: Reg, rs2: Reg, imm: number) => B(OP_BRANCH, 0, rs1, rs2, imm);
export const bne = (rs1: Reg, rs2: Reg, imm: number) => B(OP_BRANCH, 1, rs1, rs2, imm);
export const blt = (rs1: Reg, rs2: Reg, imm: number) => B(OP_BRANCH, 4, rs1, rs2, imm);
export const bge = (rs1: Reg, rs2: Reg, imm: number) => B(OP_BRANCH, 5, rs1, rs2, imm);
export const bltu = (rs1: Reg, rs2: Reg, imm: number) => B(OP_BRANCH, 6, rs1, rs2, imm);
export const bgeu = (rs1: Reg, rs2: Reg, imm: number) => B(OP_BRANCH, 7, rs1, rs2, imm);

export const lb = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 0, rs1, imm);
export const lh = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 1, rs1, imm);
export const lw = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 2, rs1, imm);
export const ld = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 3, rs1, imm);
export const lbu = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 4, rs1, imm);
export const lhu = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 5, rs1, imm);
export const lwu = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD, rd, 6, rs1, imm);

export const sb = (rs1: Reg, rs2: Reg, imm = 0) => S(OP_STORE, 0, rs1, rs2, imm);
export const sh = (rs1: Reg, rs2: Reg, imm = 0) => S(OP_STORE, 1, rs1, rs2, imm);
export const sw = (rs1: Reg, rs2: Reg, imm = 0) => S(OP_STORE, 2, rs1, rs2, imm);
export const sd = (rs1: Reg, rs2: Reg, imm = 0) => S(OP_STORE, 3, rs1, rs2, imm);

export const addi = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM, rd, 0, rs1, imm);
export const slti = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM, rd, 2, rs1, imm);
export const sltiu = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM, rd, 3, rs1, imm);
export const xori = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM, rd, 4, rs1, imm);
export const ori = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM, rd, 6, rs1, imm);
export const andi = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM, rd, 7, rs1, imm);
export const slli = (rd: Reg, rs1: Reg, sh: number) => I(OP_IMM, rd, 1, rs1, (sh & 0x3f) | 0x000);
export const srli = (rd: Reg, rs1: Reg, sh: number) => I(OP_IMM, rd, 5, rs1, (sh & 0x3f) | 0x000);
export const srai = (rd: Reg, rs1: Reg, sh: number) => I(OP_IMM, rd, 5, rs1, (sh & 0x3f) | 0x400);

export const add = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 0, rs1, rs2, 0x00);
export const sub = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 0, rs1, rs2, 0x20);
export const sll = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 1, rs1, rs2, 0x00);
export const slt = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 2, rs1, rs2, 0x00);
export const sltu = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 3, rs1, rs2, 0x00);
export const xor_ = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 4, rs1, rs2, 0x00);
export const srl = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 5, rs1, rs2, 0x00);
export const sra = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 5, rs1, rs2, 0x20);
export const or_ = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 6, rs1, rs2, 0x00);
export const and_ = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 7, rs1, rs2, 0x00);

export const addiw = (rd: Reg, rs1: Reg, imm: number) => I(OP_IMM32, rd, 0, rs1, imm);
export const slliw = (rd: Reg, rs1: Reg, sh: number) => I(OP_IMM32, rd, 1, rs1, sh & 0x1f);
export const srliw = (rd: Reg, rs1: Reg, sh: number) => I(OP_IMM32, rd, 5, rs1, sh & 0x1f);
export const sraiw = (rd: Reg, rs1: Reg, sh: number) => I(OP_IMM32, rd, 5, rs1, (sh & 0x1f) | 0x400);

export const addw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 0, rs1, rs2, 0x00);
export const subw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 0, rs1, rs2, 0x20);
export const sllw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 1, rs1, rs2, 0x00);
export const srlw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 5, rs1, rs2, 0x00);
export const sraw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 5, rs1, rs2, 0x20);

export const fence = (fm = 0, pred = 0xf, succ = 0xf) =>
  (((fm & 0xf) << 28) | ((pred & 0xf) << 24) | ((succ & 0xf) << 20) | OP_FENCE) >>> 0;
export const fenceI = () => I(OP_FENCE, 0, 1, 0, 0);
export const ecall = () => I(OP_SYSTEM, 0, 0, 0, 0);
export const ebreak = () => I(OP_SYSTEM, 0, 0, 0, 1);
export const sret = () => I(OP_SYSTEM, 0, 0, 0, 0x102);
export const mret = () => I(OP_SYSTEM, 0, 0, 0, 0x302);
export const wfi = () => I(OP_SYSTEM, 0, 0, 0, 0x105);
export const sfenceVma = (rs1 = 0, rs2 = 0) => (((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | (0x9 << 25) | OP_SYSTEM) >>> 0;

// ---------------- Zicsr ----------------
export const csrrw = (rd: Reg, csr: number, rs1: Reg) => I(OP_SYSTEM, rd, 1, rs1, csr);
export const csrrs = (rd: Reg, csr: number, rs1: Reg) => I(OP_SYSTEM, rd, 2, rs1, csr);
export const csrrc = (rd: Reg, csr: number, rs1: Reg) => I(OP_SYSTEM, rd, 3, rs1, csr);
export const csrrwi = (rd: Reg, csr: number, uimm: number) => I(OP_SYSTEM, rd, 5, uimm & 0x1f, csr);
export const csrrsi = (rd: Reg, csr: number, uimm: number) => I(OP_SYSTEM, rd, 6, uimm & 0x1f, csr);
export const csrrci = (rd: Reg, csr: number, uimm: number) => I(OP_SYSTEM, rd, 7, uimm & 0x1f, csr);
/** 伪指令：读 CSR */
export const csrr = (rd: Reg, csr: number) => csrrs(rd, csr, 0);
/** 伪指令：写 CSR */
export const csrw = (csr: number, rs1: Reg) => csrrw(0, csr, rs1);
/** 伪指令：置位 CSR */
export const csrs = (csr: number, rs1: Reg) => csrrs(0, csr, rs1);
/** 伪指令：清位 CSR */
export const csrc = (csr: number, rs1: Reg) => csrrc(0, csr, rs1);

// ---------------- M 扩展 ----------------
export const mul = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 0, rs1, rs2, 0x01);
export const mulh = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 1, rs1, rs2, 0x01);
export const mulhsu = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 2, rs1, rs2, 0x01);
export const mulhu = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 3, rs1, rs2, 0x01);
export const div = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 4, rs1, rs2, 0x01);
export const divu = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 5, rs1, rs2, 0x01);
export const rem = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 6, rs1, rs2, 0x01);
export const remu = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP, rd, 7, rs1, rs2, 0x01);
export const mulw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 0, rs1, rs2, 0x01);
export const divw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 4, rs1, rs2, 0x01);
export const divuw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 5, rs1, rs2, 0x01);
export const remw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 6, rs1, rs2, 0x01);
export const remuw = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_OP32, rd, 7, rs1, rs2, 0x01);

// ---------------- A 扩展 ----------------
function amo(f5: number, rd: Reg, rs1: Reg, rs2: Reg, f3: number, aq = 0, rl = 0): number {
  const f7 = ((f5 & 0x1f) << 2) | ((aq & 1) << 1) | (rl & 1);
  return R(OP_AMO, rd, f3, rs1, rs2, f7);
}
export const amoaddw = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x00, rd, rs1, rs2, 2);
export const amoswapw = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x01, rd, rs1, rs2, 2);
export const amoandw = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x0c, rd, rs1, rs2, 2);
export const amoorw = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x08, rd, rs1, rs2, 2);
export const amoxorw = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x04, rd, rs1, rs2, 2);
export const amomaxw = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x14, rd, rs1, rs2, 2);
export const amoadd_d = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x00, rd, rs1, rs2, 3);
export const amoswapd = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x01, rd, rs1, rs2, 3);
export const lr_w = (rd: Reg, rs1: Reg) => amo(0x02, rd, rs1, 0, 2);
export const sc_w = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x03, rd, rs1, rs2, 2);
export const lr_d = (rd: Reg, rs1: Reg) => amo(0x02, rd, rs1, 0, 3);
export const sc_d = (rd: Reg, rs1: Reg, rs2: Reg) => amo(0x03, rd, rs1, rs2, 3);

// ---------------- F / D 扩展 ----------------
export const flw = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD_FP, rd, 2, rs1, imm);
export const fld = (rd: Reg, rs1: Reg, imm = 0) => I(OP_LOAD_FP, rd, 3, rs1, imm);
export const fsw = (rs1: Reg, rs2: Reg, imm = 0) => S(OP_STORE_FP, 2, rs1, rs2, imm);
export const fsd = (rs1: Reg, rs2: Reg, imm = 0) => S(OP_STORE_FP, 3, rs1, rs2, imm);

export const fadds = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x00);
export const fsubs = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x04);
export const fmuls = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x08);
export const fdivs = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x0c);
export const fsgnjs = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 0, rs1, rs2, 0x10);
export const fsgnjns = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 1, rs1, rs2, 0x10);
export const fsgnjxs = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 2, rs1, rs2, 0x10);
export const fmins = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 0, rs1, rs2, 0x14);
export const fmaxs = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 1, rs1, rs2, 0x14);
export const fsqrts = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 0, 0x2c);
export const fles = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 0, rs1, rs2, 0x50);
export const flts = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 1, rs1, rs2, 0x50);
export const feqs = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 2, rs1, rs2, 0x50);
export const fcvtws = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 0, 0x60);
export const fcvtsw = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 0, 0x68);
export const fmvxw = (rd: Reg, rs1: Reg) => R(OP_FP, rd, 0, rs1, 0, 0x70);
export const fmvwx = (rd: Reg, rs1: Reg) => R(OP_FP, rd, 0, rs1, 0, 0x78);
export const fclasss = (rd: Reg, rs1: Reg) => R(OP_FP, rd, 1, rs1, 0, 0x70);

export const faddd = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x01);
export const fsubd = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x05);
export const fmuld = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x09);
export const fdivd = (rd: Reg, rs1: Reg, rs2: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, rs2, 0x0d);
export const fsqrtd = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 0, 0x2d);
export const fsgnjd = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 0, rs1, rs2, 0x11);
export const fcvtsd = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 1, 0x20);
export const fcvtds = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 0, 0x21);
export const fcvtld = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 2, 0x61);
export const fcvtdl = (rd: Reg, rs1: Reg, rm = 0) => R(OP_FP, rd, rm, rs1, 2, 0x69);
export const fmvxd = (rd: Reg, rs1: Reg) => R(OP_FP, rd, 0, rs1, 0, 0x71);
export const fmvdx = (rd: Reg, rs1: Reg) => R(OP_FP, rd, 0, rs1, 0, 0x79);
export const fclassd = (rd: Reg, rs1: Reg) => R(OP_FP, rd, 1, rs1, 0, 0x71);
export const fled = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 0, rs1, rs2, 0x51);
export const fltd = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 1, rs1, rs2, 0x51);
export const feqd = (rd: Reg, rs1: Reg, rs2: Reg) => R(OP_FP, rd, 2, rs1, rs2, 0x51);

function fma(op: number, rd: Reg, rm: number, rs1: Reg, rs2: Reg, rs3: Reg, fmt: number): number {
  return ((((rs3 & 0x1f) << 27) | ((fmt & 0x3) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((rm & 0x7) << 12) | ((rd & 0x1f) << 7) | op) >>> 0);
}
export const fmadds = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_MADD, rd, rm, rs1, rs2, rs3, 0);
export const fmaddd = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_MADD, rd, rm, rs1, rs2, rs3, 1);
export const fmsubs = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_MSUB, rd, rm, rs1, rs2, rs3, 0);
export const fmsubd = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_MSUB, rd, rm, rs1, rs2, rs3, 1);
export const fnmsubs = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_NMSUB, rd, rm, rs1, rs2, rs3, 0);
export const fnmsubd = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_NMSUB, rd, rm, rs1, rs2, rs3, 1);
export const fnmadds = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_NMADD, rd, rm, rs1, rs2, rs3, 0);
export const fnmaddd = (rd: Reg, rs1: Reg, rs2: Reg, rs3: Reg, rm = 0) => fma(OP_NMADD, rd, rm, rs1, rs2, rs3, 1);

// ---------------- C 扩展（RV64C 常用子集） ----------------
function ci(op: number, f3: number, rdFull: number, imm6: number): number {
  return (op | (f3 << 13) | (((imm6 >> 5) & 1) << 12) | ((rdFull & 0x1f) << 7) | ((imm6 & 0x1f) << 2)) >>> 0;
}
export const c_nop = () => ci(1, 0, 0, 0);
export const c_addi = (rd: Reg, imm: number) => ci(1, 0, rd, imm & 0x3f);
export const c_addiw = (rd: Reg, imm: number) => ci(1, 1, rd, imm & 0x3f);
export const c_li = (rd: Reg, imm: number) => ci(1, 2, rd, imm & 0x3f);
export const c_lui = (rd: Reg, imm: number) => ci(1, 3, rd, imm & 0x3f);
export const c_slli = (rd: Reg, sh: number) => ci(2, 0, rd, sh & 0x3f);
export const c_srli = (rdp: Reg, sh: number) =>
  (1 | (4 << 13) | (0 << 10) | (((sh >> 5) & 1) << 12) | ((rdp & 7) << 7) | ((sh & 0x1f) << 2)) >>> 0;
export const c_srai = (rdp: Reg, sh: number) =>
  (1 | (4 << 13) | (1 << 10) | (((sh >> 5) & 1) << 12) | ((rdp & 7) << 7) | ((sh & 0x1f) << 2)) >>> 0;
export const c_andi = (rdp: Reg, imm: number) =>
  (1 | (4 << 13) | (2 << 10) | (((imm >> 5) & 1) << 12) | ((rdp & 7) << 7) | ((imm & 0x1f) << 2)) >>> 0;
export const c_mv = (rd: Reg, rs2: Reg) => (2 | (4 << 13) | ((rd & 0x1f) << 7) | ((rs2 & 0x1f) << 2)) >>> 0;
export const c_add = (rd: Reg, rs2: Reg) => (2 | (4 << 13) | (1 << 12) | ((rd & 0x1f) << 7) | ((rs2 & 0x1f) << 2)) >>> 0;
export const c_jr = (rs1: Reg) => (2 | (4 << 13) | ((rs1 & 0x1f) << 7)) >>> 0;
export const c_jalr = (rs1: Reg) => (2 | (4 << 13) | (1 << 12) | ((rs1 & 0x1f) << 7)) >>> 0;
export const c_ebreak = () => (2 | (4 << 13) | (1 << 12)) >>> 0;
export const c_sub = (rdp: Reg, rs2p: Reg) => (1 | (4 << 13) | (3 << 10) | ((rdp & 7) << 7) | ((rs2p & 7) << 2)) >>> 0;
export const c_xor = (rdp: Reg, rs2p: Reg) => (1 | (4 << 13) | (3 << 10) | (1 << 5) | ((rdp & 7) << 7) | ((rs2p & 7) << 2)) >>> 0;
export const c_or = (rdp: Reg, rs2p: Reg) => (1 | (4 << 13) | (3 << 10) | (2 << 5) | ((rdp & 7) << 7) | ((rs2p & 7) << 2)) >>> 0;
export const c_and = (rdp: Reg, rs2p: Reg) => (1 | (4 << 13) | (3 << 10) | (3 << 5) | ((rdp & 7) << 7) | ((rs2p & 7) << 2)) >>> 0;

/** C.LD / C.SD：offset 为 8 的倍数且 < 256 */
export const c_ld = (rdp: Reg, rs1p: Reg, off: number) =>
  ((((off >> 3) & 0x7) << 10) | ((rs1p & 7) << 7) | (((off >> 6) & 0x3) << 5) | (3 << 13) | ((rdp & 7) << 2)) >>> 0;
export const c_sd = (rs1p: Reg, rs2p: Reg, off: number) =>
  ((((off >> 3) & 0x7) << 10) | ((rs1p & 7) << 7) | (((off >> 6) & 0x3) << 5) | (7 << 13) | ((rs2p & 7) << 2)) >>> 0;
export const c_lw = (rdp: Reg, rs1p: Reg, off: number) =>
  ((((off >> 3) & 0x7) << 10) | ((rs1p & 7) << 7) | (((off >> 2) & 1) << 6) | (((off >> 6) & 1) << 5) | (2 << 13) | ((rdp & 7) << 2)) >>> 0;
export const c_sw = (rs1p: Reg, rs2p: Reg, off: number) =>
  ((((off >> 3) & 0x7) << 10) | ((rs1p & 7) << 7) | (((off >> 2) & 1) << 6) | (((off >> 6) & 1) << 5) | (6 << 13) | ((rs2p & 7) << 2)) >>> 0;

/** C.LDSP：offset 为 8 的倍数且 < 512 */
export const c_ldsp = (rd: Reg, off: number) =>
  (2 | (3 << 13) | (((off >> 5) & 1) << 12) | ((rd & 0x1f) << 7) | (((off >> 3) & 0x3) << 5) | (((off >> 6) & 0x7) << 2)) >>> 0;
export const c_sdsp = (rs2: Reg, off: number) =>
  (2 | (7 << 13) | (((off >> 3) & 0x7) << 10) | (((off >> 6) & 0x7) << 7) | ((rs2 & 0x1f) << 2)) >>> 0;
export const c_lwsp = (rd: Reg, off: number) =>
  (2 | (2 << 13) | (((off >> 5) & 1) << 12) | ((rd & 0x1f) << 7) | (((off >> 2) & 0x7) << 4) | (((off >> 6) & 0x3) << 2)) >>> 0;
export const c_swsp = (rs2: Reg, off: number) =>
  (2 | (6 << 13) | (((off >> 2) & 0xf) << 9) | (((off >> 6) & 0x3) << 7) | ((rs2 & 0x1f) << 2)) >>> 0;

/** C.J：offset 为 2 的倍数，范围 ±2048 */
export const c_j = (off: number): number => {
  const v = off;
  return (
    (1 |
      (5 << 13) |
      (((v >> 11) & 1) << 12) |
      (((v >> 4) & 1) << 11) |
      (((v >> 8) & 3) << 9) |
      (((v >> 10) & 1) << 8) |
      (((v >> 6) & 1) << 7) |
      (((v >> 7) & 1) << 6) |
      (((v >> 1) & 7) << 3) |
      (((v >> 5) & 1) << 2)) >>>
    0
  );
};

/** C.BEQZ / C.BNEZ */
export const c_beqz = (rs1p: Reg, off: number): number => cBranch(6, rs1p, off);
export const c_bnez = (rs1p: Reg, off: number): number => cBranch(7, rs1p, off);

function cBranch(f3: number, rs1p: Reg, off: number): number {
  return (
    (1 |
      (f3 << 13) |
      (((off >> 8) & 1) << 12) |
      (((off >> 3) & 3) << 10) |
      ((rs1p & 7) << 7) |
      (((off >> 6) & 3) << 5) |
      (((off >> 1) & 3) << 3) |
      (((off >> 5) & 1) << 2)) >>>
    0
  );
}

/** C.ADDI4SPN */
export const c_addi4spn = (rdp: Reg, nzuimm: number): number =>
  ((((nzuimm >> 4) & 3) << 11) |
    (((nzuimm >> 6) & 0xf) << 7) |
    (((nzuimm >> 2) & 1) << 6) |
    (((nzuimm >> 3) & 1) << 5) |
    ((rdp & 7) << 2)) >>>
    0;

/** C.ADDI16SP：nzimm 为 10 位有符号、低 4 位为 0 */
export const c_addi16sp = (nzuimm: number): number =>
  (1 |
    (3 << 13) |
    (((nzuimm >> 9) & 1) << 12) |
    (2 << 7) |
    (((nzuimm >> 7) & 3) << 3) |
    (((nzuimm >> 6) & 1) << 5) |
    (((nzuimm >> 5) & 1) << 2) |
    (((nzuimm >> 4) & 1) << 6)) >>>
    0;

/** 构造 32 位常量（lui + addi，结果为该 32 位的符号扩展） */
export function li32(rd: Reg, value: number): number[] {
  const w = value >>> 0;
  const hi20 = (((w + 0x800) >>> 12) & 0xfffff) >>> 0;
  const lo12 = w & 0xfff;
  const out: number[] = [lui(rd, (hi20 << 12) >>> 0)];
  if (lo12 !== 0) out.push(addi(rd, rd, sext12(lo12)));
  return out;
}

/**
 * 把任意 64 位常量装入 rd。
 * @param scratch 拼接高/低半部时使用的临时寄存器（会被改写）
 */
export function li(rd: Reg, value: bigint | number, scratch: Reg = 31): number[] {
  const v = BigInt.asUintN(64, BigInt(value));
  const lo = Number(v & 0xffffffffn) >>> 0;
  const hi = Number((v >> 32n) & 0xffffffffn) >>> 0;

  if (hi === 0 && (lo & 0x80000000) === 0) return li32(rd, lo);
  if (hi === 0xffffffff && (lo & 0x80000000) !== 0) {
    // 负的小立即数：直接 addi / li32
    const imm = Number(BigInt.asIntN(32, BigInt(lo)));
    if (imm >= -2048 && imm < 2048) return [addi(rd, 0, imm)];
    return li32(rd, lo);
  }

  const out: number[] = [];
  out.push(...li32(rd, hi)); // 高 32 位（符号扩展）
  out.push(slli(rd, rd, 32)); // 移到高半部，低半部清零
  if (lo !== 0) {
    out.push(...li32(scratch, lo));
    out.push(slli(scratch, scratch, 32));
    out.push(srli(scratch, scratch, 32)); // 零扩展低 32 位
    out.push(or_(rd, rd, scratch));
  }
  return out;
}

function sext12(v: number): number {
  return v >= 0x800 ? v - 0x1000 : v;
}
