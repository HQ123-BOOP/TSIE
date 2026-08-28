/**
 * 扁平设备树（DTB）生成器 —— 不依赖外部库，够用即可。
 */

const FDT_BEGIN_NODE = 1;
const FDT_END_NODE = 2;
const FDT_PROP = 3;
const FDT_END = 9;

const FDT_MAGIC = 0xd00dfeed;
const FDT_VERSION = 17;
const FDT_LAST_COMP_VERSION = 16;

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}

function u64be(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v & 0xffffffffffffffffn, false);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function cstr(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s + '\0');
  return enc;
}

export class FdtNode {
  readonly name: string;
  readonly props: Array<{ name: string; value: Uint8Array }> = [];
  readonly children: FdtNode[] = [];

  constructor(name: string) {
    this.name = name;
  }

  prop(name: string, value: Uint8Array): this {
    this.props.push({ name, value });
    return this;
  }

  propU32(name: string, values: number[]): this {
    return this.prop(name, concat(values.map(u32be)));
  }

  propU64(name: string, values: bigint[]): this {
    return this.prop(name, concat(values.map(u64be)));
  }

  propStr(name: string, value: string): this {
    return this.prop(name, cstr(value));
  }

  propStrList(name: string, values: string[]): this {
    return this.prop(name, concat(values.map(cstr)));
  }

  propEmpty(name: string): this {
    return this.prop(name, new Uint8Array(0));
  }

  /** reg = <addr size> 对，均为 64 位 */
  propReg(name: string, pairs: Array<[bigint, bigint]>): this {
    const parts: Uint8Array[] = [];
    for (const [a, s] of pairs) {
      parts.push(u64be(a), u64be(s));
    }
    return this.prop(name, concat(parts));
  }

  addChild(name: string): FdtNode {
    const n = new FdtNode(name);
    this.children.push(n);
    return n;
  }

  child(node: FdtNode): this {
    this.children.push(node);
    return this;
  }
}

export function buildDtb(root: FdtNode): Uint8Array {
  const strings: string[] = [];
  const stringOffsets = new Map<string, number>();
  let stringLen = 0;

  const stringOff = (s: string): number => {
    const existing = stringOffsets.get(s);
    if (existing !== undefined) return existing;
    const off = stringLen;
    strings.push(s);
    stringOffsets.set(s, off);
    stringLen += cstr(s).length;
    return off;
  };

  const structParts: Uint8Array[] = [];

  const emitNode = (node: FdtNode): void => {
    structParts.push(u32be(FDT_BEGIN_NODE));
    const nameBytes = cstr(node.name);
    structParts.push(nameBytes);
    if (pad4(nameBytes.length)) structParts.push(new Uint8Array(pad4(nameBytes.length)));
    for (const p of node.props) {
      structParts.push(u32be(FDT_PROP), u32be(p.value.length), u32be(stringOff(p.name)), p.value);
      if (pad4(p.value.length)) structParts.push(new Uint8Array(pad4(p.value.length)));
    }
    for (const c of node.children) emitNode(c);
    structParts.push(u32be(FDT_END_NODE));
  };

  emitNode(root);
  structParts.push(u32be(FDT_END));

  const structBlob = concat(structParts);
  const stringsBlob = concat(strings.map(cstr));

  const headerSize = 40;
  const memRsvSize = 16; // 两个 64 位 0（地址 + 大小）
  const offStruct = headerSize + memRsvSize;
  const offStrings = offStruct + structBlob.length;
  const totalSize = offStrings + stringsBlob.length;

  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, FDT_MAGIC, false);
  dv.setUint32(4, totalSize, false);
  dv.setUint32(8, offStruct, false);
  dv.setUint32(12, offStrings, false);
  dv.setUint32(16, headerSize, false); // off_mem_rsvmap
  dv.setUint32(20, FDT_VERSION, false);
  dv.setUint32(24, FDT_LAST_COMP_VERSION, false);
  dv.setUint32(28, 0, false); // boot_cpuid_phys
  dv.setUint32(32, stringsBlob.length, false);
  dv.setUint32(36, structBlob.length, false);
  buf.set(structBlob, offStruct);
  buf.set(stringsBlob, offStrings);
  return buf;
}
