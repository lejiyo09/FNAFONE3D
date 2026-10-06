/* Merge static meshes (same material, same ~48 m cell) into baked world-space geometries: thousands of draw calls -> a few dozen. */
(function (G) {
'use strict';
const T = THREE;
const CELL = 48;

function bake(item) {
  const mesh = item.mesh, g = mesh.geometry, grp = item.group;
  const pos = g.attributes.position; if (!pos) return null;
  let idx;
  if (g.index) idx = g.index.array; else { idx = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) idx[i] = i; }
  let a = 0, b = idx.length;
  if (grp) { a = grp.start; b = Math.min(idx.length, grp.start + grp.count); }
  // compact: only the vertices this range uses
  const remap = new Map(), used = [];
  const nIdx = new Uint32Array(b - a);
  for (let i = a; i < b; i++) { const v = idx[i]; let r = remap.get(v); if (r === undefined) { r = used.length; remap.set(v, r); used.push(v); } nIdx[i - a] = r; }
  const P = new Float32Array(used.length * 3), N = new Float32Array(used.length * 3), U = new Float32Array(used.length * 2);
  const gp = g.attributes.position, gn = g.attributes.normal, gu = g.attributes.uv;
  for (let k = 0; k < used.length; k++) {
    const v = used[k];
    P[k * 3] = gp.getX(v); P[k * 3 + 1] = gp.getY(v); P[k * 3 + 2] = gp.getZ(v);
    if (gn) { N[k * 3] = gn.getX(v); N[k * 3 + 1] = gn.getY(v); N[k * 3 + 2] = gn.getZ(v); }
    if (gu) { U[k * 2] = gu.getX(v); U[k * 2 + 1] = gu.getY(v); }
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(P, 3));
  out.setAttribute('normal', new T.BufferAttribute(N, 3));
  out.setAttribute('uv', new T.BufferAttribute(U, 2));
  const m = mesh.matrixWorld;
  out.applyMatrix4(m);
  if (m.determinant() < 0) for (let i = 0; i + 2 < nIdx.length; i += 3) { const t = nIdx[i + 1]; nIdx[i + 1] = nIdx[i + 2]; nIdx[i + 2] = t; }
  out.setIndex(new T.BufferAttribute(nIdx, 1));
  return out;
}

// dynamicOf(obj) -> true if obj (or an ancestor) may change/move/toggle at runtime
function batchStatic(root, isDynamicObj) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  let merged = 0;
  const visit = (o, dyn) => {
    dyn = dyn || isDynamicObj(o);
    if (!o.visible) return;      // hidden subtrees stay as they are (they may be toggled on later)
    if (o.isMesh && !o.isSkinnedMesh && !dyn && o.geometry && o.geometry.attributes.position) {
      const c = new T.Vector3().setFromMatrixPosition(o.matrixWorld);
      const cell = Math.floor(c.x / CELL) + '|' + Math.floor(c.z / CELL) + '|' + Math.floor(c.y / CELL);
      const add = (mat, group) => {
        const key = mat.uuid + '|' + cell;
        let gg = groups.get(key); if (!gg) { gg = { mat, list: [] }; groups.set(key, gg); }
        gg.list.push({ mesh: o, group });
      };
      if (Array.isArray(o.material)) {
        const gs = o.geometry.groups.length ? o.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
        for (const gr of gs) { const mt = o.material[gr.materialIndex]; if (mt) add(mt, gr); }
      } else add(o.material, null);
      return;
    }
    for (const ch of o.children) visit(ch, dyn);
  };
  visit(root, false);
  const made = [];
  for (const g of groups.values()) {
    if (g.list.length < 2) continue;
    const geos = g.list.map(bake).filter(Boolean);
    if (!geos.length) continue;
    const mg = T.BufferGeometryUtils.mergeBufferGeometries(geos, false);
    if (!mg) continue;
    const mesh = new T.Mesh(mg, g.mat); mesh.frustumCulled = true; mesh.matrixAutoUpdate = false; mesh.name = '__batch';
    made.push(mesh);
    for (const it of g.list) { if (!it.mesh.userData.batched) merged++; it.mesh.layers.set(1); it.mesh.userData.batched = true; }   // layer 1 = not rendered, still 'visible' for colliders
    geos.forEach((x) => x.dispose());
  }
  // batches live directly in the scene (world space already includes the x mirror)
  const holder = new T.Group(); holder.name = '__batches'; made.forEach((m) => holder.add(m));
  root.parent.add(holder);
  return { batches: made.length, merged };
}
G.batchStatic = batchStatic;
})(window);
