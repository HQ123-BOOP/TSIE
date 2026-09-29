// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * 文案表读取器（Node 侧）。
 *
 * 表是**单一来源**：tools/i18n/messages.tsv（key<TAB>中文<TAB>English）。
 * 选 TSV 而不是 JSON 是因为要三种语言零依赖读它 —— bash 没有内置 JSON 解析器，
 * 为了这个引 jq 就多一个依赖；PowerShell 侧同理不愿依赖 Import-Csv。
 *
 * 语言优先级与两个 bootstrap 脚本一致：TSIE_LANG > 环境区域 > 系统区域；
 * 明确是英文才算英文，其余（含认不出来）一律中文。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Lang = 'zh' | 'en';

const MSG_FILE = join(dirname(fileURLToPath(import.meta.url)), 'messages.tsv');

export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const explicit = (env.TSIE_LANG ?? '').toLowerCase();
  if (explicit === 'zh' || explicit === 'en') return explicit;
  const loc = `${env.LC_ALL ?? ''}${env.LC_MESSAGES ?? ''}${env.LANG ?? ''}`;
  if (loc) return /en/i.test(loc) ? 'en' : 'zh';
  // Node 的 Intl 区域等于系统区域；认不出来时按中文（与脚本同规则）
  const sys = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  return /^en/i.test(sys) ? 'en' : 'zh';
}

export interface Catalogue {
  readonly lang: Lang;
  /** 取当前语言的文案：字面 `\n` 变真换行，再顺序替换 {0}{1}…；键不存在时返回键名 */
  t(key: string, ...args: Array<string | number | boolean>): string;
}

/** 只想要那个查表函数时用它（例如把它当参数传下去）。 */
export type Translate = Catalogue['t'];

export function loadMessages(lang: Lang = detectLang()): Catalogue {
  const table = new Map<string, string>();
  for (const raw of readFileSync(MSG_FILE, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const [key, zh, en] = line.split('\t');
    if (!key || zh === undefined) continue;
    table.set(key, lang === 'en' ? en || zh : zh);
  }
  return {
    lang,
    t(key, ...args) {
      let s = table.get(key) ?? key;
      s = s.replace(/\\n/g, '\n');
      for (const [i, a] of args.entries()) s = s.split(`{${i}}`).join(String(a));
      return s;
    },
  };
}
