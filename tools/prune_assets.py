#!/usr/bin/env python3
"""Delete web/assets files the web build never loads (run after export_assets.py and extract_clips.js)."""
import json, os, sys
W = sys.argv[1] if len(sys.argv) > 1 else 'web'
g = json.load(open(f'{W}/data/game.json')); A = json.load(open(f'{W}/data/assets.json')); ml = json.load(open(f'{W}/data/matlib.json'))
amap = A['map']
models = set(g['models'])
for p in g['prefabs'].values(): models |= set(p.get('models', []))
models.discard('Assets/Characters/Player/hand.fbx')           # hidden first-person hands
keep = {amap[m] for m in models if m in amap}
used_tex = set()
for m in list(ml.values()) + list(g['materials'].values()):
    for t in (m.get('tex') or {}).values(): used_tex.add(amap.get(t['src']))
for model, d in A['texmap'].items():
    if model in keep: used_tex |= set(d.values())
removed = 0; freed = 0
for k, v in amap.items():
    if not os.path.exists(f'{W}/{v}'): continue
    drop = False
    if v.startswith('assets/models/') and v not in keep: drop = True
    elif v.startswith('assets/tex/') and v not in used_tex and '/Sprites/' not in k: drop = True
    if drop:
        freed += os.path.getsize(f'{W}/{v}'); os.remove(f'{W}/{v}'); removed += 1
print('removed', removed, 'files', round(freed / 1e6, 1), 'MB;', 'assets now', round(sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(f'{W}/assets') for f in fs) / 1e6, 1), 'MB')
