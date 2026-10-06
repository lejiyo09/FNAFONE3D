#!/usr/bin/env python3
"""Unity scene (.unity YAML) -> web/data/<scene>.json

Resolves prefab instances (YAML prefabs and FBX model prefabs), GameObject hierarchy, transforms,
renderers, colliders, lights, audio sources and MonoBehaviour fields (object refs become {"@": nodeIndex}).
Usage: convert_scene.py Assets/Scenes/Game.unity web/data/game.json
"""
import sys, os, re, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from unity_yaml import load_docs, guid_index

ROOT = 'Assets'
GI = guid_index(ROOT)
_doc_cache = {}

def docs_of(path):
    if path not in _doc_cache:
        _doc_cache[path] = load_docs(path)
    return _doc_cache[path]

def rel(p):  # repo-relative asset path
    return p.replace('\\', '/')

def v3(d, default=(0, 0, 0)):
    return [d.get('x', default[0]), d.get('y', default[1]), d.get('z', default[2])] if isinstance(d, dict) else list(default)

def q4(d):
    return [d.get('x', 0), d.get('y', 0), d.get('z', 0), d.get('w', 1)] if isinstance(d, dict) else [0, 0, 0, 1]

def col(d):
    return [d.get('r', 1), d.get('g', 1), d.get('b', 1), d.get('a', 1)] if isinstance(d, dict) else [1, 1, 1, 1]

BUILTIN_MESH = {10202: 'Cube', 10206: 'Cylinder', 10207: 'Sphere', 10208: 'Capsule', 10209: 'Plane', 10210: 'Quad'}
ROOT_T, ROOT_GO = -8679921383154817045, 919132149155446097   # fileIDs of an FBX's root Transform / GameObject

SKIP_MB_KEYS = {'m_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_GameObject',
                'm_Enabled', 'm_EditorHideFlags', 'm_EditorClassIdentifier', 'm_Script', 'serializedVersion'}

