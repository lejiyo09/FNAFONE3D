/* FNAFONE 3D web port: runs the converted Unity scene (data/game.json) with the game's own script rules (Assets/Scripts/*.cs). */
(function () {
'use strict';
const T = THREE;
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const { Animator, ClipPlayer, resolvePath } = Anim;
const Collider = Phys.Collider;

const S = { mode: 'loading', paused: false, clock: 0, hour: 0, win: false, dead: false, lockPlayer: false, camX: 0, yaw: 0,
            tablet: false, camIdx: 0, jump: null, t: 0 };
let world, phys, audio, assets, data, anims;
let renderer, camera, player, rotateOnX, mainCam, flashlightNode;
const keys = {}; const mouse = { l: false, r: false, dx: 0, dy: 0 };
const behs = [];                  // all behaviour instances
const animators = [];             // scene Animators
const bodies = [];                // thrown items
let inventoryB = null, notifB = null, clockB = null, flashB = null, playerB = null, tabletB = null, camSwitch = null, deadB = null, winB = null;
const enemies = [];
let groundY = 0;

// ---------- small helpers ----------
const R = (o, r) => (r && r['@'] !== undefined ? o.userData.scope[r['@']] : null);
const web = (p) => assets.map[p];
const spriteUrl = (p) => (p && web(p)) || '';
const uP = (o) => uPos(o);
const forwardOf = (o) => uDir(o, new T.Vector3(0, 0, 1));
const isUnder = (o, anc) => { for (let p = o; p; p = p.parent) if (p === anc) return true; return false; };
const activeInHierarchy = (o) => { for (let p = o; p; p = p.parent) if (p.visible === false) return false; return true; };
const tagOf = (o) => (o.userData.node ? o.userData.node.tag : 'Untagged');
function setWorldPos(o, v) { const pm = uMatrix(o.parent); o.position.copy(v.clone().applyMatrix4(pm.invert())); }
function behOf(o, name) { return o && o.userData.beh ? o.userData.beh[name] : null; }
function animFor(o) { return o ? o.userData.animator || null : null; }
function sfx(path, opts) { return audio.play(path, opts); }
function fieldRef(b, k) { return R(b.obj, b.f[k]); }
function findAnimatorByState(state) {
  for (const a of animators) if (a.hasState(state)) return a;
  return null;
}

// ---------- loading ----------
async function boot() {
  const lm = $('lmsg'), lb = $('lbar');
  const J = (n) => fetch('data/' + n + '.json').then((r) => r.json());
  [data, assets, anims] = await Promise.all([J('game'), J('assets'), J('anims')]);
  const matlib = await J('matlib');
  world = new World(data, assets, anims, matlib);
  const need = new Set(data.models);
  Object.values(data.prefabs || {}).forEach((p) => (p.models || []).forEach((m) => need.add(m)));
  // character walk clips live in their own FBX files
  for (const c of Object.values(anims.controllers)) for (const l of c.layers) for (const st of Object.values(l.states)) {
    if (st.motion && st.motion.fbx) { const src = Object.keys(assets.map).find((k) => assets.map[k] === st.motion.fbx); if (src) need.add(src); }
  }
  lm.textContent = 'models…';
  await world.loadModels([...need], (d, n) => { lb.style.width = (100 * d / n * 0.8) + '%'; lm.textContent = 'models ' + d + '/' + n; });
  lm.textContent = 'building scene…'; lb.style.width = '85%';
  await new Promise((r) => setTimeout(r, 20));
  world.build();
  phys = new Phys(world);
  audio = new AudioMgr(assets);

  renderer = new T.WebGLRenderer({ canvas: $('c'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  camera = new T.PerspectiveCamera(60, 1, 0.1, 400);
  world.scene.background = new T.Color(0x040405);
  world.scene.fog = new T.FogExp2(0x040405, 0.006);
  addEventListener('resize', onResize); onResize();

  injectStyles();
  setupObjects();
  lm.textContent = 'ready'; lb.style.width = '100%';
  $('loading').style.display = 'none'; $('menu').style.display = 'flex';
  S.mode = 'menu';
  requestAnimationFrame(loop);
  window.__anims = anims; window.__game = { S, world, mouse, keys, uP, forwardOf, behOf, phys, behs, enemies, startGame, tick, PERF, get player() { return player; }, get nav() { return nav; }, get camera() { return camera; }, get info() { return renderer.info; }, get flash() { return flashB; }, get inv() { return inventoryB; }, get clock() { return clockB; } };
  window.__ready = true;
}

function injectStyles() {
  const st = document.createElement('style');
  const u = (n) => 'url(' + spriteUrl('Assets/Sprites/' + n) + ')';
  document.documentElement.style.setProperty('--upper', u('upperhold.png'));
  document.documentElement.style.setProperty('--bpart', u('battery_part.png'));
  st.textContent = `#cross{background-image:${u('player_crosshair.png')}}.slot .fr{background-image:${u('itemhold.png')}}.slot.sel .fr{background-image:${u('itemhold_chosen.png')}}
  #dead{background-image:${u('DeadScreen.jpg')}}#cpanel{background-image:${u('fnaf_game_map.png')}}#cpanel button{background-image:${u('camera_button.png')}}`;
  document.head.appendChild(st);
  $('mpanel').style.backgroundImage = 'url(' + spriteUrl('Assets/Sprites/menu.png') + ')';
  document.documentElement.style.setProperty('--mbtn', 'url(' + spriteUrl('Assets/Sprites/menubutton.png') + ')');
  $('recimg').src = spriteUrl('Assets/Sprites/rec.png');
  $('batEmpty').src = spriteUrl('Assets/Sprites/battery_empty.png');
  const bat = $('bat');
  [28, 44, 60, 76].forEach((top) => { const e = document.createElement('i'); e.style.top = top + 'px'; bat.appendChild(e); });
}
function uiScale() { const w = innerWidth, h = innerHeight; return Math.pow(w / 800, 0.505) * Math.pow(h / 600, 0.495); }
function layoutUI() {
  const s = uiScale(), ui = $('ui');
  ui.style.width = (innerWidth / s) + 'px'; ui.style.height = (innerHeight / s) + 'px'; ui.style.transform = 'scale(' + s + ')';
}

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  layoutUI();
}

// ---------- scene setup ----------
function setupObjects() {
  const objs = world.objs;
  player = objs.find((o) => o.userData.tag === 'Player');
  phys.build(objs);
  { const col = phys.collidersOf(player)[0]; groundY = col ? col.min.y : uP(player).y - 3.8; }   // ground level from the player's capsule

  // animators
  for (const o of objs) {
    const a = o.userData.node.c.anim;
    if (a && a.controller && anims.controllers[a.controller] && (!o.userData.fbx || o.name.startsWith('hand'))) {
      const an = new Animator(world, o, a.controller); if (o.userData.fbx) an.mode = 'auto';
      o.userData.animator = an; animators.push(an);
      if (an.layer && an.layer.default) { const st = an.layer.states[an.layer.default]; if (st && st.motion) an.play(an.layer.default); }
    }
  }

  // Restaurant FBX nodes: animators for nodes whose Unity Animator component could not be resolved (hashed fileIDs),
  // and static colliders fitted to the meshes (Unity added Box/Mesh colliders to many of them).
  const rest = objs.find((o) => o.userData.node.c.fbx && o.userData.node.c.fbx.endsWith('restaurant.fbx'));
  if (rest) {
    const alnum = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const nodeBy = new Map(); rest.userData.fbx.traverse((o) => { if (o.name) nodeBy.set(alnum(o.name), o); });
    const link = { 'Assets/Animations/Cube_149.controller': 'cube149', 'Assets/Animations/Cube_150.controller': 'cube150', 'Assets/Animations/fan_security_room.controller': 'propeller' };
    for (const [ctrl, nm] of Object.entries(link)) {
      const o = nodeBy.get(nm); if (!o) continue;
      const an = new Animator(world, o, ctrl); an.mode = 'auto'; o.userData.animator = an; animators.push(an);
      const d = an.layer.default; if (d && an.layer.states[d] && an.layer.states[d].motion) an.play(d);
    }
    addRestaurantColliders(rest, objs);
  }
  // behaviours
  for (const o of objs) for (const mb of o.userData.node.c.mb || []) createBehaviour(o, mb);
  for (const b of behs) b.start && b.start();


  for (const c of phys.colliders) {
    for (let p = c.obj; p; p = p.parent) if (p.userData.animator || p.userData.node && p.userData.node.c.mb && p.userData.node.c.mb.some((m) => m.script === 'EnemyAI' || m.script === 'PlayerController')) { c.dynamic = true; break; }
    if (c.tag === 'Enemy' || c.tag === 'Player') c.dynamic = true;
  }
  setupHandClip();
  setupLights();
  setupLevelExtras();
  // static batching (draw-call reduction): everything not referenced/animated/tagged by the game's scripts
  const refd = new Set();
  const collect = (o, v) => { if (v && typeof v === 'object') { if (v['@'] !== undefined) { const t = o.userData.scope[v['@']]; if (t) refd.add(t); } else for (const k in v) collect(o, v[k]); } };
  for (const b of behs) for (const k in b.f) collect(b.obj, b.f[k]);
  const res = batchStatic(world.mirror, (o) => {
    if (refd.has(o) || o.userData.animator || o.userData.beh || o.userData.lightDesc) return true;
    const n = o.userData.node; if (!n) return false;
    return n.tag !== 'Untagged' || !!n.c.rb || !!n.c.anim || !!n.c.camera || (n.c.mb && n.c.mb.length > 0) || n.c.audio && n.c.audio.play;
  });
  console.log('batched', JSON.stringify(res));
}

function addRestaurantColliders(rest, objs) {
  const alnum = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const claimed = new Set();    // parts that the scene replaced by their own GameObjects (doors etc.)
  for (const o of objs) { const c = o.userData.node.c; if (c.mesh && c.mesh.src && c.mesh.src.endsWith('restaurant.fbx')) claimed.add(alnum(o.name.replace(/\s*\(\d+\)$/, ''))); }
  const SKIP = /^(poster|cobweb|light|blood|hanging|bezier|grid|shit|mirror|torus|speaker|winframe|door|propeller|motor)/;
  const tmpBox = new T.Box3(), sz = new T.Vector3(), ctr = new T.Vector3();
  let n = 0;
  rest.userData.fbx.traverse((o) => {
    if (!o.isMesh || o.userData.dupOfGO) return;
    const nm = alnum(o.name);
    if (SKIP.test(nm) || claimed.has(nm)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox; bb.getCenter(ctr); bb.getSize(sz).multiplyScalar(0.5);
    const L = new T.Matrix4().compose(ctr.clone(), new T.Quaternion(), sz.clone());
    const col = new Collider(o, 'auto', L, false);
    // keep only things that stand in the walking band
    if (!o.userData.animator) {
      if (col.max.y < groundY + 0.9 || col.min.y > groundY + 7 || (col.max.y - col.min.y) < 0.4) return;
      if (Math.max(col.max.x - col.min.x, col.max.z - col.min.z) < 0.25) return;
    } else col.dynamic = true;
    if (/^(table|tablecover|chair|desk|shelf|case|cupboard|cylinder)/.test(nm)) col.noRay = true;   // furniture that carries items: do not occlude interaction rays
    phys.colliders.push(col); n++;
  });
  console.log('restaurant colliders', n);
}

// The first-person forearms come out far too long with the plain FBX conversion; cut them with a clip plane fixed to the screen.
const handClip = { planes: [new T.Plane(), new T.Plane()], active: false };
function setupHandClip() {
  const h = world.objs.find((o) => o.name === 'hand (1)'); if (!h || !h.userData.fbx) return;
  const seen = new Set();
  h.userData.fbx.traverse((o) => { if (o.isSkinnedMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (!seen.has(m)) { seen.add(m); m.clippingPlanes = handClip.planes; m.clipShadows = false; m.needsUpdate = true; } }); });
  renderer.localClippingEnabled = true; handClip.active = true;
}
const _hc = new T.Vector3(), _hn = new T.Vector3();
function updateHandClip() {
  if (!handClip.active) return;
  camera.updateMatrixWorld(true);
  const up = new T.Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
  const mk = (ndcX, keepLeft, plane) => {
    _hc.set(ndcX, 0, 0.5).unproject(camera).sub(camera.position).normalize();
    _hn.crossVectors(_hc, up).normalize();                       // points to the camera's left or right
    const left = new T.Vector3(-1, 0, 0).transformDirection(camera.matrixWorld);
    if (_hn.dot(left) < 0) _hn.negate();                          // now points left
    if (!keepLeft) _hn.negate();
    plane.setFromNormalAndCoplanarPoint(_hn, camera.position);
  };
  mk(1.2, true, handClip.planes[0]);      // keep what is left of x = +0.62 (screen)
  mk(-1.2, false, handClip.planes[1]);     // keep what is right of x = -0.7
}

// ---------- lights ----------
const pool = { points: [], spots: [], items: [], frame: 0 };
let flashSpot = null;
function setupLights() {
  const scene = world.scene;
  scene.add(new T.AmbientLight(0x5a6580, 1.5));
  scene.add(new T.HemisphereLight(0x8090b0, 0x302418, 0.6));
  for (let i = 0; i < 12; i++) { const l = new T.PointLight(0xffffff, 0, 10, 1.6); l.visible = false; scene.add(l); pool.points.push(l); }
  for (let i = 0; i < 4; i++) { const l = new T.SpotLight(0xffffff, 0, 30, 0.6, 0.4, 1.4); l.visible = false; scene.add(l); scene.add(l.target); pool.spots.push(l); }
  flashSpot = new T.SpotLight(0xfff0cc, 6, 120, 0.42, 0.45, 1.0);
  scene.add(flashSpot); scene.add(flashSpot.target);
  for (const d of world.lights) {
    if (flashlightNode && isUnder(d.obj, player)) continue;
    d.on = d.l.on !== false;
    d.obj.userData.lightDesc = d;
    if (isUnder(d.obj, player)) { d.player = true; continue; }
    if (d.l.type === 1) continue;                           // the HDRP sun (100000 lux) - night scene
    pool.items.push(d);
  }
}
const _lp = new T.Vector3();
function updateLights() {
  pool.frame++;
  if (pool.frame % 5 === 0) {
    const cp = camera.position;
    const scored = [];
    for (const d of pool.items) {
      if (!d.on || !activeInHierarchy(d.obj)) continue;
      _lp.setFromMatrixPosition(d.obj.matrixWorld);
      const dist = _lp.distanceTo(cp);
      const power = d.l.type === 0 ? Math.min(8, d.l.i / 600) : Math.min(3, d.l.i / 140);
      const reach = Math.max(2, d.l.range);
      if (dist > reach + 25) continue;
      scored.push({ d, pos: _lp.clone(), score: power * reach / (dist * dist * 0.02 + 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    let pi = 0, si = 0;
    for (const s of scored) {
      const d = s.d, c = d.l.color;
      if (d.l.type === 0 && si < pool.spots.length) {
        const L = pool.spots[si++]; L.visible = true; L.position.copy(s.pos);
        const dir = new T.Vector3(0, 0, 1).transformDirection(d.obj.matrixWorld);
        L.target.position.copy(s.pos).add(dir.multiplyScalar(5));
        L.color.setRGB(c[0], c[1], c[2]); L.intensity = Math.min(6, d.l.i / 700); L.distance = Math.max(10, d.l.range); L.angle = Math.min(1.3, d.l.spot * DEG / 2);
      } else if (d.l.type !== 0 && pi < pool.points.length) {
        const L = pool.points[pi++]; L.visible = true; L.position.copy(s.pos);
        L.color.setRGB(c[0], c[1], c[2]); L.intensity = Math.min(3, Math.max(0.3, d.l.i / 70)); L.distance = Math.max(3, d.l.range * 1.5);
      }
    }
    for (; pi < pool.points.length; pi++) pool.points[pi].visible = false;
    for (; si < pool.spots.length; si++) pool.spots[si].visible = false;
  }
  // player flashlight: follow the flashlight light node
  const fl = flashlightNode;
  if (fl) {
    const on = flashB && flashB.isLightActive && !S.tablet && !S.dead;
    flashSpot.visible = on;
    if (on) {
      const sp = fl.userData.spotNode || (fl.userData.spotNode = findDesc(fl, 'Spot Light') || fl);
      _lp.setFromMatrixPosition(sp.matrixWorld); flashSpot.position.copy(_lp);
      const dir = new T.Vector3(0, 0, 1).transformDirection(sp.matrixWorld);
      flashSpot.target.position.copy(_lp).add(dir.multiplyScalar(10));
    }
  }
}
function findDesc(o, name) { let r = null; o.traverse((c) => { if (!r && c.name === name) r = c; }); return r; }

// ---------- behaviours ----------
const REG = {};
function createBehaviour(obj, mb) {
  const C = REG[mb.script];
  if (!C) return null;
  const b = new C(obj, mb.f);
  b.obj = obj; b.f = mb.f; b.script = mb.script;
  (obj.userData.beh = obj.userData.beh || {})[mb.script] = b;
  behs.push(b);
  return b;
}
const jobs = [];      // delayed callbacks
function after(sec, fn) { jobs.push({ t: sec, fn }); }

// ---- notification / HUD
class NotificationPresenter {
  constructor() { this.q = []; this.cur = null; notifB = this; }
  add(topic, description) { this.q.push({ topic, description, t: 0, dismiss: 5 }); }
  update(dt) {
    const el = $('notif');
    if (!this.cur && this.q.length) { this.cur = this.q.shift(); el.querySelector('b').textContent = this.cur.topic; el.querySelector('span').textContent = this.cur.description; el.classList.add('show'); }
    if (this.cur) { this.cur.t += dt; if (this.cur.t >= (this.q.length ? 1 : this.cur.dismiss)) { this.cur = null; el.classList.remove('show'); } }
  }
}
REG.NotificationPresenter = NotificationPresenter;
const notify = (topic, description) => notifB && notifB.add(topic, description);

// ---- Clock
class Clock { constructor() { clockB = this; this.clockSeconds = 0; this.hour = 0; }
  update(dt) {
    if (S.dead || S.win) return;
    if (this.clockSeconds < 360) {
      this.clockSeconds += dt * 2; this.hour = Math.floor(this.clockSeconds / 60);
      $('clock').textContent = this.hour === 0 ? '12 AM' : this.hour + ' AM';
    } else if (!S.win) winGame();
    S.hour = this.hour;
  } }
REG.Clock = Clock;

// ---- Flashlight
class Flashlight {
  constructor(o, f) { flashB = this; flashlightNode = o; this.max = f.batteryLifeSeconds || 40; this.life = this.max; this.isLightActive = !!f.isLightActive; this.lightSource = null; }
  start() { this.lightSource = fieldRef(this, 'lightSource'); }
  add(sec) { this.life = Math.min(this.max, this.life + sec); }
  trigger() { this.isLightActive = !this.isLightActive; sfx('Assets/Sound Effects/Button Click.wav', { vol: 0.17 }); }
  update(dt) {
    if (S.dead) return;
    if (this.life > 0 && this.isLightActive) this.life -= dt; else this.isLightActive = false;
    if (this.lightSource) this.lightSource.visible = this.isLightActive;
    const parts = $('bat').querySelectorAll('i'), frac = this.life / this.max;
    for (let i = 0; i < 4; i++) parts[i].style.display = this.life > (i === 3 ? 0 : this.max / (i + 2)) ? 'block' : 'none';
    const bat = $('bat'); bat.className = 'abs ' + (frac > 0.5 ? '' : frac > 0.25 ? 'mid' : this.life > 5 ? 'low' : 'crit');
    $('bsec').textContent = Math.ceil(this.life) + 's';
  }
}
REG.Flashlight = Flashlight;

// ---- Inventory
class Inventory {
  constructor(o, f) { inventoryB = this; this.list = [null, null]; this.cursor = 0; this.full = false; }
  add(item) { for (let i = 0; i < 2; i++) if (!this.list[i]) { this.list[i] = item; return true; } return false; }
  destroyAt(i) { const it = this.list[i]; if (it) it.obj.parent && it.obj.parent.remove(it.obj); this.list[i] = null; }
  update() {
    this.full = !!(this.list[0] && this.list[1]);
    for (let i = 0; i < 2; i++) {
      const el = $('s' + i), it = this.list[i];
      el.classList.toggle('sel', this.cursor === i);
      el.querySelector('b').textContent = it ? it.f.itemName : '';
      const img = el.querySelector('img'); const src = it ? spriteUrl(it.f.itemSprite && it.f.itemSprite.asset) : '';
      if (img.dataset.s !== src) { img.dataset.s = src; if (src) img.src = src; img.style.visibility = src ? 'visible' : 'hidden'; }
    }
  }
  drop() {
    const it = this.list[this.cursor]; if (!it) return;
    it.dropIt(player); this.list[this.cursor] = null;
  }
}
REG.Inventory = Inventory;

// ---- Items
class Item {
  constructor(o, f) { this.obj = o; this.f = f; }
  inv() { return inventoryB; }
  pickIt() { this.obj.visible = false; this.disable(true); inventoryB.add(this); }
  disable(v) { for (const c of phys.collidersOf(this.obj)) c.enabled = !v; }
  drop(player_) {
    this.obj.visible = true; this.disable(false);
    const p = uP(player_).clone().add(forwardOf(player_).multiplyScalar(0.4));
    setWorldPos(this.obj, p);
  }
  throwIt(player_, rotate) {
    const rb = this.obj.userData.node.c.rb; const mass = (rb && rb.mass) || 1;
    if (rotate) this.obj.quaternion.setFromEuler(new T.Euler(270.019775 * DEG, 0, 0, 'YXZ'));
    const f = forwardOf(player_);
    bodies.push({ obj: this.obj, v: f.multiplyScalar(700 / mass * 0.02), rest: false });
  }
  dropIt(player_) { this.drop(player_); }
}
class Tape extends Item { constructor(o, f) { super(o, f); this.record = f.m_record && f.m_record.asset; } }
class DoorKey extends Item {}
class Throwable extends Item { dropIt(p) { this.drop(p); this.throwIt(p, true); } }
REG.Tape = Tape; REG.DoorKey = DoorKey; REG.Drink = class extends Item { dropIt(p) { this.drop(p); this.throwIt(p, false); } };
REG.Pizza = class extends Throwable {}; REG.PlasticPlate = class extends Throwable {}; REG.PlasticFork = class extends Throwable {}; REG.PartyHat = class extends Throwable {};

function updateBodies(dt) {
  for (const b of bodies) {
    if (b.rest) continue;
    b.v.y -= 9.81 * dt;
    const p = uP(b.obj).clone().add(b.v.clone().multiplyScalar(dt));
    if (p.y <= groundY + 0.25) { p.y = groundY + 0.25; b.v.y *= -0.3; b.v.x *= 0.7; b.v.z *= 0.7; if (b.v.length() < 0.4) b.rest = true; }
    setWorldPos(b.obj, p);
  }
}

// ---- spawners
class ObjectSpawner {
  constructor(o, f) { this.obj = o; this.f = f; }
  start() {
    const pf = data.prefabs[this.f.objectToSpawn && this.f.objectToSpawn.asset]; if (!pf) return;
    const base = uP(this.obj);
    for (let i = 0; i < (this.f.spawnCount || 1); i++) {
      const objs = world.build(pf.nodes, this.obj, 0, []);
      const root = objs[0];
      const wp = base.clone().add(this.f.scatterAround ? new T.Vector3(Math.random() * 2, 0, Math.random() * 2) : new T.Vector3());
      setWorldPos(root, wp);
      const rot = this.f.spawnRotation || [0, 0, 0];
      const wq = new T.Quaternion().setFromEuler(new T.Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'YXZ'));
      const pq = new T.Quaternion().setFromRotationMatrix(uMatrix(this.obj.parent || world.mirror));
      root.quaternion.copy(pq.invert().multiply(wq));
      // behaviours + colliders for the new instance
      phys.build(objs);
      for (const o of objs) for (const mb of o.userData.node.c.mb || []) { const b = createBehaviour(o, mb); if (b) { if (this.f.inventory) b.f = Object.assign({}, b.f); b.start && b.start(); } }
    }
  }
}
REG.PlasticPlateSpawner = ObjectSpawner; REG.PlasticForkSpawner = ObjectSpawner;

// ---- Doors
function playAnim(an, name) { if (an && an.hasState(name)) { an.play(name); return true; } return false; }
class Door {
  constructor(o, f) { this.obj = o; this.f = f; this.open = !!f.isDoorOpen; }
  start() {
    this.parent = this.obj.parent; this.an = animFor(this.parent) || findAnimatorByState(this.f.openDoorAnimName);
    this.audioNode = this.parent.userData.node.c.audio;
    this.strong = tagOf(this.obj) === 'strongDoor';
    if (this.open) playAnim(this.an, this.f.openDoorAnimName);
  }
  interact(who) {
    if (this.audioNode && this.audioNode.clip) sfx(this.audioNode.clip, { vol: this.audioNode.vol });
    if (this.strong) { if (who === 'player') this.open = !this.open; }
    else { this.open = !this.open; if (who === 'freddy') this.open = true; }
    playAnim(this.an, this.open ? this.f.openDoorAnimName : this.f.closeDoorAnimName);
  }
}
REG.Door = Door;
class DoubleDoor {
  constructor(o, f) { this.obj = o; this.f = f; this.open = !!f.isDoorOpen; }
  start() {
    this.r = animFor(fieldRef(this, 'animator_r')) || findAnimatorByState(this.f.openDoorAnimName_r);
    this.l = animFor(fieldRef(this, 'animator_l')) || findAnimatorByState(this.f.openDoorAnimName_l);
    this.audioNode = this.obj.userData.node.c.audio; this.strong = tagOf(this.obj) === 'strongDoor';
    if (this.open) { playAnim(this.r, this.f.openDoorAnimName_r); playAnim(this.l, this.f.openDoorAnimName_l); }
  }
  interact(who) {
    if (this.audioNode && this.audioNode.clip) sfx(this.audioNode.clip, { vol: this.audioNode.vol });
    if (this.strong) { if (who === 'player') this.open = !this.open; }
    else { this.open = !this.open; if (who === 'freddy') this.open = true; }
    playAnim(this.r, this.open ? this.f.openDoorAnimName_r : this.f.closeDoorAnimName_r);
    playAnim(this.l, this.open ? this.f.openDoorAnimName_l : this.f.closeDoorAnimName_l);
  }
}
REG.DoubleDoor = DoubleDoor;
const KEY_NAMES = ['Yellow', 'Red'];
class LockedDoor {
  constructor(o, f) { this.obj = o; this.f = f; this.open = !!f.isDoorOpen; this.unlocked = false; }
  start() { this.parent = this.obj.parent; this.an = animFor(this.parent) || findAnimatorByState(this.f.openDoorAnimName); this.audioNode = this.parent.userData.node.c.audio; }
  interact() {
    if (!this.unlocked) {
      const it = inventoryB.list[inventoryB.cursor];
      if (it) { if (it.script === 'DoorKey' && it.f.keyColor === this.f.m_doorLockLevel) { this.unlocked = true; inventoryB.destroyAt(inventoryB.cursor); } }
      else notify('Locked Door', 'You need ' + KEY_NAMES[this.f.m_doorLockLevel] + ' key to unlock this door.');
    }
    if (this.unlocked) {
      if (this.audioNode && this.audioNode.clip) sfx(this.audioNode.clip, { vol: this.audioNode.vol });
      this.open = !this.open; playAnim(this.an, this.open ? this.f.openDoorAnimName : this.f.closeDoorAnimName);
    }
  }
}
REG.LockedDoor = LockedDoor;
class FridgeOrOven {
  constructor(o, f) { this.obj = o; this.f = f; this.open = !!f.isDoorOpen; }
  start() { this.an = animFor(this.obj.parent); if (this.open) playAnim(this.an, this.f.openDoorAnimName); }
  interact() { this.open = !this.open; playAnim(this.an, this.open ? this.f.openDoorAnimName : this.f.closeDoorAnimName); }
}
REG.RefrigeratorDoor = FridgeOrOven; REG.OvenDoor = FridgeOrOven;

// TextMeshPro 3D text -> canvas texture plane (the door countdown screens)
function makeWorldText(o, text) {
  if (!o) return null;
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
  const ctx = cv.getContext('2d'), tex = new T.CanvasTexture(cv);
  const mesh = new T.Mesh(new T.PlaneGeometry(0.9, 0.45), new T.MeshBasicMaterial({ map: tex, transparent: true, side: T.DoubleSide, depthWrite: false }));
  mesh.scale.set(-1, 1, 1);   // our scene is mirrored
  o.add(mesh);
  const api = { last: null, set(t) {
    if (t === api.last) return; api.last = t;
    ctx.clearRect(0, 0, 128, 64); ctx.fillStyle = '#ff2a2a'; ctx.font = 'bold 44px PublicPixel, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, 64, 34); tex.needsUpdate = true; } };
  api.set(text);
  return api;
}
class DoorButton {
  constructor(o, f) { this.obj = o; this.f = f; this.isOn = !!f.isOn; this.max = f.doorClosedTimerSeconds || 20; this.t = this.max; }
  start() { this.txt = makeWorldText(fieldRef(this, 'countdownText'), '60'); this.door = animFor(fieldRef(this, 'doorAnimator')) || findAnimatorByState(this.f.doorOpenAnim); this.sw = animFor(this.obj); this.light = fieldRef(this, 'switchLight'); if (this.isOn) playAnim(this.door, this.f.doorOpenAnim); }
  click() {
    sfx('Assets/Sound Effects/Button Click.wav', { vol: 1 });
    if (this.t < this.max && !this.isOn) return;
    playAnim(this.sw, 'doorButton'); this.isOn = !this.isOn;
    if (this.isOn) { sfx('Assets/Sound Effects/sdoor.wav', { vol: 1 }); playAnim(this.door, this.f.doorOpenAnim); } else playAnim(this.door, this.f.doorCloseAnim);
  }
  update(dt) {
    if (this.t < 0) { this.isOn = false; playAnim(this.door, this.f.doorCloseAnim); }
    if (this.isOn) { setLight(this.light, [0, 1, 0]); this.t -= dt; }
    else { setLight(this.light, [1, 0, 0]); this.t = Math.min(this.max, Math.max(0, this.t + dt)); }
    if (this.txt) this.txt.set(String(Math.round(this.t)));
  }
}
REG.DoorButton = DoorButton;
function setLight(o, rgb) { const d = o && o.userData.lightDesc; if (d) d.l.color = rgb.concat(1); }
class LightButton {
  constructor(o, f) { this.obj = o; this.f = f; this.isOn = false; this.t = 0; }
  start() { this.target = fieldRef(this, 'targetLight'); this.light = fieldRef(this, 'switchLight'); this.sw = animFor(this.obj); const d = this.target && this.target.userData.lightDesc; if (d) d.on = false; }
  click() {
    sfx('Assets/Sound Effects/Button Click.wav', { vol: 0.18 });
    if (!this.isOn) { this.isOn = true; const d = this.target.userData.lightDesc; if (d) d.on = true; playAnim(this.sw, 'doorlight_on_off'); setLight(this.light, [0, 1, 0]); }
  }
  update(dt) {
    if (!this.isOn) return;
    this.t += dt;
    if (this.t >= (this.f.lightOnTimerSeconds || 3)) { this.isOn = false; const d = this.target.userData.lightDesc; if (d) d.on = false; setLight(this.light, [1, 0, 0]); this.t = 0; }
  }
}
REG.LightButton = LightButton;
class FanController {
  constructor(o, f) { this.obj = o; this.f = f; this.on = !!f.isFanOn; }
  start() { this.an = animFor(fieldRef(this, 'fanAnimator')) || findAnimatorByState('fan_security_room_turn'); }
  trigger() { this.on = !this.on; }
  update() { if (this.an) this.an.speed = this.on ? this.f.fMaxSpeed : this.f.fMinSpeed; }
}
REG.FanController = FanController;
class DiscoBallRotate { constructor(o, f) { this.obj = o; this.f = f; } update(dt) { this.obj.rotateY(this.f.rotationSpeed * DEG * dt * 60); } }
REG.DiscoBallRotate = DiscoBallRotate;

class PickableBattery {
  constructor(o, f) { this.obj = o; this.f = f; }
  pick() { flashB.add(this.f.powerSeconds || 5); this.obj.visible = false; for (const c of phys.collidersOf(this.obj)) c.enabled = false; }
}
REG.PickableBattery = PickableBattery;
class GiftBox {
  constructor(o, f) { this.obj = o; this.f = f; }
  open() {
    for (const c of phys.collidersOf(this.obj)) c.enabled = false;
    const rib = fieldRef(this, 'ribbon'); if (rib) bodies.push({ obj: rib, v: new T.Vector3(3, 6, 0), rest: false });
    playAnim(animFor(fieldRef(this, 'giftLCoverAnim')), 'giftbox_l_open'); playAnim(animFor(fieldRef(this, 'giftRCoverAnim')), 'giftbox_r_open');
  }
}
REG.GiftBox = GiftBox;
class RandomGameSession {
  constructor(o, f) { this.obj = o; this.f = f; }
  start() {
    const f = this.f, g = (a) => (a || []).map((r) => R(this.obj, r)).filter(Boolean);
    const boxes = g(f.giftboxes), sps = g(f.giftboxSpawnPoints), idx = sps.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    boxes.forEach((bx, i) => { const sp = sps[idx[i % sps.length]]; if (sp) setWorldPos(bx, uP(sp)); });
    ['4', '5', '6', '7'].forEach((n) => {
      const t = R(this.obj, f['tape' + n]), list = g(f['tapeSP' + n + 's']);
      if (t && list.length) setWorldPos(t, uP(list[Math.floor(Math.random() * list.length)]));
    });
  }
}
REG.RandomGameSession = RandomGameSession;

class TapePlayer {
  constructor(o, f) { this.obj = o; this.f = f; this.voice = null; this.tape = null; }
  start() { this.shown = fieldRef(this, 'tapeInTheTapePlayer'); if (this.shown) this.shown.visible = false; }
  get playing() { return !!(this.voice && this.voice.playing); }
  playOrStop() {
    if (!this.playing) {
      const it = inventoryB.list[inventoryB.cursor];
      if (it && it.script === 'Tape') {
        inventoryB.list[inventoryB.cursor] = null; this.tape = it;
        sfx(it.record, { vol: 1 }).then((h) => { this.voice = h; h.onended = () => this.finish(); });
      }
    } else { this.voice.stop(); this.finish(); }
  }
  finish() { if (this.tape) { this.tape.drop(this.obj); this.tape = null; } this.voice = null; }
  update() { if (this.shown) this.shown.visible = this.playing; }
}
REG.TapePlayer = TapePlayer;

// ---- Security camera tablet
class SecurityCameraTablet {
  constructor(o, f) { this.obj = o; this.f = f; tabletB = this; }
  start() {
    this.cams = (this.f.cameraList || []).map((r) => R(this.obj, r)).filter(Boolean);
    if (!this.cams.length) this.cams = world.objs.filter((o) => o.name === 'cam' && o.userData.node.c.camera);
    const wrap = $('cpanel'), POS = [[-3, -153], [-53, -153], [-91, -153], [-106, 142], [-53, 152], [47, 112], [20, -20], [-80, -16]];
    this.cams.forEach((c, i) => {
      const b = document.createElement('button'); b.textContent = 'CAM ' + (i + 1); b.onclick = () => this.switchTo(i);
      const p = POS[i] || [0, 0]; b.style.left = 'calc(50% + ' + p[0] + 'px)'; b.style.top = 'calc(50% - ' + p[1] + 'px)'; wrap.appendChild(b);
    });
  }
  switchTo(i) {
    S.camIdx = i; sfx('Assets/Sound Effects/camera_change.mp3', { vol: 0.18 });
    [...$('cpanel').children].forEach((b, k) => b.classList.toggle('on', k === i));
    tvNoise();
  }
  interact() {
    S.tablet = true; $('cam').style.display = 'block'; $('hud').style.display = 'none'; document.exitPointerLock && document.exitPointerLock();
    S.camIdx = 0; this.switchTo(0); layoutUI();
  }
  close() { S.tablet = false; $('cam').style.display = 'none'; $('hud').style.display = 'block'; lockPointer(); }
}
REG.SecurityCameraTablet = SecurityCameraTablet;
class CharacterCameraSwitch { constructor(o, f) { this.obj = o; this.f = f; camSwitch = this; } }
REG.CharacterCameraSwitch = CharacterCameraSwitch;
REG.DeadScreen = class { constructor() { deadB = this; } };
REG.WinScreen = class { constructor() { winB = this; } };

// ---- Player
class PlayerController {
  constructor(o, f) { this.obj = o; this.f = f; playerB = this; this.hold = 0; this.walk = f.walkSpeed || 2; }
  start() {
    rotateOnX = fieldRef(this, 'pVisibles') || findDesc(this.obj, 'RotateOnX');
    mainCam = findDesc(this.obj, 'Main Camera');
    S.yaw = new T.Euler().setFromQuaternion(this.obj.quaternion, 'YXZ').y / DEG;
    this.radius = 0.40276 * this.obj.scale.x;
    this.lHand = animFor(fieldRef(this, 'lHandAnim')); this.rHand = animFor(fieldRef(this, 'rHandAnim'));
  }
  update(dt) {
    if (S.lockPlayer || S.dead || S.tablet || S.paused) return;
    // look (PlayerCamera.cs: Mouse X/Y * 0.1 per axis unit)
    const sens = 0.1 * (G_SENS || 1);
    S.yaw += mouse.dx * sens; S.camX = Math.max(-75, Math.min(45, S.camX - mouse.dy * sens));
    mouse.dx = mouse.dy = 0;
    this.obj.quaternion.setFromEuler(new T.Euler(0, S.yaw * DEG, 0, 'YXZ'));
    rotateOnX.quaternion.setFromEuler(new T.Euler(-S.camX * DEG, 0, 0, 'YXZ'));
    // move (PlayerController.cs)
    const h = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), v = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const mult = keys.ShiftLeft || keys.ShiftRight ? 2 : 1;
    if (h || v) {
      const l = Math.hypot(h, v) > 1 ? Math.hypot(h, v) : 1;
      const sy = Math.sin(S.yaw * DEG), cy = Math.cos(S.yaw * DEG);
      const lx = h / l * this.walk * mult, lz = v / l * this.walk * mult;
      const dx = (lx * cy + lz * sy) * dt, dz = (-lx * sy + lz * cy) * dt;
      const p = uP(this.obj);
      const [nx, nz] = phys.move(p.x, p.z, this.radius, groundY + 0.8, groundY + 6.5, dx, dz, (c) => isUnder(c.obj, this.obj) || ITEM_TAGS.has(c.tag) || c.tag === 'Enemy');
      this.obj.position.x = nx; this.obj.position.z = nz;
    }
    // buttons
    if (mouse.rPress) { mouse.rPress = false; playAnim(this.lHand, 'flashlight_on_off'); flashB.trigger(); }
    this.interact(dt);
    if (keys.KeyQPress) { keys.KeyQPress = false; inventoryB.drop(); }
  }
  ray() {
    const o = uP(rotateOnX), d = forwardOf(rotateOnX);
    return phys.raycast(o, d, this.f.interactDistance || 5, { trig: true, ignore: (c) => isUnder(c.obj, this.obj) });
  }
  interact(dt) {
    const hit = this.ray(); const tag = hit ? hit.collider.tag : null; const ho = hit ? hit.collider.obj : null;
    $('tip').textContent = tipFor(tag);
    if (mouse.lPress) {
      mouse.lPress = false;
      if (!hit) return;
      if (tag === 'doorButton') { playAnim(this.rHand, 'hand_click'); behOf(ho, 'DoorButton').click(); }
      else if (tag === 'strongDoor' || tag === 'weakDoor') { playAnim(this.rHand, 'hand_door_open_close'); (behOf(ho, 'Door') || behOf(ho, 'DoubleDoor')).interact('player'); }
      else if (tag === 'pickableBattery') { playAnim(this.rHand, 'hand_pick_item'); behOf(ho, 'PickableBattery').pick(); }
      else if (tag === 'fanController') { playAnim(this.rHand, 'hand_click'); behOf(ho, 'FanController').trigger(); }
      else if (tag === 'lightButton') { playAnim(this.rHand, 'hand_click'); behOf(ho, 'LightButton').click(); }
      else if (tag === 'tapePlayer') { playAnim(this.rHand, 'hand_click'); behOf(ho, 'TapePlayer').playOrStop(); }
      else if (tag === 'lockedDoor') { playAnim(this.rHand, 'hand_door_open_close'); behOf(ho, 'LockedDoor').interact(); }
      else if (tag === 'refrigeratorDoor') { playAnim(this.rHand, 'hand_door_open_close'); behOf(ho, 'RefrigeratorDoor').interact(); }
      else if (tag === 'ovenDoor') { playAnim(this.rHand, 'hand_door_open_close'); behOf(ho, 'OvenDoor').interact(); }
      else if (tag === 'stablet') { playAnim(this.rHand, 'hand_click'); tabletB.interact(); }
    }
    // hold interactions (5 s countdown)
    const holdTags = { giftBox: 'GiftBox', tape: 'Tape', doorKey: 'DoorKey', drink: 'Drink', pizza: 'Pizza', plasticPlate: 'PlasticPlate', plasticFork: 'PlasticFork', partyHat: 'PartyHat' };
    const NOTES = { tape: ['Tape Picked Up', 'You can play tape on a tape player.'], doorKey: ['Door Key Picked Up', null], drink: ['Drink Picked Up', "Doesn't does much. Just a drink you can throw."],
      pizza: ['Pizza Picked Up', 'Mmmmhhmm. Yummy.'], plasticPlate: ['Plastic Plate Picked Up', 'Who eats his meal over the public pizza box?'],
      plasticFork: ['Plastic Fork Picked Up', 'Three spikes with holder called fork.'], partyHat: ['Party Hat Picked Up', 'Party Time!'] };
    if (mouse.l && hit && holdTags[tag] && !inventoryB.full) {
      const total = this.f.holdInteractCountdownSeconds || 5;
      if (this.hold <= total) { this.hold += dt; setProg(this.hold * 100 / total); }
      else {
        this.hold = 0; setProg(-1);
        const b = behOf(ho, holdTags[tag]);
        if (tag === 'giftBox') b.open(); else {
          b.pickIt();
          const n = NOTES[tag]; notify(n[0], tag === 'doorKey' ? 'You can unlock ' + KEY_NAMES[b.f.keyColor] + ' key required doors.' : n[1]);
        }
      }
    } else { this.hold = 0; setProg(-1); }
  }
}
REG.PlayerController = PlayerController;
const ITEM_TAGS = new Set(['pizza', 'partyHat', 'plasticPlate', 'plasticFork', 'drink', 'tape', 'doorKey', 'pickableBattery']);
let G_SENS = 2;
function setProg(v) { const p = $('prog'); if (v < 0) { p.style.display = 'none'; return; } p.style.display = 'block'; p.firstElementChild.style.width = Math.min(100, v) + '%'; }
function tipFor(tag) {
  switch (tag) {
    case 'doorButton': case 'lightButton': case 'fanController': case 'stablet': return 'Click';
    case 'strongDoor': case 'weakDoor': case 'lockedDoor': case 'refrigeratorDoor': case 'ovenDoor': return 'Click: open / close';
    case 'pickableBattery': return 'Click: take battery';
    case 'tapePlayer': return 'Click: play tape';
    case 'giftBox': case 'tape': case 'doorKey': case 'drink': case 'pizza': case 'plasticPlate': case 'plasticFork': case 'partyHat': return 'Hold click';
    default: return '';
  }
}

// ---- Enemies (EnemyAI.cs)
const ANIMNAMES = { 1: 'freddy', 2: 'endoskeleton', 3: 'chica', 4: 'bonnie' };
class EnemyAI {
  constructor(o, f) { this.obj = o; this.f = f; enemies.push(this); this.alive = false; this.jumpDone = false; this.dead = false; this.inView = false; this.walkT = 0; this.path = null; this.pathT = 0; }
  start() {
    this.name = ANIMNAMES[this.f.m_character];
    this.an = new CharAnim(this.obj, anims.controllers[this.obj.userData.node.c.anim.controller], this.name);
    this.lights = (this.f.onAliveLights || []).map((r) => R(this.obj, r)).filter(Boolean);
    this.audio = this.obj.userData.node.c.audio;
    this.speed = this.f.walkSpeed || 1.5; this.dist = this.f.jumpscareDistance || 2;
    this.col = phys.collidersOf(this.obj)[0];
    this.radius = 1.4;
  }
  update(dt) {
    if (S.dead && !this.jumpDone) { this.an.update(dt); return; }
    const pp = uP(player), ep = uP(this.obj);
    let frontOk = false;
    if (this.f.wakeupOnPlayerFront) {
      const hit = phys.raycast(ep.clone().add(new T.Vector3(0, 3, 0)), forwardOf(this.obj), 4, { ignore: (c) => isUnder(c.obj, this.obj) });
      frontOk = !!(hit && hit.collider.tag === 'Player');
    }
    if (clockB && clockB.hour >= (this.f.revivalHour || 0) && !this.alive) {
      if (!(this.f.wakeupOnPlayerFront && !frontOk)) {
        this.alive = true; this.lights.forEach((l) => { l.visible = true; }); this.an.setAlive(true);
      }
    }
    // PlayerViewArea trigger
    this.inView = false;
    if (this.f.isFlashlightSensitive && this.col && viewArea && activeInHierarchy(player)) {
      const c = this.col;
      const pts = [new T.Vector3(0, 0, 0), new T.Vector3(0, 0.8, 0), new T.Vector3(0, -0.8, 0)];
      for (const p of pts) if (viewArea.containsPoint(p.applyMatrix4(c.mat))) { this.inView = true; break; }
    }
    if (this.an.isWalking) {
      if (this.alive && (!this.inView || !flashB.isLightActive)) {
        const wasFrozen = this.frozen; this.frozen = false;
        // steer along a grid path to the player
        this.pathT -= dt;
        if (this.pathT <= 0) { this.path = nav.find(ep.x, ep.z, pp.x, pp.z); this.pathT = 0.35; }
        let tx = pp.x, tz = pp.z;
        if (this.path && this.path.length > 1) {
          // string pulling: aim at the farthest of the next path nodes that is in a straight, unblocked line
          let near = 0, nd = Infinity;
          this.path.forEach((q, i) => { const d = Math.hypot(q.x - ep.x, q.z - ep.z); if (d < nd) { nd = d; near = i; } });
          for (let i = Math.min(this.path.length - 1, near + 10); i > near; i--) { const q = this.path[i]; if (nav.lineClear(ep.x, ep.z, q.x, q.z)) { tx = q.x; tz = q.z; break; } if (i === near + 1) { tx = q.x; tz = q.z; } }
        }
        const dx = tx - ep.x, dz = tz - ep.z, l = Math.hypot(dx, dz) || 1;
        const [nx, nz] = phys.move(ep.x, ep.z, this.radius, groundY + 0.8, groundY + 6.5, dx / l * this.speed * dt, dz / l * this.speed * dt, (c) => isUnder(c.obj, this.obj) || c.tag === 'Player' || ITEM_TAGS.has(c.tag) || (c.tag === 'weakDoor'));
        this.obj.position.x = nx; this.obj.position.z = nz;
        // face the player (Slerp dt*2, yaw only)
        const want = Math.atan2(pp.x - ep.x, pp.z - ep.z), cur = new T.Euler().setFromQuaternion(this.obj.quaternion, 'YXZ').y;
        let dy = want - cur; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
        this.obj.quaternion.setFromEuler(new T.Euler(0, cur + dy * Math.min(1, dt * 2), 0, 'YXZ'));
        // doors within reach: weak doors are opened by enemies
        for (const b of behs) if ((b.script === 'Door' || b.script === 'DoubleDoor') && !b.strong && !b.open && Math.hypot(uP(b.obj).x - ep.x, uP(b.obj).z - ep.z) < 12) b.interact(this.name);
        if (Math.hypot(pp.x - ep.x, pp.z - ep.z) < this.dist) this.jumpscare();
        this.an.speed(1);
      } else { this.frozen = true; this.an.speed(0); }
    }
    this.an.update(dt);
    if (this.jumpDone && !this.dead && this.an.state !== 'jumpscare') {
      this.jumpT = (this.jumpT || 0) + dt;
      if (this.jumpT > 0.5) { this.dead = true; die(this); }
    }
  }
  jumpscare() {
    if (this.jumpDone) return;
    this.an.play('jumpscare'); this.jumpDone = true; S.jump = this; S.dead = true;
    $('hud').style.display = 'none'; $('cam').style.display = 'none'; S.tablet = false;
    player.visible = false; for (const c of phys.collidersOf(player)) c.enabled = false;
    const cam = findDesc(this.obj, 'JumpScareCamera'); if (cam) cam.visible = true; this.camObj = cam;
    if (this.audio && this.audio.clip) sfx(this.audio.clip, { vol: this.audio.vol }); else sfx('Assets/Sound Effects/Jumpscare.wav');
    document.exitPointerLock && document.exitPointerLock();
  }
}
REG.EnemyAI = EnemyAI;

// Character state machine (Animator controller: Idle -> wakeup -> walking; jumpscare)
class CharAnim {
  constructor(obj, ctrl, name) {
    this.obj = obj; this.ctrl = ctrl; this.name = name; this.state = 'idle'; this.t = 0; this.isWalking = false; this.speedV = 1;
    const st = ctrl.layers[0].states; this.states = st;
    const cl = (n) => st[n] && st[n].motion && st[n].motion.clip ? new ClipPlayer(obj, anims.clips[st[n].motion.clip], 'auto') : null;
    this.wake = cl(name + '_wakeup'); this.scare = cl(name + '_jumpscare');
    this.wakeExit = (st[name + '_wakeup'] && st[name + '_wakeup'].trans[0] ? st[name + '_wakeup'].trans[0].exitTime : 0.75);
    // walking clip from the character's walk FBX
    const m = obj.userData.fbx, wfbx = st[name + '_walking'] && st[name + '_walking'].motion && st[name + '_walking'].motion.fbx;
    this.mixer = null;
    if (m && wfbx) {
      const srcKey = Object.keys(assets.map).find((k) => assets.map[k] === wfbx), src = world.models.get(srcKey);
      if (src && src.animations && src.animations.length) {
        this.mixer = new T.AnimationMixer(m); this.walkAction = this.mixer.clipAction(src.animations[0]); this.walkAction.loop = T.LoopRepeat;
      }
    }
  }
  setAlive(v) { if (v && this.state === 'idle') { this.state = 'wakeup'; this.t = 0; } }
  play(n) { this.state = n; this.t = 0; this.isWalking = false; if (this.walkAction) this.walkAction.stop(); }
  speed(v) { this.speedV = v; if (this.mixer) this.mixer.timeScale = v; }
  update(dt) {
    if (this.state === 'wakeup') {
      this.t += dt; const len = this.wake ? this.wake.clip.len : 0.1;
      if (this.wake) this.wake.apply(this.t);
      if (this.t / len >= this.wakeExit) { this.state = 'walking'; this.isWalking = true; if (this.walkAction) this.walkAction.play(); }
    } else if (this.state === 'jumpscare') {
      this.t += dt; const len = this.scare ? this.scare.clip.len : 1;
      if (this.scare) this.scare.apply(this.t);
      if (this.t >= len) this.state = 'idle_done';
    } else if (this.state === 'walking') { if (this.mixer) this.mixer.update(dt); }
  }
}
let viewArea = null, nav = null;

// ---- end states
function die(en) {
  S.dead = true;
  $('deadby').textContent = (en.name || '').toUpperCase();
  $('dead').style.display = 'flex'; flash();
  after(4, () => { backToMenu(); });
}
function winGame() {
  S.win = true; S.lockPlayer = true;
  $('hud').style.display = 'none'; $('cam').style.display = 'none'; S.tablet = false;
  enemies.forEach((e) => { e.obj.parent && e.obj.parent.remove(e.obj); });
  $('win').style.display = 'flex'; document.exitPointerLock && document.exitPointerLock();
  setTimeout(() => $('win').classList.add('roll'), 900);
  sfx('Assets/Sound Effects/win.mp3');
  after(14, backToMenu);
}
function flash() { const f = $('flash'); f.style.transition = 'none'; f.style.opacity = 1; requestAnimationFrame(() => { f.style.transition = 'opacity 1.2s'; f.style.opacity = 0; }); }
function backToMenu() { location.reload(); }

// ---------- level extras: navgrid, view area, tapes ----------
class NavGrid {
  constructor(cell) { this.cell = cell; }
  build() {
    const bb = new T.Box3(); phys.colliders.forEach((c) => { if (!c.trig) { bb.expandByPoint(c.min); bb.expandByPoint(c.max); } });
    this.x0 = Math.floor(bb.min.x - 5); this.z0 = Math.floor(bb.min.z - 5);
    this.w = Math.ceil((bb.max.x - this.x0) / this.cell) + 5; this.h = Math.ceil((bb.max.z - this.z0) / this.cell) + 5;
    this.rebuild();
  }
  rebuild() {
    const g = this.blocked = new Uint8Array(this.w * this.h);
    const inflate = 1.4;
    for (const c of phys.colliders) {
      if (c.trig || !c.enabled) continue;
      if (c.tag === 'Player' || c.tag === 'Enemy' || ITEM_TAGS.has(c.tag) || c.tag === 'weakDoor') continue;
      if (c.max.y < groundY + 0.8 || c.min.y > groundY + 6.5) continue;
      if (!phys.isVisible(c)) continue;
      const x0 = Math.floor((c.min.x - inflate - this.x0) / this.cell), x1 = Math.ceil((c.max.x + inflate - this.x0) / this.cell);
      const z0 = Math.floor((c.min.z - inflate - this.z0) / this.cell), z1 = Math.ceil((c.max.z + inflate - this.z0) / this.cell);
      for (let z = Math.max(0, z0); z <= Math.min(this.h - 1, z1); z++) for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
        const px = this.x0 + (x + 0.5) * this.cell, pz = this.z0 + (z + 0.5) * this.cell;
        const p = c.pushOut(px, pz, inflate); if (p) g[z * this.w + x] = 1;
      }
    }
  }
  lineClear(x0, z0, x1, z1) {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (this.cell * 0.5));
    for (let i = 1; i < n; i++) { const t = i / n, k = this.idx(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t); if (k < 0 || this.blocked[k]) return false; }
    return true;
  }
  idx(x, z) { const cx = Math.floor((x - this.x0) / this.cell), cz = Math.floor((z - this.z0) / this.cell); return (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) ? -1 : cz * this.w + cx; }
  pos(i) { return { x: this.x0 + ((i % this.w) + 0.5) * this.cell, z: this.z0 + (Math.floor(i / this.w) + 0.5) * this.cell }; }
  find(sx, sz, tx, tz) {
    const s = this.idx(sx, sz), t = this.idx(tx, tz); if (s < 0 || t < 0) return null;
    const open = [[0, s]], came = new Map([[s, -1]]), gs = new Map([[s, 0]]);
    const th = (i) => Math.hypot((i % this.w) - (t % this.w), Math.floor(i / this.w) - Math.floor(t / this.w));
    let best = s, bd = th(s), n = 0;
    while (open.length && n++ < 6000) {
      open.sort((a, b) => a[0] - b[0]); const [, cur] = open.shift();
      const d = th(cur); if (d < bd) { bd = d; best = cur; }
      if (cur === t) { best = t; break; }
      const cx = cur % this.w, cz = Math.floor(cur / this.w);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, nz = cz + dz; if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
        const ni = nz * this.w + nx; if (this.blocked[ni] && ni !== t) continue;
        if (dx && dz && (this.blocked[cz * this.w + nx] || this.blocked[nz * this.w + cx])) continue;
        const ng = gs.get(cur) + (dx && dz ? 1.414 : 1);
        if (!gs.has(ni) || ng < gs.get(ni)) { gs.set(ni, ng); came.set(ni, cur); open.push([ng + th(ni), ni]); }
      }
    }
    const path = []; for (let i = best; i !== -1 && i !== undefined; i = came.get(i)) path.push(this.pos(i));
    return path.reverse();
  }
}
function setupLevelExtras() {
  const va = findDesc(player, 'ViewArea'); viewArea = va ? phys.collidersOf(va)[0] : null;
  nav = new NavGrid(2); nav.build();
  S.navReady = true;
}

// ---------- input ----------
function lockPointer() { try { const p = $('c').requestPointerLock(); p && p.catch && p.catch(() => {}); } catch (e) {} }
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys[e.code] = true;
  if (S.mode !== 'play') return;
  if (e.code === 'Escape' || e.code === 'KeyP') { togglePause(); return; }
  if (S.tablet) { const n = '12345678'.indexOf(e.key); if (n >= 0 && tabletB.cams[n]) tabletB.switchTo(n); if (e.code === 'Tab') { e.preventDefault(); tabletB.close(); } return; }
  if (e.code === 'Digit1') inventoryB.cursor = 0; if (e.code === 'Digit2') inventoryB.cursor = 1;
  if (e.code === 'KeyQ') keys.KeyQPress = true;
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('mousemove', (e) => { if (document.pointerLockElement === $('c')) { mouse.dx += e.movementX; mouse.dy += e.movementY; } });
addEventListener('mousedown', (e) => {
  if (S.mode !== 'play' || S.paused || S.tablet) return;
  if (document.pointerLockElement !== $('c')) { lockPointer(); return; }
  if (e.button === 0) { mouse.l = true; mouse.lPress = true; } if (e.button === 2) { mouse.r = true; mouse.rPress = true; }
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
$('camclose').onclick = () => tabletB && tabletB.close();
document.addEventListener('pointerlockchange', () => {
  if (S.mode === 'play' && document.pointerLockElement !== $('c') && !S.paused && !S.tablet && !S.dead && !S.win && !S.jump) togglePause();
});
function togglePause() {
  S.paused = !S.paused; $('pause').style.display = S.paused ? 'flex' : 'none';
  if (S.paused) document.exitPointerLock && document.exitPointerLock(); else lockPointer();
  audio.setPaused(S.paused);
}
$('sens').oninput = (e) => { G_SENS = +e.target.value; try { localStorage.setItem('fnaf3d_sens', G_SENS); } catch (err) {} };
try { const v = parseFloat(localStorage.getItem('fnaf3d_sens')); if (v) { G_SENS = v; $('sens').value = v; } } catch (err) {}
$('resume').onclick = () => togglePause(); $('pexit').onclick = () => backToMenu();
$('pcontact').onclick = () => { $('contact').style.display = 'flex'; };
$('contactBtn').onclick = () => { $('contact').style.display = 'flex'; };
$('contactClose').onclick = () => { $('contact').style.display = 'none'; };
$('play').onclick = () => startGame();
$('exitBtn').onclick = () => { try { window.close(); } catch (e) {} $('exitBtn').textContent = 'Close the tab to exit'; };
const spatialVoices = [];
let menuMusic = null;
addEventListener('pointerdown', () => { if (S.mode === 'menu' && !menuMusic && audio) { audio.unlock(); menuMusic = true; sfx('Assets/Sound Effects/main_menu_music.mp3', { loop: true, vol: 0.5 }).then((h) => { menuMusic = h; }); } }, { once: false });

function startGame() {
  audio.unlock(); if (menuMusic && menuMusic.stop) menuMusic.stop();
  $('menu').style.display = 'none'; $('hud').style.display = 'block';
  S.mode = 'play'; lockPointer();
  // bgnoises (EventSystem AudioSource, loop)
  const es = world.objs.find((o) => o.userData.node.c.audio && o.userData.node.c.audio.play && o.userData.node.c.audio.loop && o.userData.node.c.audio.clip);
  if (es) sfx(es.userData.node.c.audio.clip, { loop: true, vol: es.userData.node.c.audio.vol });
  // positional looping sources (the carousel): volume falls from min to max distance
  for (const o of world.objs) {
    const a = o.userData.node.c.audio;
    if (a && a.play && a.loop && a.on && a.clip && o !== es) sfx(a.clip, { loop: true, vol: 0 }).then((h) => { if (h.gain) spatialVoices.push({ h, o, a }); });
  }
}

// ---------- camera ----------
function camFromNode(node, fov) {
  const m = uMatrix(node), p = new T.Vector3().setFromMatrixPosition(m);
  const f = new T.Vector3(0, 0, 1).transformDirection(m), up = new T.Vector3(0, 1, 0).transformDirection(m);
  camera.position.set(-p.x, p.y, p.z); camera.up.set(-up.x, up.y, up.z);
  camera.lookAt(-(p.x + f.x), p.y + f.y, p.z + f.z);
  if (fov && camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
}
let tvTimer = 0;
function tvNoise() {
  const img = $('tvn'); if (!img.dataset.ok) { img.dataset.ok = 1; }
  const frames = ['tvnoise1.jpg', 'tvnoise2.jpg', 'tvnoise3.jpg'].map((n) => spriteUrl('Assets/Sprites/' + n.replace('.jpg', '.png')) || spriteUrl('Assets/Sprites/' + n));
  img.style.display = 'block'; let k = 0;
  const step = () => { img.src = frames[k % 3]; k++; if (k < 7) tvTimer = setTimeout(step, 50); else img.style.display = 'none'; };
  clearTimeout(tvTimer); step();
}
const nz = $('noise'), nzc = nz.getContext('2d'); nz.width = 160; nz.height = 90;
function drawNoise() { const img = nzc.createImageData(160, 90); for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } nzc.putImageData(img, 0, 0); }

// ---------- main loop ----------
let last = performance.now(), fpsT = 0;
function tick(dt) {
  S.t += dt;
  for (const b of behs) if (b.update) b.update(dt);
  for (const a of animators) a.update(dt);
  updateBodies(dt);
  for (const v of spatialVoices) { const d = uP(v.o).distanceTo(uP(player)); v.h.gain.gain.value = v.a.vol * Math.max(0, Math.min(1, (v.a.max - d) / Math.max(0.01, v.a.max - v.a.min))); }
  for (let i = jobs.length - 1; i >= 0; i--) { jobs[i].t -= dt; if (jobs[i].t <= 0) { const j = jobs.splice(i, 1)[0]; j.fn(); } }
  if (inventoryB) inventoryB.update();
  if (S.tablet) drawNoise();
  world.mirror.updateMatrixWorld(true);
  if (phys) for (const c of phys.colliders) if (c.dynamic) c.refresh();
  if (S.navReady && (S.t * 2 | 0) !== S.navT) { S.navT = S.t * 2 | 0; nav.rebuild(); }
}
const PERF = { upd: 0, ren: 0, n: 0 };
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  const t0 = performance.now();
  if (S.mode === 'play' && !S.paused) tick(dt);
  else world.mirror.updateMatrixWorld(true);
  // active camera
  let node = mainCam;
  if (S.jump && S.jump.camObj) { node = S.jump.camObj; }
  else if (S.tablet && tabletB && tabletB.cams[S.camIdx]) node = tabletB.cams[S.camIdx];
  if (node) { const c = node.userData.node.c.camera; camFromNode(node, c ? c.fov : 60); }
  updateHandClip();
  updateLights();
  const t1 = performance.now();
  renderer.render(world.scene, camera);
  const t2 = performance.now();
  PERF.upd += t1 - t0; PERF.ren += t2 - t1; PERF.n++;
}

boot().catch((e) => { console.error(e); $('lmsg').textContent = 'error: ' + e.message; });
})();
