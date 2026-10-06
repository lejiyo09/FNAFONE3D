#!/usr/bin/env python3
"""Copy/convert the Unity assets the web build needs into web/assets + web/data.

models  : *.fbx / *.obj          -> web/assets/models/<slug>   (loaded at runtime by FBXLoader / OBJLoader)
textures: png/jpg/tif            -> web/assets/tex/<slug>      (<=1024px; JPEG when opaque)
audio   : wav/mp3                -> web/assets/audio/<slug>.ogg
anims   : .anim + .controller    -> web/data/anims.json
All sources keep their original Assets-relative path in web/data/assets.json["map"].
"""
import sys, os, re, json, subprocess, shutil, hashlib
sys.path.insert(0, os.path.dirname(__file__))
from unity_yaml import load_docs, guid_index
from PIL import Image

A = 'Assets'
W = 'web'
GI = guid_index(A)
GI_REV = {v: k for k, v in GI.items()}

def slug(rel):
    base = os.path.basename(rel)
    s = re.sub(r'[^A-Za-z0-9._-]+', '_', base)
    return s.lower()

def uniq(dirpath, name, rel, used):
    key = (dirpath, name)
    if key in used and used[key] != rel:
        stem, ext = os.path.splitext(name)
        name = '%s_%s%s' % (stem, hashlib.md5(rel.encode()).hexdigest()[:6], ext)
    used[(dirpath, name)] = rel
    return name

def walk(exts):
    for dp, _, fs in os.walk(A):
        for f in sorted(fs):
            if f.lower().endswith(exts):
                yield os.path.join(dp, f).replace('\\', '/')

amap, used = {}, {}
for d in ('models', 'tex', 'audio'):
    os.makedirs(os.path.join(W, 'assets', d), exist_ok=True)

# ---- models ----
for p in walk(('.fbx', '.obj')):
    n = uniq('models', slug(p), p, used)
    dst = os.path.join(W, 'assets/models', n)
    if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(p):
        shutil.copyfile(p, dst)
    amap[p] = 'assets/models/' + n

# ---- fonts ----
os.makedirs(os.path.join(W, 'assets/fonts'), exist_ok=True)
for p in walk(('.ttf', '.otf')):
    n = slug(p); shutil.copyfile(p, os.path.join(W, 'assets/fonts', n)); amap[p] = 'assets/fonts/' + n

# ---- textures ----
MAXDIM = 1024
def has_alpha(im):
    if im.mode in ('RGBA', 'LA'):
        return im.getchannel('A').getextrema()[0] < 250
    return im.mode == 'P' and 'transparency' in im.info
for p in walk(('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.tga', '.bmp')):
    try:
        im = Image.open(p); im.load()
    except Exception as e:
        print('skip tex', p, e); continue
    if max(im.size) > MAXDIM:
        k = MAXDIM / max(im.size); im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    alpha = has_alpha(im)
    stem = os.path.splitext(slug(p))[0]
    n = uniq('tex', stem + ('.png' if alpha else '.jpg'), p, used)
    dst = os.path.join(W, 'assets/tex', n)
    if alpha:
        im.convert('RGBA').save(dst, optimize=True)
    else:
        im.convert('RGB').save(dst, quality=86, optimize=True)
    amap[p] = 'assets/tex/' + n

# ---- audio ----
for p in walk(('.wav', '.mp3', '.ogg')):
    n = uniq('audio', os.path.splitext(slug(p))[0] + '.ogg', p, used)
    dst = os.path.join(W, 'assets/audio', n)
    if not os.path.exists(dst):
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', p, '-ac', '2' if os.path.getsize(p) < 3_000_000 else '1', '-c:a', 'libvorbis', '-q:a', '3', dst], check=True)
    amap[p] = 'assets/audio/' + n

# ---- per-FBX texture names -> web texture (search the FBX's own folder tree first) ----
tex_by_base = {}
for p, w in amap.items():
    if w.startswith('assets/tex/'):
        tex_by_base.setdefault(os.path.splitext(os.path.basename(p))[0].lower(), []).append(p)
texmap = {}
pat = re.compile(rb'([\w\-. ()\\/]{2,200}?\.(?:png|jpg|jpeg|tga|tif|tiff|bmp))', re.I)
for p in walk(('.fbx',)):
    data = open(p, 'rb').read()
    names = {m.group(1).decode('latin1').replace('\\', '/').split('/')[-1] for m in pat.finditer(data)}
    local = {}
    for nm in names:
        base = os.path.splitext(nm)[0].lower()
        cands = tex_by_base.get(base, [])
        if not cands:
            continue
        d0 = os.path.dirname(p)
        cands.sort(key=lambda c: (0 if c.startswith(d0) else 1 if os.path.dirname(d0) in c else 2, len(c)))
        local[nm.lower()] = amap[cands[0]]
    if local:
        texmap[amap[p]] = local

# ---- animation clips and controllers ----
def curve_keys(curve, comps):
    out = []
    for k in curve['m_Curve']:
        v = k['value']
        out.append([k['time']] + ([v[c] for c in comps] if isinstance(v, dict) else [v]))
    return out