class Builder:
    def __init__(self, scene_path):
        self.nodes = []
        self.scene = docs_of(scene_path)
        self.owner = {}       # scene fileID (GO/Transform/Component, incl. stripped) -> node idx
        self.pending_refs = []  # (dict, key, fileID) resolved after build
        self.src_map = {}     # (prefabInstanceFileID, sourceFileID) -> node idx (for stripped docs)
        self.materials = {}
        self.audio = set()
        self.models = set()
        self.done_comp = set()

    # ---------- node creation ----------
    def new_node(self, name, parent, t, q, s, active=True, tag='Untagged', layer=0):
        self.nodes.append({'n': name, 'p': parent, 't': t, 'q': q, 's': s, 'a': active, 'tag': tag, 'l': layer, 'c': {}})
        return len(self.nodes) - 1

    def ref(self, target, key, fid_dict):
        """Store an object reference; resolved to {"@": idx} in finalize()."""
        if not isinstance(fid_dict, dict) or not fid_dict.get('fileID'):
            return None
        return {'@?': fid_dict['fileID'], 'ctx': getattr(self, 'cur_ctx', None)}

    # ---------- component conversion ----------
    def convert_value(self, v):
        if isinstance(v, dict):
            if set(v.keys()) <= {'fileID', 'guid', 'type'} and 'fileID' in v:
                if v.get('guid'):
                    p = GI.get(v['guid'])
                    return {'asset': rel(p)} if p else None
                return self.ref(None, None, v) if v['fileID'] else None
            if set(v.keys()) <= {'x', 'y', 'z', 'w'} and 'x' in v:
                return [v.get(k, 0) for k in 'xyzw'[:len(v)]]
            if set(v.keys()) <= {'r', 'g', 'b', 'a'} and 'r' in v:
                return col(v)
            return {k: self.convert_value(x) for k, x in v.items()}
        if isinstance(v, list):
            return [self.convert_value(x) for x in v]
        return v

    def add_components(self, node_idx, go_doc, docs, ov, ctx):
        n = self.nodes[node_idx]
        self.cur_ctx = ctx
        for ce in go_doc['d'].get('m_Component', []):
            cid = ce['component']['fileID']
            c = docs.get(cid)
            if not c:
                continue
            self.owner[cid if ctx is None else (ctx, cid)] = node_idx
            if ctx is None:
                self.owner[cid] = node_idx
            self._comp(node_idx, cid, c, docs, ov, ctx)

    def _comp(self, node_idx, cid, c, docs, ov, ctx):
        n = self.nodes[node_idx]
        self.cur_ctx = ctx
        if ctx is None:
            self.done_comp.add(cid)
        if True:
            d, cls = c['d'], c['cls']
            if c['stripped']:
                return
            ovp = lambda prop, default: ov.get((cid, prop), default)
            if cls == 33:   # MeshFilter
                m = d['m_Mesh']
                if m.get('guid'):
                    src = rel(GI.get(m['guid'], ''))
                    self.models.add(src)
                    n['c']['mesh'] = {'src': src, 'id': m['fileID']}
                elif m.get('fileID') in BUILTIN_MESH:
                    n['c']['mesh'] = {'builtin': BUILTIN_MESH[m['fileID']]}
            elif cls == 23:   # MeshRenderer
                mats = []
                for i, mm in enumerate(d.get('m_Materials', [])):
                    mm = ov.get((cid, 'm_Materials.Array.data[%d]' % i), mm)
                    mats.append(self.material(mm))
                n['c']['mats'] = mats
                n['c']['render'] = bool(ovp('m_Enabled', d.get('m_Enabled', 1)))
                n['c']['cast'] = d.get('m_CastShadows', 1)
            elif cls == 137:  # SkinnedMeshRenderer
                n['c']['skinned'] = True
                n['c']['mats'] = [self.material(mm) for mm in d.get('m_Materials', [])]
                m = d.get('m_Mesh', {})
                if m.get('guid'):
                    src = rel(GI.get(m['guid'], '')); self.models.add(src)
                    n['c']['mesh'] = {'src': src, 'id': m['fileID']}
            elif cls == 65:   # BoxCollider
                n['c'].setdefault('box', []).append({'c': v3(d.get('m_Center')), 's': v3(d.get('m_Size'), (1, 1, 1)), 'trig': bool(d.get('m_IsTrigger'))})
            elif cls == 135:
                n['c'].setdefault('sphere', []).append({'c': v3(d.get('m_Center')), 'r': d.get('m_Radius', .5), 'trig': bool(d.get('m_IsTrigger'))})
            elif cls == 136:
                n['c'].setdefault('capsule', []).append({'c': v3(d.get('m_Center')), 'r': d.get('m_Radius', .5), 'h': d.get('m_Height', 2), 'dir': d.get('m_Direction', 1), 'trig': bool(d.get('m_IsTrigger'))})
            elif cls == 64:   # MeshCollider
                m = d.get('m_Mesh', {})
                mc = {'trig': bool(d.get('m_IsTrigger')), 'convex': bool(d.get('m_Convex'))}
                if m.get('guid'):
                    mc['src'] = rel(GI.get(m['guid'], '')); mc['id'] = m['fileID']; self.models.add(mc['src'])
                n['c'].setdefault('meshcol', []).append(mc)
            elif cls == 54:
                n['c']['rb'] = {'kin': bool(d.get('m_IsKinematic')), 'grav': bool(d.get('m_UseGravity', 1)), 'mass': d.get('m_Mass', 1)}
            elif cls == 108:
                n['c']['light'] = {'type': d.get('m_Type', 2), 'color': col(d.get('m_Color')), 'i': d.get('m_Intensity', 1), 'range': d.get('m_Range', 10),
                                   'spot': d.get('m_SpotAngle', 30), 'shadow': d.get('m_Shadows', {}).get('m_Type', 0), 'on': bool(d.get('m_Enabled', 1))}
            elif cls == 82:   # AudioSource
                clip = d.get('m_audioClip', {})
                p = GI.get(clip.get('guid'), '') if clip else ''
                if p:
                    self.audio.add(rel(p))
                n['c']['audio'] = {'clip': rel(p), 'loop': bool(d.get('Loop')), 'play': bool(d.get('m_PlayOnAwake')), 'vol': d.get('m_Volume', 1),
                                   'spatial': d.get('spatialBlend', 0), 'min': d.get('MinDistance', 1), 'max': d.get('MaxDistance', 500), 'on': bool(d.get('m_Enabled', 1))}
            elif cls == 95:   # Animator
                ctrl = d.get('m_Controller', {})
                n['c']['anim'] = {'controller': rel(GI.get(ctrl.get('guid'), '')) if ctrl else '', 'avatar': bool(d.get('m_Avatar', {}).get('fileID'))}
            elif cls == 20:
                n['c']['camera'] = {'fov': d.get('field of view', 60), 'near': d.get('near clip plane', .3), 'far': d.get('far clip plane', 1000),
                                    'bg': col(d.get('m_BackGroundColor')), 'depth': d.get('m_Depth', 0), 'on': bool(d.get('m_Enabled', 1))}
            elif cls == 114:
                sg = d.get('m_Script', {}).get('guid')
                sp = GI.get(sg, '')
                name = os.path.basename(sp)[:-3] if sp.endswith('.cs') else (os.path.basename(sp) or '?')
                fields = {k: self.convert_value(v) for k, v in d.items() if k not in SKIP_MB_KEYS}
                for (ofid, prop), val in ov.items():
                    if ofid != cid:
                        continue
                    mm = re.match(r'^(\w+)\.Array\.data\[(\d+)\]$', prop)
                    if mm:
                        arr = fields.setdefault(mm.group(1), [])
                        k = int(mm.group(2))
                        while len(arr) <= k: arr.append(None)
                        arr[k] = self.convert_value(val)
                    elif '.' not in prop and '[' not in prop and prop in fields or (prop.isidentifier() and not prop.startswith('m_')):
                        fields[prop] = self.convert_value(val)
                n['c'].setdefault('mb', []).append({'script': name, 'f': fields, 'on': bool(d.get('m_Enabled', 1)), '_id': cid})
            # other classes (Canvas, RectTransform, TextMeshPro...) are ignored: UI is HTML

    def material(self, mref):
        if not isinstance(mref, dict) or not mref.get('guid'):
            return None
        p = GI.get(mref['guid'])
        if not p:
            return None
        p = rel(p)
        if p not in self.materials:
            self.materials[p] = parse_material(p)
        return p

    # ---------- hierarchy ----------
    def build_go_tree(self, docs, go_id, parent, ov, ctx, only_children=True):
        """Instantiate a GameObject (and children) from `docs`. Returns node idx."""
        go = docs[go_id]
        d = go['d']
        tr_id = next((c['component']['fileID'] for c in d['m_Component'] if docs.get(c['component']['fileID'], {}).get('cls') in (4, 224)), None)
        tr = docs[tr_id]['d'] if tr_id else {}
        t = [ov.get((tr_id, 'm_LocalPosition.' + a), tr.get('m_LocalPosition', {}).get(a, 0)) for a in 'xyz']
        q = [ov.get((tr_id, 'm_LocalRotation.' + a), tr.get('m_LocalRotation', {}).get(a, 1 if a == 'w' else 0)) for a in 'xyzw']
        s = [ov.get((tr_id, 'm_LocalScale.' + a), tr.get('m_LocalScale', {}).get(a, 1)) for a in 'xyz']
        name = ov.get((go_id, 'm_Name'), d.get('m_Name'))
        active = bool(ov.get((go_id, 'm_IsActive'), d.get('m_IsActive', 1)))
        tag = ov.get((go_id, 'm_TagString'), d.get('m_TagString', 'Untagged'))
        idx = self.new_node(name, parent, t, q, s, active, tag, d.get('m_Layer', 0))
        self.owner[go_id] = idx; self.owner[tr_id] = idx
        if ctx is not None:
            self.src_map[(ctx, go_id)] = idx; self.src_map[(ctx, tr_id)] = idx
        self.add_components(idx, go, docs, ov, None)
        if ctx is not None:
            for ce in d['m_Component']:
                self.src_map[(ctx, ce['component']['fileID'])] = idx
        if tr_id:
            # children in prefab/scene file order given by m_Children
            for ch in tr.get('m_Children', []):
                cid = ch['fileID']
                cdoc = docs.get(cid)
                if cdoc is None:
                    continue
                if cdoc['stripped'] or cdoc['type'] == 'Transform' and docs[cid]['d'].get('m_PrefabInstance', {}).get('fileID'):
                    continue  # prefab-instance child; instantiated through its PrefabInstance doc
                cgo = cdoc['d'].get('m_GameObject', {}).get('fileID')
                if cgo in docs:
                    self.build_go_tree(docs, cgo, idx, ov, ctx)
        return idx

    def instantiate_prefab_instance(self, docs, pi_id, parent_resolver, ov_outer=None, is_scene=True):
        """PrefabInstance doc -> nodes. `parent_resolver(transformFileID)` -> node idx or -1."""
        pi = docs[pi_id]['d']
        mod = pi['m_Modification']
        ov = dict(ov_outer or {})
        for m in mod.get('m_Modifications', []):
            key = (m['target']['fileID'], m['propertyPath'])
            if key not in ov or ov_outer is None:
                if m['propertyPath'].startswith('m_Materials') or m['propertyPath'] == 'm_Materials.Array.data[0]':
                    ov[key] = m.get('objectReference')
                elif m['propertyPath'] in ('m_Name', 'm_TagString') or not m.get('objectReference', {}).get('fileID'):
                    ov[key] = m.get('value')
                else:
                    ov[key] = m.get('objectReference')
        parent = parent_resolver(mod.get('m_TransformParent', {}).get('fileID', 0))
        src_guid = pi['m_SourcePrefab']['guid']
        src = GI.get(src_guid)
        if not src:
            return -1
        if src.lower().endswith(('.fbx', '.obj')):
            # model prefab: root transform overrides apply to the FBX root node
            t = [ov.get((ROOT_T, 'm_LocalPosition.' + a), 0) for a in 'xyz']
            q = [ov.get((ROOT_T, 'm_LocalRotation.' + a), 1 if a == 'w' else 0) for a in 'xyzw']
            s = [ov.get((ROOT_T, 'm_LocalScale.' + a), 1) for a in 'xyz']
            name = ov.get((ROOT_GO, 'm_Name'), os.path.splitext(os.path.basename(src))[0])
            idx = self.new_node(name, parent, t, q, s, bool(ov.get((ROOT_GO, 'm_IsActive'), 1)), ov.get((ROOT_GO, 'm_TagString'), 'Untagged'))
            self.nodes[idx]['c']['fbx'] = rel(src)
            self.nodes[idx]['c']['fbxset'] = ''.join(f for f, pre in (('p', 'm_LocalPosition'), ('r', 'm_LocalRotation'), ('s', 'm_LocalScale'))
                                                      if any((ROOT_T, pre + '.' + a) in ov for a in 'xyzw'))
            # sub-node material overrides (renderer fileIDs are hashes): keep as list for the runtime
            mats = [(k[0], k[1], v) for k, v in ov.items() if k[1].startswith('m_Materials') and isinstance(v, dict) and v.get('guid')]
            if mats:
                self.nodes[idx]['c']['fbxmats'] = [[a, b, self.material(v)] for a, b, v in mats]
            sub = {}
            for (fid, prop), v in ov.items():
                if fid in (ROOT_T, ROOT_GO) or not prop.startswith(('m_Local', 'm_IsActive')):
                    continue
                sub.setdefault(str(fid), {})[prop] = v
            if sub:
                self.nodes[idx]['c']['fbxov'] = sub
            self.models.add(rel(src))
            self.src_map[(pi_id, ROOT_T)] = idx; self.src_map[(pi_id, ROOT_GO)] = idx
            return idx
        # YAML prefab
        pdocs = docs_of(src)
        root_tr = next((v for v in pdocs.values() if v['cls'] == 4 and v['d'].get('m_Father', {}).get('fileID') == 0 and not v['stripped']), None)
        if root_tr is None:   # prefab variant: the file is a PrefabInstance of another prefab/model
            vp = next((k for k, v in pdocs.items() if v['cls'] == 1001 and v['d']['m_Modification'].get('m_TransformParent', {}).get('fileID', 0) == 0), None)
            if vp is None:
                return -1
            idx = self.instantiate_prefab_instance(pdocs, vp, lambda f, p=parent: p, ov_outer=ov, is_scene=False)
            if idx >= 0:
                for k, v in list(self.src_map.items()):
                    if k[0] == vp:
                        self.src_map[(pi_id, k[1])] = v
            return idx
        root_go = root_tr['d']['m_GameObject']['fileID']
        idx = self.build_go_tree_prefab(pdocs, root_go, parent, ov, pi_id)
        return idx

    def build_go_tree_prefab(self, pdocs, go_id, parent, ov, ctx):
        go = pdocs[go_id]
        d = go['d']
        tr_id = next(c['component']['fileID'] for c in d['m_Component'] if pdocs.get(c['component']['fileID'], {}).get('cls') in (4, 224))
        tr = pdocs[tr_id]['d']
        t = [ov.get((tr_id, 'm_LocalPosition.' + a), tr.get('m_LocalPosition', {}).get(a, 0)) for a in 'xyz']
        q = [ov.get((tr_id, 'm_LocalRotation.' + a), tr.get('m_LocalRotation', {}).get(a, 1 if a == 'w' else 0)) for a in 'xyzw']
        s = [ov.get((tr_id, 'm_LocalScale.' + a), tr.get('m_LocalScale', {}).get(a, 1)) for a in 'xyz']
        name = ov.get((go_id, 'm_Name'), d.get('m_Name'))
        active = bool(ov.get((go_id, 'm_IsActive'), d.get('m_IsActive', 1)))
        idx = self.new_node(name, parent, t, q, s, active, ov.get((go_id, 'm_TagString'), d.get('m_TagString', 'Untagged')), d.get('m_Layer', 0))
        self.src_map[(ctx, go_id)] = idx; self.src_map[(ctx, tr_id)] = idx
        self.add_components(idx, go, pdocs, ov, ctx)
        for ce in d['m_Component']:
            self.src_map[(ctx, ce['component']['fileID'])] = idx
        for ch in tr.get('m_Children', []):
            cdoc = pdocs.get(ch['fileID'])
            if not cdoc or cdoc['stripped']:
                continue
            cgo = cdoc['d'].get('m_GameObject', {}).get('fileID')
            if cgo in pdocs:
                self.build_go_tree_prefab(pdocs, cgo, idx, ov, ctx)
        # nested prefab instances whose parent is this transform
        for pid, pv in pdocs.items():
            if pv['cls'] == 1001 and pv['d']['m_Modification'].get('m_TransformParent', {}).get('fileID') == tr_id:
                self.instantiate_prefab_instance(pdocs, pid, lambda f, idx=idx: idx, ov_outer=ov, is_scene=False)
        return idx

    # ---------- scene ----------
    def build(self):
        docs = self.scene
        # scene roots
        def parent_of_tr(fid):
            if fid == 0:
                return -1
            return self.owner.get(fid, self.owner.get(('t', fid), -1))
        scene_tr = {k: v for k, v in docs.items() if v['cls'] in (4, 224) and not v['stripped']}
        roots = [v for v in scene_tr.values() if v['d'].get('m_Father', {}).get('fileID') == 0]
        roots.sort(key=lambda v: v['d'].get('m_RootOrder', 0) if 'm_RootOrder' in v['d'] else 0)
        for r in roots:
            self.build_go_tree(docs, r['d']['m_GameObject']['fileID'], -1, {}, None)
        # prefab instances: parents may be scene nodes (build first) or stripped transforms of other instances
        pis = [k for k, v in docs.items() if v['cls'] == 1001]
        todo = list(pis)
        guard = 0
        while todo and guard < 20:
            guard += 1
            again = []
            for pid in todo:
                pf = docs[pid]['d']['m_Modification'].get('m_TransformParent', {}).get('fileID', 0)
                parent = -1
                if pf:
                    if pf in self.owner:
                        parent = self.owner[pf]
                    else:
                        st = docs.get(pf)
                        if st and st['stripped']:
                            key = (st['d']['m_PrefabInstance']['fileID'], st['d']['m_CorrespondingSourceObject']['fileID'])
                            if key in self.src_map:
                                parent = self.src_map[key]
                            else:
                                again.append(pid); continue
                        else:
                            again.append(pid); continue
                idx = self.instantiate_prefab_instance(docs, pid, lambda f, p=parent: p)
                self.owner[('pi', pid)] = idx
            todo = again
        # scene GOs that live under a prefab-instance stripped transform
        for tid, tv in scene_tr.items():
            f = tv['d'].get('m_Father', {}).get('fileID', 0)
            if f and f not in self.owner and docs.get(f, {}).get('stripped'):
                pass
        # (the pass above handles roots; children of stripped transforms are not in `roots`.)
        done_go = {n_idx for n_idx in self.owner.values()}
        for tid, tv in scene_tr.items():
            if tid in self.owner:
                continue
            f = tv['d'].get('m_Father', {}).get('fileID', 0)
            st = docs.get(f)
            if st and st['stripped']:
                key = (st['d']['m_PrefabInstance']['fileID'], st['d']['m_CorrespondingSourceObject']['fileID'])
                parent = self.src_map.get(key, -1)
                self.build_go_tree(docs, tv['d']['m_GameObject']['fileID'], parent, {}, None)
        # stripped docs -> owner
        for fid, v in docs.items():
            if v['stripped']:
                key = (v['d'].get('m_PrefabInstance', {}).get('fileID'), v['d'].get('m_CorrespondingSourceObject', {}).get('fileID'))
                if key in self.src_map:
                    self.owner[fid] = self.src_map[key]
        # components added in the scene to GameObjects that live inside prefab instances
        COMP = {33, 23, 65, 64, 135, 136, 54, 108, 82, 95, 20, 114, 137}
        for fid, v in docs.items():
            if v['cls'] in COMP and not v['stripped'] and fid not in self.done_comp:
                gid = v['d'].get('m_GameObject', {}).get('fileID')
                idx = self.owner.get(gid)
                if idx is None:
                    continue
                self.owner[fid] = idx
                self._comp(idx, fid, v, docs, {}, None)
        self.finalize()

    def finalize(self):
        owner = self.owner
        def fix(o):
            if isinstance(o, dict):
                if '@?' in o:
                    r = self.src_map.get((o.get('ctx'), o['@?'])) if o.get('ctx') is not None else None
                    if r is None:
                        r = owner.get(o['@?'])
                    return {'@': r} if r is not None else None
                return {k: fix(v) for k, v in o.items() if k != '_id'}
            if isinstance(o, list):
                return [fix(x) for x in o]
            return o
        for n in self.nodes:
            n['c'] = fix(n['c'])


