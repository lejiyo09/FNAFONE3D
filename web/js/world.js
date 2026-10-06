/* Builds a three.js scene from web/data/*.json (converted from the Unity scene by tools/convert_scene.py).
   Unity is left-handed: everything is built in Unity space under `mirror` (scale.x = -1). */
(function (G) {
'use strict';
const T = THREE;

const norm = (s) => String(s || '').toLowerCase().replace(/[.\s]+/g, '').replace(/\(\d+\)$/, '');
const baseName = (p) => String(p).split('/').pop().replace(/\.[^.]+$/, '');
const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

class World {
  constructor(data, assets, anims, matlib) {
    this.data = data; this.assets = assets; this.anims = anims; this.matlib = matlib;
    this.scene = new T.Scene();
    this.mirror = new T.Group(); this.mirror.scale.x = -1; this.scene.add(this.mirror);
    this.models = new Map();      // web path -> parsed FBX group / OBJ group
    this.texCache = new Map();
    this.matCache = new Map();
    this.objs = [];               // node idx -> Object3D
    this.lights = [];             // light descriptors for the dynamic pool
    this.matByName = new Map();
    for (const [p, m] of Object.entries(matlib)) { m._path = p; this.matByName.set(norm(m.name || baseName(p)), m); }
    this.texLoader = new T.TextureLoader();
    this.stats = { meshes: 0, missingMesh: 0, missingTex: 0 };
  }

  // ---------- loading ----------
  async loadModels(paths, progress) {
    let done = 0;
    await Promise.all(paths.map(async (src) => {
      const web = this.assets.map[src];
      if (!web) { console.warn('no web asset for', src); return; }
      try {
        const buf = await (await fetch(web)).arrayBuffer();
        let obj;
        if (web.endsWith('.obj')) {
          obj = new T.OBJLoader().parse(new TextDecoder().decode(buf));
        } else {
          const tm = this.assets.texmap[web] || {};
          const mgr = new T.LoadingManager();
          mgr.setURLModifier((url) => {
            if (url.startsWith('blob:') || url.startsWith('data:')) return url;
            const b = decodeURIComponent(url).replace(/\\/g, '/').split('/').pop().toLowerCase();
            const hit = tm[b];
            if (hit) return hit;
            this.stats.missingTex++; (this.missingNames = this.missingNames || []).push(src.split('/').pop() + ':' + b);
            return TRANSPARENT_GIF;
          });
          const L = new T.FBXLoader(mgr);
          obj = L.parse(buf, '');
        }
        obj.userData.web = web;
        this.models.set(src, obj);
      } catch (e) { console.error('model failed', src, e); }
      progress && progress(++done, paths.length);
    }));
  }

  tex(src, opts = {}) {
    const web = this.assets.map[src];
    if (!web) return null;
    let t = this.texCache.get(web);
    if (!t) {
      t = this.texLoader.load(web);
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.anisotropy = 4;
      this.texCache.set(web, t);
    }
    return t;
  }

  // Unity HDRP/Lit (or Standard) material -> three material
  unityMaterial(path) {
    if (this.matCache.has(path)) return this.matCache.get(path);
    const m = this.matlib[path] || (this.data.materials && this.data.materials[path]);
    if (!m || !m.colors) { this.matCache.set(path, null); return null; }
    const col = m.colors['_BaseColor'] || m.colors['_Color'] || [1, 1, 1, 1];
    const baseTex = m.tex['_BaseColorMap'] || m.tex['_MainTex'] || m.tex['_BaseMap'];
    const emi = m.colors['_EmissiveColor'] || m.colors['_EmissionColor'] || [0, 0, 0, 1];
    const emiTex = m.tex['_EmissiveColorMap'] || m.tex['_EmissionMap'];
    const f = m.floats || {};
    const transparent = (f._SurfaceType === 1) || (f._Surface === 1) || (f._Mode >= 2) || (f._BlendMode !== undefined && f._SurfaceType === 1);
    const alphaCut = f._AlphaCutoffEnable ? (f._AlphaCutoff || 0.5) : 0;
    const mat = new T.MeshLambertMaterial({ color: new T.Color(col[0], col[1], col[2]) });
    if (baseTex) {
      const t = this.tex(baseTex.src);
      if (t) {
        const tt = (baseTex.scale !== 1 || baseTex.sy !== 1 || baseTex.ox || baseTex.oy) ? t.clone() : t;
        if (tt !== t) { tt.needsUpdate = true; tt.repeat.set(baseTex.scale, baseTex.sy); tt.offset.set(baseTex.ox, baseTex.oy); }
        mat.map = tt;
        // textured HDRP materials usually keep colour (1,1,1); a black base colour with a map means "use the map"
        if (col[0] + col[1] + col[2] < 0.01) mat.color.setRGB(1, 1, 1);
      }
    }
    const emax = Math.max(emi[0], emi[1], emi[2]);
    if (emax > 0.001) {
      mat.emissive = new T.Color(emi[0], emi[1], emi[2]);
      if (emax > 1) mat.emissive.multiplyScalar(1 / emax);
      if (emiTex) { const t = this.tex(emiTex.src); if (t) mat.emissiveMap = t; }
    }
    if (transparent) { mat.transparent = true; mat.opacity = col[3]; mat.depthWrite = false; }
    if (alphaCut) { mat.alphaTest = alphaCut; }
    const ds = f._DoubleSidedEnable === 1 || f._Cull === 0 || f._CullMode === 0;
    if (ds || alphaCut || transparent) mat.side = T.DoubleSide;
    mat.name = m.name || baseName(path);
    this.matCache.set(path, mat);
    return mat;
  }

  // Replace an FBX material by the Unity material of the same name (Unity's "search by name" import behaviour).
  fixFbxMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      o.userData.fbxMats = arr.map((m) => m.name + '|' + (m.color ? m.color.getHexString() : '') + '|' + (m.map ? 'map' : ''));
      const out = arr.map((fm) => {
        const um = this.matByName.get(norm(fm.name));
        const made = um ? this.unityMaterial(um._path) : null;
        if (made) return made;
        // fall back to FBX material, simplified to Lambert (shared by look so identical colours can be batched)
        const key = [fm.color ? fm.color.getHexString() : 'cccccc', fm.map ? fm.map.uuid : '', fm.transparent ? 1 : 0, fm.opacity, fm.emissive ? fm.emissive.getHexString() : ''].join('|');
        if (!this.fbxMatCache) this.fbxMatCache = new Map();
        let l = this.fbxMatCache.get(key);
        if (!l) {
          l = new T.MeshLambertMaterial({ color: fm.color ? fm.color.clone() : 0xcccccc, map: fm.map || null, side: T.DoubleSide, transparent: !!fm.transparent, opacity: fm.opacity });
          if (fm.emissive && fm.emissive.getHex()) l.emissive = fm.emissive.clone();
          if (fm.map) { fm.map.wrapS = fm.map.wrapT = T.RepeatWrapping; }
          this.fbxMatCache.set(key, l);
        }
        return l;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
      o.castShadow = false; o.receiveShadow = false;
      o.frustumCulled = true;
    });
  }

  // The restaurant FBX only carries placeholder materials; Unity assigns the project's .mat files per renderer through
  // prefab overrides keyed by hashed fileIDs that we cannot resolve. Classify the parts by shape/name instead.
  restaurantMaterials(root) {
    const byName = (n) => { for (const [p, m] of Object.entries(this.matlib)) if ((m.name || baseName(p)) === n) return this.unityMaterial(p); return null; };
    const floor = byName('ceramicfloor_1'), roof = byName('restaurant_roof'), wall = byName('wall_texture'), poster = byName('posters'),
          tfloor = byName('toilet_floor'), twall = byName('toilet_wall'), col = byName('restaurant_column'), door = byName('office01door'),
          web = byName('cobweb'), star = byName('hangingstar'), kitchen = byName('kitchen_airway'), grey = byName('grey_metalic');
    root.updateMatrixWorld(true);
    const bb = new T.Box3(), sz = new T.Vector3(), ct = new T.Vector3();
    let n = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      bb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      bb.getSize(sz).multiplyScalar(0.01); bb.getCenter(ct).multiplyScalar(0.01);
      const nm = norm(o.name); let m = null;
      const flat = sz.y < 0.9 && Math.max(sz.x, sz.z) > 6, tallWall = sz.y > 5 && (Math.min(sz.x, sz.z) < 1.5) && Math.max(sz.x, sz.z) > 4;
      if (/^poster/.test(nm)) m = poster;
      else if (/^cobweb/.test(nm)) m = web;
      else if (/^hangingstars/.test(nm)) m = star;
      else if (flat && ct.y < 2) m = floor;
      else if (flat && ct.y > 12) m = roof;
      else if (tallWall) m = wall;
      else if (/^(cylinder|cube)\d*$/.test(nm) && sz.y > 8 && Math.max(sz.x, sz.z) < 3) m = col;
      if (m) { o.material = Array.isArray(o.material) ? o.material.map(() => m) : m; n++; }
    });
    return n;
  }

  // ---------- scene graph ----------
  fbxNodeIndex(model) {
    if (model.userData._idx) return model.userData._idx;
    const idx = new Map();
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        const k = norm(o.name);
        if (!idx.has(k)) idx.set(k, o);
      }
    });
    model.userData._idx = idx;
    return idx;
  }

  instantiateModel(src) {
    const model = this.models.get(src);
    if (!model) return null;
    if (!model.userData._fixed) { this.fixFbxMaterials(model); if (src.endsWith('restaurant.fbx')) this.restaurantMaterials(model); model.userData._fixed = true; }
    const hasSkin = (() => { let s = false; model.traverse((o) => { if (o.isSkinnedMesh) s = true; }); return s; })();
    const clone = hasSkin ? T.SkeletonUtils.clone(model) : model.clone(true);
    clone.userData.web = model.userData.web;
    clone.animations = model.animations;
    return clone;
  }

  build(nodes = this.data.nodes, parentObj = this.mirror, offset = 0, objsOut = this.objs) {
    const base = objsOut.length;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const o = new T.Object3D();
      o.name = n.n || '';
      o.position.set(n.t[0], n.t[1], n.t[2]);
      o.quaternion.set(n.q[0], n.q[1], n.q[2], n.q[3]);
      o.scale.set(n.s[0], n.s[1], n.s[2]);
      o.visible = !!n.a;
      o.userData.node = n; o.userData.idx = base + i; o.userData.tag = n.tag; o.userData.scope = objsOut; o.userData.base = base;
      objsOut.push(o);
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const p = n.p >= 0 ? objsOut[base + n.p] : parentObj;
      p.add(objsOut[base + i]);
    }
    // components (second pass: parents exist)
    for (let i = 0; i < nodes.length; i++) this.addComponents(objsOut[base + i], nodes[i], objsOut, base);
    // Skinned characters: use the FBX's own skeleton/skin (the YAML bone hierarchy and bind poses are not needed)
    const kids = new Map();
    nodes.forEach((n, i) => { if (!kids.has(n.p)) kids.set(n.p, []); kids.get(n.p).push(i); });
    const firstSkin = (i) => { const n = nodes[i]; if (n.c.skinned && n.c.mesh) return n.c.mesh.src; for (const k of kids.get(i) || []) { const r = firstSkin(k); if (r) return r; } return null; };
    nodes.forEach((n, i) => {
      const isChar = (n.c.mb || []).some((m) => m.script === 'EnemyAI') || n.n === 'hand' || n.n === 'hand (1)';
      if (!isChar) return;
      const src = firstSkin(i);
      const m = src && this.instantiateModel(src);
      if (!m) return;
      const wrap = new T.Object3D(); wrap.name = '__fbx'; wrap.scale.set(-0.01, 0.01, 0.01); wrap.add(m);
      objsOut[base + i].add(wrap); objsOut[base + i].userData.fbx = m; objsOut[base + i].userData.charSrc = src;
      if (n.n.startsWith('hand')) wrap.scale.multiplyScalar(0.25);   // empirical: the first-person hands come out 4x too large with the plain conversion
      // materials of the YAML SkinnedMeshRenderers (matched to the FBX meshes by name)
      const idx = new Map(); m.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) idx.set(norm(o.name), o); });
      const walk = (k) => {
        const nn = nodes[k];
        if (nn.c.skinned && nn.c.mats) {
          const fm = idx.get(norm(nn.n));
          if (fm) {
            const cur = Array.isArray(fm.material) ? fm.material : [fm.material];
            const out = cur.map((mm, j) => { const p = nn.c.mats[j]; return (p && this.unityMaterial(p)) || mm; });
            fm.material = Array.isArray(fm.material) ? out : out[0];
          }
        }
        (kids.get(k) || []).forEach(walk);
      };
      walk(i);
      // pose: the scene's own bone transforms (YAML hierarchy) define the rest pose Unity renders
      const findLoose = (root, names) => { let cur = root; for (const nm of names) { let nx = null; const want = norm(nm); for (const c of cur.children) if (norm(c.name) === want) { nx = c; break; } if (!nx) { cur.traverse((o) => { if (!nx && o !== cur && norm(o.name) === want) nx = o; }); } if (!nx) return null; cur = nx; } return cur; };
      const poseWalk = (k, names) => {
        for (const c of kids.get(k) || []) {
          const cn = nodes[c];
          if (cn.c.skinned || cn.c.fbx || cn.c.mesh) continue;
          const nn = names.concat(cn.n);
          const b = findLoose(m, nn);
          if (b) {
            // matrix conjugation by the x mirror; translation in cm
            const Lu = new T.Matrix4().compose(new T.Vector3(cn.t[0], cn.t[1], cn.t[2]), new T.Quaternion(cn.q[0], cn.q[1], cn.q[2], cn.q[3]), new T.Vector3(cn.s[0], cn.s[1], cn.s[2]));
            const Mx = new T.Matrix4().makeScale(-1, 1, 1);
            const Lf = Mx.clone().multiply(Lu).multiply(Mx);
            Lf.elements[12] *= 100; Lf.elements[13] *= 100; Lf.elements[14] *= 100;
            Lf.decompose(b.position, b.quaternion, b.scale);
          }
          poseWalk(c, nn);
        }
      };
      poseWalk(i, []);
      m.updateMatrixWorld(true);
    });
    return objsOut.slice(base);
  }

  addComponents(o, n, objsOut, base) {
    const c = n.c;
    if (c.fbx) {
      const m = this.instantiateModel(c.fbx);
      if (m) {
        const wrap = new T.Object3D();
        wrap.name = '__fbx';
        wrap.scale.set(-0.01, 0.01, 0.01);     // cm -> m and FBX(right-handed) -> Unity(left-handed)
        wrap.add(m);
        o.add(wrap);
        // Unity's prefab-instance TRS overrides are absolute Unity values for the instance root. For an FBX with a
        // single top node that node IS the root, so its own (FBX) TRS must be replaced by the override.
        const set = c.fbxset || '';
        if (m.children.length === 1) {
          const top = m.children[0];
          if (set.includes('p')) top.position.set(0, 0, 0); else { top.position.add(new T.Vector3()); o.position.set(0, 0, 0); }
          if (set.includes('r')) top.quaternion.identity(); else o.quaternion.identity();
          if (set.includes('s')) top.scale.set(1, 1, 1); else o.scale.set(1, 1, 1);
          if (set.includes('r')) top.rotation.set(0, 0, 0);
        } else {
          // container root: overrides apply to the container, FBX nodes untouched
        }
        o.userData.fbx = m;
        this.stats.meshes++;
      }
    }
    if (c.mesh && !c.skinned && (c.mesh.src || c.mesh.builtin)) {
      let mesh = null;
      if (c.mesh.builtin) {
        mesh = this.builtinMesh(c.mesh.builtin);
      } else {
        const model = this.models.get(c.mesh.src);
        if (model) {
          if (!model.userData._fixed) { this.fixFbxMaterials(model); if (c.mesh.src.endsWith('restaurant.fbx')) this.restaurantMaterials(model); model.userData._fixed = true; }
          const idx = this.fbxNodeIndex(model);
          const src = idx.get(norm(n.n)) || idx.get(norm(n.n.replace(/\s*\(\d+\)$/, '')));
          if (src) {
            const wrap = new T.Object3D();
            // the scene GO's own scale already carries the FBX node scale; only cm->m and the x mirror are left.
            wrap.scale.set(-0.01, 0.01, 0.01);
            const mm = new T.Mesh(src.geometry, src.material);
            wrap.add(mm); mesh = wrap;
          } else this.stats.missingMesh++;
        }
      }
      if (mesh) {
        // materials from the renderer's list
        const mats = (c.mats || []).map((p) => (p ? this.unityMaterial(p) : null));
        mesh.traverse((m) => {
          if (m.isMesh && mats.length && mats.every(Boolean)) m.material = mats.length === 1 ? mats[0] : mats;
          else if (m.isMesh && mats.length && mats[0] && !Array.isArray(m.material)) m.material = mats[0];
        });
        if (c.render === false) mesh.visible = false;
        o.add(mesh);
        o.userData.mesh = mesh;
      }
    }
    if (c.light && c.light.on !== false) this.lights.push({ obj: o, l: c.light });
  }

  builtinMesh(kind) {
    const mat = new T.MeshLambertMaterial({ color: 0x888888 });
    let g;
    switch (kind) {
      case 'Cube': g = new T.BoxGeometry(1, 1, 1); break;
      case 'Sphere': g = new T.SphereGeometry(0.5, 16, 12); break;
      case 'Cylinder': g = new T.CylinderGeometry(0.5, 0.5, 2, 16); break;
      case 'Capsule': g = new T.CapsuleGeometry ? new T.CapsuleGeometry(0.5, 1, 4, 12) : new T.CylinderGeometry(0.5, 0.5, 2, 12); break;
      case 'Plane': g = new T.PlaneGeometry(10, 10).rotateX(-Math.PI / 2); break;
      default: g = new T.PlaneGeometry(1, 1);
    }
    return new T.Mesh(g, mat);
  }
}

G.World = World;
G.unityNorm = norm;
})(window);