def conv_clip(path):
    docs = load_docs(path)
    c = next(v for v in docs.values() if v['cls'] == 74)['d']
    st = c.get('m_AnimationClipSettings', {})
    clip = {'name': c['m_Name'], 'loop': bool(st.get('m_LoopTime')), 'start': st.get('m_StartTime', 0), 'stop': st.get('m_StopTime', 0),
            'pos': [], 'rot': [], 'euler': [], 'scl': [], 'float': []}
    for e in c.get('m_PositionCurves', []): clip['pos'].append({'path': e['path'], 'keys': curve_keys(e['curve'], 'xyz')})
    for e in c.get('m_RotationCurves', []): clip['rot'].append({'path': e['path'], 'keys': curve_keys(e['curve'], 'xyzw')})
    for e in c.get('m_EulerCurves', []): clip['euler'].append({'path': e['path'], 'keys': curve_keys(e['curve'], 'xyz')})
    for e in c.get('m_ScaleCurves', []): clip['scl'].append({'path': e['path'], 'keys': curve_keys(e['curve'], 'xyz')})
    for e in c.get('m_FloatCurves', []):
        clip['float'].append({'path': e['path'], 'attr': e['attribute'], 'cls': e.get('classID'), 'keys': curve_keys(e['curve'], '')})
    clip['len'] = max([k[0] for g in ('pos', 'rot', 'euler', 'scl', 'float') for e in clip[g] for k in e['keys']] + [clip['stop'], 0.0001])
    return clip

def motion_ref(m):
    if not m or not m.get('guid'):
        return None
    p = GI.get(m['guid'], '').replace('\\', '/')
    if p.endswith('.anim'):
        return {'clip': p}
    if p.lower().endswith('.fbx'):
        return {'fbx': amap.get(p, p)}
    return None

def conv_controller(path):
    docs = load_docs(path)
    ctrl = next(v for v in docs.values() if v['cls'] == 91)['d']
    out = {'name': ctrl['m_Name'], 'params': [{'name': q['m_Name'], 'type': q['m_Type'], 'def': q.get('m_DefaultFloat', q.get('m_DefaultInt', q.get('m_DefaultBool', 0)))} for q in ctrl.get('m_AnimatorParameters', [])], 'layers': []}
    for layer in ctrl.get('m_AnimatorLayers', []):
        sm = docs[layer['m_StateMachine']['fileID']]['d']
        states = {}
        id2name = {}
        for cs in sm['m_ChildStates']:
            sid = cs['m_State']['fileID']
            id2name[sid] = docs[sid]['d']['m_Name']
        def conv_trans(tid):
            t = docs[tid]['d']
            return {'dst': id2name.get(t['m_DstState']['fileID']), 'exit': bool(t.get('m_HasExitTime')), 'exitTime': t.get('m_ExitTime', 0),
                    'dur': t.get('m_TransitionDuration', 0), 'cond': [{'mode': c['m_ConditionMode'], 'param': c['m_ConditionEvent'], 'thr': c['m_EventTreshold']} for c in t.get('m_Conditions', [])]}
        for sid, nm in id2name.items():
            s = docs[sid]['d']
            states[nm] = {'motion': motion_ref(s.get('m_Motion')), 'speed': s.get('m_Speed', 1), 'trans': [conv_trans(t['fileID']) for t in s.get('m_Transitions', [])],
                          'speedParam': s.get('m_SpeedParameter') if s.get('m_SpeedParameterActive') else None}
        out['layers'].append({'name': layer['m_Name'], 'default': id2name.get(sm['m_DefaultState']['fileID']), 'states': states,
                              'any': [conv_trans(t['fileID']) for t in sm.get('m_AnyStateTransitions', [])]})
    return out

clips, ctrls = {}, {}
for p in walk(('.anim',)):
    try: clips[p] = conv_clip(p)
    except Exception as e: print('clip fail', p, e)
for p in walk(('.controller',)):
    try: ctrls[p] = conv_controller(p)
    except Exception as e: print('ctrl fail', p, e)

# ---- all materials (so FBX materials can be matched by name like Unity's material search) ----
sys.path.insert(0, os.path.dirname(__file__))
import convert_scene as cs
matlib = {}
for p in walk(('.mat',)):
    m = cs.parse_material(p)
    if m: matlib[p] = m

json.dump({'map': amap, 'texmap': texmap}, open(os.path.join(W, 'data/assets.json'), 'w'), indent=0)
json.dump({'clips': clips, 'controllers': ctrls}, open(os.path.join(W, 'data/anims.json'), 'w'), separators=(',', ':'))
json.dump(matlib, open(os.path.join(W, 'data/matlib.json'), 'w'), separators=(',', ':'))
tot = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(os.path.join(W, 'assets')) for f in fs)
print('assets', len(amap), 'texmap', len(texmap), 'clips', len(clips), 'controllers', len(ctrls), 'mats', len(matlib), 'bytes', tot)