def parse_material(path):
    docs = docs_of(path)
    m = next((v for v in docs.values() if v['cls'] == 21), None)
    if not m:
        return {}
    d = m['d']
    sp = d.get('m_SavedProperties', {})
    tex = {}
    for e in sp.get('m_TexEnvs', []):
        for k, v in (e.items() if isinstance(e, dict) else []):
            t = v.get('m_Texture', {})
            if t.get('guid') and GI.get(t['guid']):
                tex[k] = {'src': rel(GI[t['guid']]), 'scale': v.get('m_Scale', {}).get('x', 1), 'sy': v.get('m_Scale', {}).get('y', 1),
                          'ox': v.get('m_Offset', {}).get('x', 0), 'oy': v.get('m_Offset', {}).get('y', 0)}
    colors = {}
    for e in sp.get('m_Colors', []):
        for k, v in e.items():
            colors[k] = col(v)
    floats = {}
    for e in sp.get('m_Floats', []):
        floats.update(e)
    shader = GI.get(d.get('m_Shader', {}).get('guid'), '')
    return {'name': d.get('m_Name'), 'tex': tex, 'colors': colors, 'floats': {k: v for k, v in floats.items() if k in (
        '_Metallic', '_Smoothness', '_Glossiness', '_SurfaceType', '_AlphaCutoffEnable', '_AlphaCutoff', '_Cutoff', '_Mode', '_BlendMode', '_DoubleSidedEnable', '_Cull', '_Surface', '_EmissiveIntensity')},
        'shader': os.path.basename(shader) or str(d.get('m_Shader', {}).get('guid', '')), 'keywords': d.get('m_ShaderKeywords', '')}


