#!/usr/bin/env python3
"""汇总 V8 CPU profile（node --cpu-prof 产出的 .cpuprofile）。

按**自身耗时**（self time）聚合函数，输出 top-N。自身耗时 = 该函数栈顶被采样到的次数，
也就是"真正花在它自己身上的时间"，不含它调用的子函数 —— 找优化点时看的就是这个。

用法：
    python tools/prof-summary.py <file.cpuprofile> [topN] [--filter 子串]

--filter 只保留 url 或函数名含该子串的帧（例如只看 src/ 下的模拟器代码，排除 node 内部与 tsx）。
"""
import json
import sys
from collections import defaultdict


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    top_n = 20
    only = None
    rest = sys.argv[2:]
    i = 0
    while i < len(rest):
        if rest[i] == '--filter' and i + 1 < len(rest):
            only = rest[i + 1]
            i += 2
            continue
        top_n = int(rest[i])
        i += 1

    with open(path, encoding='utf-8') as f:
        prof = json.load(f)

    # samples[i] 是该次采样的叶子节点 id；hitCount 与之一致，直接用 hitCount 聚合
    self_hits: dict[int, int] = defaultdict(int)
    for node in prof.get('nodes', []):
        h = node.get('hitCount', 0)
        if h:
            self_hits[node['id']] += h

    by_node = {n['id']: n for n in prof.get('nodes', [])}
    total = sum(self_hits.values())
    if total == 0:
        print('profile 里没有采样（运行太短？）')
        return 1

    agg: dict[str, int] = defaultdict(int)
    for nid, hits in self_hits.items():
        cf = by_node[nid]['callFrame']
        fn = cf.get('functionName') or '(anonymous)'
        url = cf.get('url') or ''
        if only and only not in fn and only not in url:
            continue
        # 把路径裁短一点，便于阅读
        short = url.replace('file:///', '').replace('\\', '/').split('/')[-1] if url else ''
        key = f'{fn}  [{short}:{cf.get("lineNumber", -1) + 1}]'
        agg[key] += hits

    shown = sum(agg.values())
    print(f'总采样 {total} 次' + (f'，其中匹配 "{only}" 的 {shown} 次（{100 * shown / total:.1f}%）' if only else ''))
    print(f'{"自身耗时":>9}  {"占比":>7}  函数')
    for key, hits in sorted(agg.items(), key=lambda kv: -kv[1])[:top_n]:
        print(f'{hits:>9}  {100 * hits / total:>6.2f}%  {key}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
