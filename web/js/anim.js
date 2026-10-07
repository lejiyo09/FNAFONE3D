/* Unity Animator/AnimationClip playback on our three.js scene graph (clips + controllers come from tools/export_assets.py). */
(function (G) {
'use strict';
const T = THREE;
const DEG = Math.PI / 180;

function normName(s) { return String(s || '').toLowerCase().replace(/[.\s:]+/g, ''); }

function findChild(obj, name, exact = true) {
  for (const c of obj.children) {
    if (c.name === '__fbx') { const r = findChild(c, name, exact); if (r) return r; continue; }
    if (exact ? c.name === name : normName(c.name) === normName(name)) return c;
  }
  return null;
}
// Resolve a Unity relative transform path ("A/B/C") below `root`. `loose` = compare sanitized names (FBX bones).
function resolvePath(root, path, loose) {
  if (!path) return root;
  let cur = root;
  for (const seg of path.split('/')) {
    let nxt = findChild(cur, seg, !loose);
    if (!nxt && loose) {   // FBX hierarchies may have extra/merged levels: search descendants
      let found = null; const want = normName(seg);
      cur.traverse((o) => { if (!found && o !== cur && normName(o.name) === want) found = o; });
      nxt = found;
    }
    if (!nxt) return null;
    cur = nxt;
  }
  return cur;
}

function sampleKeys(keys, t, n) {
  const k = keys; const out = new Array(n).fill(0);
  if (!k.length) return out;
  if (t <= k[0][0]) { for (let i = 0; i < n; i++) out[i] = k[0][i + 1]; return out; }
  const last = k[k.length - 1];
  if (t >= last[0]) { for (let i = 0; i < n; i++) out[i] = last[i + 1]; return out; }
  let i = 0; while (i < k.length - 2 && t > k[i + 1][0]) i++;
  const a = k[i], b = k[i + 1], f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  for (let j = 0; j < n; j++) out[j] = a[j + 1] + (b[j + 1] - a[j + 1]) * f;
  return out;
}

const _e = new T.Euler(), _q = new T.Quaternion();

class ClipPlayer {
  // mode: 'scene' = apply Unity values directly; 'fbx' = convert into FBX (right-handed, cm) bone space
  constructor(root, clip, mode) {
    this.root = root; this.clip = clip; this.mode = mode;
    this.tracks = [];
    const loose = mode !== 'scene';
    const inFbx = (o) => { for (let p = o; p; p = p.parent) if (p.name === '__fbx') return true; return false; };
    // constant root tracks only restate the pose the clip was authored at (it would teleport a prefab instance): skip them
    const constant = (e) => e.keys.every((k) => k.every((v, i) => i === 0 || Math.abs(v - e.keys[0][i]) < 1e-6));
    const add = (kind, list, n) => list.forEach((e) => {
      if (!e.path && constant(e) && root.userData.node) return;
      const o = resolvePath(root, e.path, loose);
      if (o) this.tracks.push({ kind, o, keys: e.keys, n, fbx: mode === 'fbx' || (mode === 'auto' && inFbx(o)) });
    });
    add('pos', clip.pos, 3); add('rot', clip.rot, 4); add('euler', clip.euler, 3); add('scl', clip.scl, 3);
    this.floats = clip.float.map((e) => ({ e, o: resolvePath(root, e.path, loose) }));
  }
  apply(t) {
    t = Math.min(Math.max(t, 0), this.clip.len);
    for (const tr of this.tracks) {
      const v = sampleKeys(tr.keys, t, tr.n);
      if (tr.kind === 'pos') {
        if (tr.fbx) tr.o.position.set(-v[0] * 100, v[1] * 100, v[2] * 100); else tr.o.position.set(v[0], v[1], v[2]);
      } else if (tr.kind === 'rot') {
        _q.set(v[0], v[1], v[2], v[3]).normalize();
        if (tr.fbx) _q.set(_q.x, -_q.y, -_q.z, _q.w);
        tr.o.quaternion.copy(_q);
      } else if (tr.kind === 'euler') {
        _e.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, 'YXZ'); _q.setFromEuler(_e);
        if (tr.fbx) _q.set(_q.x, -_q.y, -_q.z, _q.w);
        tr.o.quaternion.copy(_q);
      } else if (tr.kind === 'scl') {
        tr.o.scale.set(v[0], v[1], v[2]);
      }
    }
    for (const f of this.floats) {
      if (!f.o) continue;
      const v = sampleKeys(f.e.keys, t, 1)[0];
      const a = f.e.attr;
      if (a === 'm_IsActive') f.o.visible = v > 0.5;
      else if (f.o.userData.onFloat) f.o.userData.onFloat(a, v);
    }
  }
}

// Controller-driven animator for scene nodes (doors, buttons, fans, UI-less props)
class Animator {
  constructor(world, obj, ctrlPath) {
    this.world = world; this.obj = obj;
    this.ctrl = world.anims.controllers[ctrlPath];
    this.layer = this.ctrl ? this.ctrl.layers[0] : null;
    this.state = null; this.t = 0; this.speed = 1; this.players = new Map(); this.done = true; this.params = {};
    this.stateTime = 0;
    if (this.ctrl) this.ctrl.params.forEach((p) => { this.params[p.name] = p.def; });
    this.onDone = null;
  }
  hasState(name) { return !!(this.layer && this.layer.states[name]); }
  clipFor(name) {
    const st = this.layer.states[name]; if (!st || !st.motion || !st.motion.clip) return null;
    const key = name;
    if (!this.players.has(key)) this.players.set(key, new ClipPlayer(this.obj, this.world.anims.clips[st.motion.clip], this.mode || 'scene'));
    return this.players.get(key);
  }
  play(name, normTime = 0) {
    if (!this.hasState(name)) return false;
    this.state = name; const p = this.clipFor(name);
    this.t = p ? normTime * p.clip.len : 0; this.stateTime = 0;
    this.done = false;
    if (p) p.apply(this.t);
    return true;
  }
  update(dt) {
    if (!this.state || this.done) return;
    const st = this.layer.states[this.state], p = this.clipFor(this.state);
    if (!p) { this.done = true; return; }
    this.t += dt * this.speed * (st.speed || 1);
    this.stateTime += dt;
    if (this.t >= p.clip.len) {
      if (p.clip.loop) this.t %= p.clip.len; else { this.t = p.clip.len; this.done = true; }
    }
    p.apply(this.t);
  }
  get normalizedTime() { const p = this.state && this.clipFor(this.state); return p ? this.t / p.clip.len : 0; }
}

G.Anim = { Animator, ClipPlayer, resolvePath, normName, findChild };
})(window);
