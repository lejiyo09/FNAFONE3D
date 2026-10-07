"""Minimal Unity YAML (scene/prefab/mat/anim) reader + GUID index."""
import re, os, yaml, functools

class _L(yaml.SafeLoader): pass
_L.add_multi_constructor('tag:unity3d.com,2011:', lambda l, s, n: l.construct_mapping(n, deep=True) if isinstance(n, yaml.MappingNode) else None)

HDR = re.compile(r'^--- !u!(\d+) &(-?\d+)( stripped)?\s*$', re.M)

def load_docs(path):
    txt = open(path, encoding='utf-8', errors='replace').read()
    parts = HDR.split(txt)
    docs = {}
    # parts: [pre, cls, id, stripped, body, cls, id, stripped, body ...]
    for i in range(1, len(parts), 4):
        cls, fid, stripped, body = int(parts[i]), int(parts[i+1]), bool(parts[i+2]), parts[i+3]
        try:
            d = yaml.load(body, Loader=_L)
        except Exception as e:
            d = {'_err': str(e)}
        if isinstance(d, dict) and len(d) == 1:
            name, val = next(iter(d.items()))
        else:
            name, val = '?', d
        docs[fid] = {'cls': cls, 'type': name, 'd': val if isinstance(val, dict) else {}, 'stripped': stripped, 'id': fid}
    return docs

@functools.lru_cache(None)
def guid_index(root):
    idx = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.endswith('.meta'):
                p = os.path.join(dp, f)
                m = re.search(r'^guid: ([0-9a-f]{32})', open(p, errors='replace').read(), re.M)
                if m: idx[m.group(1)] = p[:-5]
    return idx
