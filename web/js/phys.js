/* Static/dynamic collider set in Unity space: OBB raycasts (interaction) and XZ circle-vs-hull collision (player, enemies). */
(function (G) {
'use strict';
const T = THREE;
const MIRROR = new T.Matrix4().makeScale(-1, 1, 1);
const _v = new T.Vector3(), _v2 = new T.Vector3();

// Unity-space world matrix of an object (our scene root mirrors x, undo that)
function uMatrix(obj, out) {
  obj.updateWorldMatrix(true, false);
  return (out || new T.Matrix4()).copy(MIRROR).multiply(obj.matrixWorld);
}
function uPos(obj, out) { return (out || new T.Vector3()).setFromMatrixPosition(uMatrix(obj, _m)); }
const _m = new T.Matrix4();
function uDir(obj, local, out) { // direction in Unity space of a local direction vector
  const m = uMatrix(obj, _m); return (out || new T.Vector3()).copy(local).transformDirection(m);
}

function hull2d(pts) { // monotone chain, points {x,z}; returns CCW polygon
  pts = pts.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lo = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

const CORN = [[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]].map((a) => new T.Vector3(...a));

class Collider {
  constructor(obj, kind, local /* Matrix4 unit cube -> node local */, trig) {
    this.obj = obj; this.kind = kind; this.local = local; this.trig = trig;
    this.tag = obj.userData.tag || 'Untagged';
    this.enabled = true;
    this.mat = new T.Matrix4(); this.inv = new T.Matrix4();
    this.min = new T.Vector3(); this.max = new T.Vector3();
    this.poly = [];
    this.refresh();
  }
  refresh() {
    uMatrix(this.obj, this.mat).multiply(this.local);
    this.inv.copy(this.mat).invert();
    this.min.set(Infinity, Infinity, Infinity); this.max.set(-Infinity, -Infinity, -Infinity);
    const pts = [];
    for (const c of CORN) {
      _v.copy(c).applyMatrix4(this.mat);
      this.min.min(_v); this.max.max(_v);
      pts.push({ x: _v.x, z: _v.z });
    }
    this.poly = hull2d(pts);
  }
  // ray in Unity space; returns t or Infinity
  ray(o, d, maxT) {
    const lo = _v.copy(o).applyMatrix4(this.inv);
    const dl = new T.Vector3(d.x, d.y, d.z).applyMatrix4(this.inv).sub(new T.Vector3(0, 0, 0).applyMatrix4(this.inv));
    let t0 = 0, t1 = maxT;
    for (const a of ['x', 'y', 'z']) {
      if (Math.abs(dl[a]) < 1e-9) { if (lo[a] < -1 || lo[a] > 1) return Infinity; continue; }
      let a0 = (-1 - lo[a]) / dl[a], a1 = (1 - lo[a]) / dl[a];
      if (a0 > a1) { const t = a0; a0 = a1; a1 = t; }
      t0 = Math.max(t0, a0); t1 = Math.min(t1, a1);
      if (t0 > t1) return Infinity;
    }
    return t0;
  }
  containsPoint(p) {
    const l = _v.copy(p).applyMatrix4(this.inv);
    return Math.abs(l.x) <= 1 && Math.abs(l.y) <= 1 && Math.abs(l.z) <= 1;
  }
  // push a circle (x,z,r) out of this collider's XZ hull; returns [dx,dz] or null
  pushOut(x, z, r) {
    const P = this.poly, n = P.length;
    if (n < 3) return null;
    let inside = true, bestD = Infinity, bx = 0, bz = 0;
    let cd = Infinity, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const ex = b.x - a.x, ez = b.z - a.z, len = Math.hypot(ex, ez) || 1e-9;
      const side = (ex * (z - a.z) - ez * (x - a.x)) / len;   // >0: inside (CCW in x,z)
      if (side < 0) inside = false;
      // closest point on segment
      let t = ((x - a.x) * ex + (z - a.z) * ez) / (len * len); t = Math.max(0, Math.min(1, t));
      const px = a.x + ex * t, pz = a.z + ez * t, dd = Math.hypot(x - px, z - pz);
      if (dd < cd) { cd = dd; cx = px; cz = pz; }
      if (side < bestD) { bestD = side; bx = ez / len; bz = -ex / len; } // outward normal
    }
    if (inside) return [bx * (bestD + r), bz * (bestD + r)];
    if (cd >= r) return null;
    const k = (r - cd) / (cd || 1e-9);
    return [(x - cx) * k, (z - cz) * k];
  }
}

class Phys {
  constructor(world) {
    this.world = world;
    this.colliders = [];
    this.byObj = new Map();
    this.dynamic = [];      // colliders under animated nodes
  }

  build(objs) {
    for (const o of objs) {
      const n = o.userData.node; if (!n) continue;
      const c = n.c;
      const add = (kind, center, half, trig) => {
        const L = new T.Matrix4().compose(new T.Vector3(...center), new T.Quaternion(), new T.Vector3(...half));
        const col = new Collider(o, kind, L, trig);
        this.colliders.push(col);
        if (!this.byObj.has(o)) this.byObj.set(o, []);
        this.byObj.get(o).push(col);
      };
      (c.box || []).forEach((b) => add('box', b.c, b.s.map((v) => Math.abs(v) / 2), b.trig));
      (c.capsule || []).forEach((b) => { const h = b.dir === 1 ? [b.r, Math.max(b.h / 2, b.r), b.r] : b.dir === 0 ? [Math.max(b.h / 2, b.r), b.r, b.r] : [b.r, b.r, Math.max(b.h / 2, b.r)]; add('capsule', b.c, h, b.trig); });
      (c.sphere || []).forEach((b) => add('sphere', b.c, [b.r, b.r, b.r], b.trig));
      (c.meshcol || []).forEach((mc) => {
        const wrap = o.userData.mesh;
        let geo = null;
        wrap && wrap.traverse((m) => { if (m.isMesh && !geo) geo = m.geometry; });
        if (!geo) return;
        if (!geo.boundingBox) geo.computeBoundingBox();
        const bb = geo.boundingBox, ctr = bb.getCenter(new T.Vector3()), hs = bb.getSize(new T.Vector3()).multiplyScalar(0.5);
        // mesh vertices live in the wrapper (scale -0.01, .01, .01)
        const L = new T.Matrix4().makeScale(-0.01, 0.01, 0.01).multiply(new T.Matrix4().compose(ctr, new T.Quaternion(), hs));
        const col = new Collider(o, 'mesh', L, mc.trig);
        this.colliders.push(col);
        if (!this.byObj.has(o)) this.byObj.set(o, []);
        this.byObj.get(o).push(col);
      });
    }
  }

  collidersOf(obj) { return this.byObj.get(obj) || []; }

  // nearest ray hit among enabled, visible colliders; includeTrig=false skips triggers
  raycast(origin, dir, maxDist, opts = {}) {
    let best = null, bt = maxDist;
    for (const c of this.colliders) {
      if (!c.enabled || (c.trig && !opts.trig)) continue;
      if (opts.ignore && opts.ignore(c)) continue;
      if (!c.obj.visible && !opts.hidden) continue;
      let vis = true; for (let p = c.obj; p; p = p.parent) if (p.visible === false) { vis = false; break; }
      if (!vis) continue;
      const t = c.ray(origin, dir, bt);
      if (t < bt) { bt = t; best = c; }
    }
    return best ? { collider: best, dist: bt } : null;
  }

  isVisible(c) { for (let p = c.obj; p; p = p.parent) if (p.visible === false) return false; return true; }

  // slide a circle through solid colliders. y0..y1 = vertical band of the mover (Unity y)
  move(x, z, r, y0, y1, dx, dz, ignore) {
    let nx = x + dx, nz = z + dz;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.colliders) {
        if (c.trig || !c.enabled) continue;
        if (c.max.y < y0 || c.min.y > y1) continue;
        if (nx + r < c.min.x || nx - r > c.max.x || nz + r < c.min.z || nz - r > c.max.z) continue;
        if (ignore && ignore(c)) continue;
        if (!this.isVisible(c)) continue;
        const p = c.pushOut(nx, nz, r);
        if (p) { nx += p[0]; nz += p[1]; moved = true; }
      }
      if (!moved) break;
    }
    return [nx, nz];
  }
}

G.Phys = Phys; G.uMatrix = uMatrix; G.uPos = uPos; G.uDir = uDir; G.MIRROR = MIRROR;
})(window);