def render_settings(docs):
    rs = next((v for v in docs.values() if v['cls'] == 104), None)
    if not rs:
        return {}
    d = rs['d']
    return {'fog': bool(d.get('m_Fog')), 'fogColor': col(d.get('m_FogColor')), 'fogDensity': d.get('m_FogDensity'),
            'ambientMode': d.get('m_AmbientMode'), 'ambientSky': col(d.get('m_AmbientSkyColor')), 'ambientEq': col(d.get('m_AmbientEquatorColor')),
            'ambientGround': col(d.get('m_AmbientGroundColor')), 'ambientIntensity': d.get('m_AmbientIntensity')}


def main(src, dst):
    b = Builder(src)
    b.build()
    # prefabs referenced by scripts (e.g. ObjectSpawner.objectToSpawn) are exported separately for runtime Instantiate
    prefabs = {}
    def find_prefabs(o):
        if isinstance(o, dict):
            a = o.get('asset')
            if isinstance(a, str) and a.endswith('.prefab') and a not in prefabs:
                prefabs[a] = None
            for v in o.values(): find_prefabs(v)
        elif isinstance(o, list):
            for v in o: find_prefabs(v)
    for n in b.nodes: find_prefabs(n['c'])
    for pp in list(prefabs):
        b2 = Builder(pp)
        pdocs = docs_of(pp)
        rt = next((v for v in pdocs.values() if v['cls'] == 4 and v['d'].get('m_Father', {}).get('fileID') == 0 and not v['stripped']), None)
        if rt is None:
            vp = next((k for k, v in pdocs.items() if v['cls'] == 1001), None)
            b2.instantiate_prefab_instance(pdocs, vp, lambda f: -1, ov_outer=None, is_scene=False)
        else:
            b2.build_go_tree_prefab(pdocs, rt['d']['m_GameObject']['fileID'], -1, {}, 'x')
        b2.finalize()
        prefabs[pp] = {'nodes': b2.nodes, 'models': sorted(b2.models), 'materials': b2.materials}
        b.models |= b2.models
        b.materials.update(b2.materials)
    out = {'scene': os.path.basename(src), 'nodes': b.nodes, 'prefabs': prefabs, 'materials': b.materials, 'models': sorted(b.models), 'audio': sorted(b.audio),
           'render': render_settings(b.scene)}
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    json.dump(out, open(dst, 'w'), separators=(',', ':'))
    cnt = collections.Counter()
    for n in b.nodes:
        for k in n['c']:
            cnt[k] += 1
    print(os.path.basename(src), '->', dst, len(b.nodes), 'nodes', dict(cnt), 'mats', len(b.materials), 'models', len(b.models))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
