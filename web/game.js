/* FNAFONE3D Web — browser port of the rules in Assets/Scripts (EnemyAI, Clock, Flashlight, Door, ...).
   Models/levels are code-generated; the original Unity scene/meshes are not used. */
(() => {
'use strict';

// ---------- constants taken from the Unity scripts ----------
const NIGHT_HOURS = 6;            // Clock.nightHours
const CLOCK_RATE = 2;             // Clock: clockSeconds += dt * 2
const WALK = 2, SPRINT_MULT = 2;  // PlayerController.walkSpeed / LeftShift
const BATTERY_MAX = 40;           // Flashlight.batteryLifeSeconds
const BATTERY_PICKUP = 5;         // PickableBattery.powerSeconds
const JUMPSCARE_DIST = 2;         // EnemyAI.jumpscareDistance
const DOOR_REACH = 10;            // EnemyAI.checkDoorAndOpen distance (we use a tighter 3.5 for paths)

// Enemy tuning that lives in the scene file (not recoverable from the LFS pointers): chosen here.
const ENEMIES = [
  { id: 'bonnie',       name: 'Bonnie',       hour: 1, speed: 2.5, color: 0x5b3fa0, eye: 0xff2a2a },
  { id: 'chica',        name: 'Chica',        hour: 2, speed: 2.0, color: 0xe3c21d, eye: 0xff5ad0 },
  { id: 'freddy',       name: 'Freddy',       hour: 3, speed: 1.5, color: 0x6b4423, eye: 0x66ccff, opensAlways: true },
  { id: 'endoskeleton', name: 'Endoskeleton', hour: 4, speed: 3.0, color: 0xb9bcc4, eye: 0xffffff },
];

// ---------- level (3 m cells) ----------
const CELL = 3, WALL_H = 3.2;
const MAP = [
  '####################',
  '#F.....#.....#..C..#',
  '#......#..B..#....b#',
  '#......D.....D.....#',
  '########.....#######',
  '#..................#',
  '#........b.........#',
  '#.................b#',
  '###S######D#####D###',
  '#......#......#....#',
  '#.P....#..b...#..E.#',
  '#......#......#....#',
  '####################',
];
const ROWS = MAP.length, COLS = MAP[0].length;
for (const r of MAP) if (r.length !== COLS) throw new Error('bad map row: ' + r);

const cellC = (c) => (c + 0.5) * CELL;
const toCell = (v) => Math.floor(v / CELL);
const inGrid = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS;

// ---------- three.js setup ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020203);
scene.fog = new THREE.FogExp2(0x020203, 0.03);
const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 120);
camera.rotation.order = 'YXZ';
scene.add(camera);
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  camCam.aspect = camera.aspect; camCam.updateProjectionMatrix();
}
const camCam = new THREE.PerspectiveCamera(70, 1, 0.1, 120);
addEventListener('resize', resize);

scene.add(new THREE.AmbientLight(0x3a3f5c, 1.1));

function tileTexture(a, b, n) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { g.fillStyle = (x + y) % 2 ? b : a; g.fillRect(x * 32, y * 32, 32, 32); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(n, n);
  return t;
}
const floorMat = new THREE.MeshLambertMaterial({ map: tileTexture('#2b2b30', '#1d1d22', COLS * 1.5) });
const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a4650 });
const ceilMat = new THREE.MeshLambertMaterial({ color: 0x15151a });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(COLS * CELL, ROWS * CELL), floorMat);
floor.rotation.x = -Math.PI / 2; floor.position.set(COLS * CELL / 2, 0, ROWS * CELL / 2);
floorMat.map.repeat.set(COLS * 1.5, ROWS * 1.5);
scene.add(floor);
const ceil = new THREE.Mesh(new THREE.PlaneGeometry(COLS * CELL, ROWS * CELL), ceilMat);
ceil.rotation.x = Math.PI / 2; ceil.position.set(COLS * CELL / 2, WALL_H, ROWS * CELL / 2);
scene.add(ceil);

// grid state
const solid = [];            // wall cells
const doors = [];            // {c,r,strong,open,mesh,axis,t}
const doorAt = new Map();
let playerStart = { c: 1, r: 1 };
const enemyStarts = {};
const batterySpots = [];

const wallGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);
for (let r = 0; r < ROWS; r++) {
  solid[r] = [];
  for (let c = 0; c < COLS; c++) {
    const ch = MAP[r][c];
    solid[r][c] = ch === '#';
    if (ch === '#') {
      const m = new THREE.Mesh(wallGeo, wallMat);
      m.position.set(cellC(c), WALL_H / 2, cellC(r)); scene.add(m);
    } else if (ch === 'D' || ch === 'S') {
      const horizontal = MAP[r][c - 1] === '#' && MAP[r][c + 1] === '#';
      const strong = ch === 'S';
      const w = horizontal ? CELL : 0.25, d = horizontal ? 0.25 : CELL;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H - 0.1, d),
        new THREE.MeshLambertMaterial({ color: strong ? 0x7a2020 : 0x6b5a3a }));
      mesh.position.set(cellC(c), (WALL_H - 0.1) / 2, cellC(r)); scene.add(mesh);
      const door = { c, r, strong, open: false, mesh, t: 0, baseY: (WALL_H - 0.1) / 2 };
      doors.push(door); doorAt.set(r * COLS + c, door);
    } else if (ch === 'P') playerStart = { c, r };
    else if ('FBCE'.includes(ch)) enemyStarts[ch] = { c, r };
    else if (ch === 'b') batterySpots.push({ c, r });
  }
}
// enemy start letters -> ids
const START_FOR = { bonnie: 'B', chica: 'C', freddy: 'F', endoskeleton: 'E' };

// room lights (also make the security cameras readable)
const roomLights = [[3.5, 2], [10, 2], [16, 2], [10, 6], [3.5, 10], [10.5, 10], [16.5, 10]];
for (const [c, r] of roomLights) {
  const l = new THREE.PointLight(0x9fb0ff, 0.9, 16, 1.4);
  l.position.set(c * CELL, WALL_H - 0.5, r * CELL); scene.add(l);
}

// props: stage, tables, office desk (visual only)
function box(w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z); scene.add(m); return m;
}
box(8, 0.5, 2.4, 0x3a2418, cellC(10), 0.25, cellC(1) - 0.1);               // show stage
for (const c of [4, 14]) box(2.2, 0.9, 1.2, 0x5a3b22, cellC(c), 0.45, cellC(6));   // hall tables
box(2.4, 0.9, 1.2, 0x333844, cellC(5), 0.45, cellC(10));                   // office desk
box(1.2, 1.6, 1.2, 0x884422, cellC(10), 0.8, cellC(10) + 2.2);             // storage crate
box(2.4, 1.7, 1.2, 0x9aa0a8, cellC(17), 0.85, cellC(11) + 0.3);            // fridge

// ---------- batteries ----------
const batteries = batterySpots.map(({ c, r }) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.5, 12),
    new THREE.MeshLambertMaterial({ color: 0x4cff6a, emissive: 0x2a9a3a }));
  m.position.set(cellC(c), 0.45, cellC(r)); scene.add(m);
  return { mesh: m, taken: false, x: cellC(c), z: cellC(r) };
});

// ---------- animatronics (primitive models) ----------
function makeAnimatronic(def) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: def.color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x15151a });
  const add = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };
  const endo = def.id === 'endoskeleton';
  const torso = add(new THREE.BoxGeometry(endo ? 0.5 : 0.9, endo ? 0.9 : 1.2, endo ? 0.3 : 0.6), mat, 0, 1.45, 0);
  const head = add(new THREE.BoxGeometry(endo ? 0.4 : 0.65, endo ? 0.45 : 0.55, endo ? 0.4 : 0.55), mat, 0, 2.3, 0);
  const eyeM = new THREE.MeshBasicMaterial({ color: def.eye });
  for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.07, 8, 8), eyeM, s * 0.15, 2.36, 0.28);
  const legs = [-1, 1].map((s) => {
    const l = new THREE.Mesh(new THREE.BoxGeometry(endo ? 0.14 : 0.3, 0.9, endo ? 0.14 : 0.3), mat);
    l.geometry.translate(0, -0.45, 0); l.position.set(s * (endo ? 0.15 : 0.25), 0.9, 0); g.add(l); return l;
  });
  const arms = [-1, 1].map((s) => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(endo ? 0.1 : 0.2, 0.9, endo ? 0.1 : 0.2), mat);
    a.geometry.translate(0, -0.4, 0); a.position.set(s * (endo ? 0.35 : 0.58), 1.95, 0.05); g.add(a); return a;
  });
  if (def.id === 'bonnie') for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.14, 0.7, 0.1), mat, s * 0.2, 2.9, 0);
  if (def.id === 'freddy') { for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.16, 10, 10), mat, s * 0.32, 2.66, 0);
    add(new THREE.BoxGeometry(0.5, 0.14, 0.5), dark, 0, 2.7, 0); add(new THREE.BoxGeometry(0.3, 0.1, 0.3), new THREE.MeshLambertMaterial({ color: 0xc89b5a }), 0, 2.2, 0.3); }
  if (def.id === 'chica') { add(new THREE.BoxGeometry(0.35, 0.12, 0.3), new THREE.MeshLambertMaterial({ color: 0xff8a1c }), 0, 2.2, 0.38);
    add(new THREE.BoxGeometry(0.7, 0.5, 0.05), new THREE.MeshLambertMaterial({ color: 0xffffff }), 0, 1.6, 0.33); }
  if (endo) add(new THREE.CylinderGeometry(0.12, 0.12, 0.4, 8), dark, 0, 1.0, 0);
  g.userData = { legs, arms, head, torso, eyeM };
  scene.add(g); g.visible = false;
  return g;
}

// ---------- audio (synthesised) ----------
let actx = null, hum = null;
function audio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function noiseBuf(a, secs) {
  const b = a.createBuffer(1, Math.floor(a.sampleRate * secs), a.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function sfx(kind) {
  const a = audio(); if (!a) return;
  const t = a.currentTime, g = a.createGain(); g.connect(a.destination);
  if (kind === 'scare') {
    const n = a.createBufferSource(); n.buffer = noiseBuf(a, 1.1);
    const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.6;
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.01, t + 1.1);
    n.connect(f); f.connect(g); n.start(t);
    for (const fr of [220, 233, 440]) { const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(fr, t); o.frequency.linearRampToValueAtTime(fr * 1.6, t + 0.9); o.connect(g); o.start(t); o.stop(t + 1.1); }
  } else if (kind === 'door') {
    const o = a.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.3); o.connect(g); o.start(t); o.stop(t + 0.32);
  } else if (kind === 'click') {
    const o = a.createOscillator(); o.type = 'square'; o.frequency.value = 1400;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); o.connect(g); o.start(t); o.stop(t + 0.06);
  } else if (kind === 'pick') {
    const o = a.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(600, t); o.frequency.linearRampToValueAtTime(1100, t + 0.15);
    g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2); o.connect(g); o.start(t); o.stop(t + 0.22);
  } else if (kind === 'win') {
    [523, 659, 784, 1047].forEach((fr, i) => { const o = a.createOscillator(), gg = a.createGain(); o.type = 'triangle'; o.frequency.value = fr;
      gg.gain.setValueAtTime(0.0001, t + i * 0.25); gg.gain.exponentialRampToValueAtTime(0.3, t + i * 0.25 + 0.03); gg.gain.exponentialRampToValueAtTime(0.001, t + i * 0.25 + 0.9);
      o.connect(gg); gg.connect(a.destination); o.start(t + i * 0.25); o.stop(t + i * 0.25 + 1); });
  } else if (kind === 'wake') {
    const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(60, t); o.frequency.linearRampToValueAtTime(35, t + 1.2);
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.3); o.connect(g); o.start(t); o.stop(t + 1.3);
  }
}
function startHum() {
  const a = audio(); if (!a || hum) return;
  const o = a.createOscillator(), g = a.createGain(); o.type = 'sine'; o.frequency.value = 50; g.gain.value = 0.05;
  o.connect(g); g.connect(a.destination); o.start(); hum = { o, g };
}
function stopHum() { if (hum) { hum.o.stop(); hum = null; } }

// ---------- game state ----------
const $ = (id) => document.getElementById(id);
const hud = $('hud'), camLayer = $('cam');
const S = {
  mode: 'menu',           // menu | play | jump | dead | win
  clock: 0, hour: 0,
  px: 0, pz: 0, yaw: 0, pitch: 0,
  battery: BATTERY_MAX, lightOn: true,
  tablet: false, camIdx: 0,
  jumpT: 0, killer: null,
};
const keys = {};
let enemies = [];

const camSpots = [
  { name: 'CAM 1 — 복도', x: cellC(1) , z: cellC(5), tx: cellC(17), tz: cellC(6) },
  { name: 'CAM 2 — 무대', x: cellC(8), z: cellC(3), tx: cellC(11), tz: cellC(1) },
  { name: 'CAM 3 — 주방', x: cellC(15), z: cellC(9), tx: cellC(18), tz: cellC(11) },
  { name: 'CAM 4 — 창고', x: cellC(8), z: cellC(11), tx: cellC(13), tz: cellC(10) },
];

function reset() {
  S.clock = 0; S.hour = 0; S.battery = BATTERY_MAX; S.lightOn = true;
  S.px = cellC(playerStart.c); S.pz = cellC(playerStart.r); S.yaw = 0; S.pitch = 0;
  S.tablet = false; S.jumpT = 0; S.killer = null;
  doors.forEach((d) => { d.open = false; d.t = 0; d.mesh.position.y = d.baseY; });
  batteries.forEach((b) => { b.taken = false; b.mesh.visible = true; });
  enemies.forEach((e) => scene.remove(e.model));
  enemies = ENEMIES.map((def) => {
    const st = enemyStarts[START_FOR[def.id]];
    const model = makeAnimatronic(def);
    model.position.set(cellC(st.c), 0, cellC(st.r)); model.visible = true;
    return { def, model, x: cellC(st.c), z: cellC(st.r), alive: false, wakeT: 0, frozen: false, path: null, pathT: 0, anim: 0, yaw: Math.PI };
  });
  flashlight.visible = true;
  camLayer.style.display = 'none';
  $('clock').textContent = '12 AM';
}

// player flashlight (SpotLight parented to camera)
const flashlight = new THREE.SpotLight(0xfff2cc, 5, 30, 0.45, 0.5, 1);
flashlight.position.set(0, 0, 0);
camera.add(flashlight);
const flTarget = new THREE.Object3D(); flTarget.position.set(0, 0, -1); camera.add(flTarget); flashlight.target = flTarget;

// ---------- collision / LOS ----------
function doorBlocks(c, r) { const d = doorAt.get(r * COLS + c); return d && d.t < 0.85; }
function blockedForPlayer(x, z) {
  const c = toCell(x), r = toCell(z);
  if (!inGrid(c, r) || solid[r][c]) return true;
  return !!doorBlocks(c, r);
}
function playerFits(x, z) {
  const k = 0.42;
  return !(blockedForPlayer(x - k, z - k) || blockedForPlayer(x + k, z - k) || blockedForPlayer(x - k, z + k) || blockedForPlayer(x + k, z + k));
}
function lineClear(x0, z0, x1, z1) {
  const dist = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(dist / 0.5);
  for (let i = 1; i < n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    const c = toCell(x), r = toCell(z);
    if (!inGrid(c, r) || solid[r][c] || doorBlocks(c, r)) return false;
  }
  return true;
}

// BFS pathing on the cell grid; weak doors are passable for enemies (they open them), strong closed doors block.
function passableForEnemy(c, r) {
  if (!inGrid(c, r) || solid[r][c]) return false;
  const d = doorAt.get(r * COLS + c);
  return !(d && d.strong && d.t < 0.85);
}
function findPath(sx, sz, tx, tz) {
  const sc = toCell(sx), sr = toCell(sz), tc = toCell(tx), tr = toCell(tz);
  const prev = new Int32Array(ROWS * COLS).fill(-2); prev[sr * COLS + sc] = -1;
  const q = [sr * COLS + sc]; let best = q[0], bestD = Infinity;
  for (let i = 0; i < q.length; i++) {
    const cur = q[i], cc = cur % COLS, cr = (cur - cc) / COLS;
    const dd = Math.abs(cc - tc) + Math.abs(cr - tr);
    if (dd < bestD) { bestD = dd; best = cur; }
    if (dd === 0) break;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = cc + dc, nr = cr + dr, ni = nr * COLS + nc;
      if (passableForEnemy(nc, nr) && prev[ni] === -2) { prev[ni] = cur; q.push(ni); }
    }
  }
  const path = [];
  for (let n = best; n !== -1 && n !== undefined; n = prev[n]) path.push(n);
  path.reverse();
  return path.map((n) => ({ x: cellC(n % COLS), z: cellC(Math.floor(n / COLS)) }));
}

// ---------- doors ----------
function toggleDoor(d, who) {
  if (d.strong && who !== 'player') return;
  d.open = !d.open; sfx('door');
}
function nearestDoor(maxDist, needFacing) {
  let best = null, bd = maxDist;
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  for (const d of doors) {
    const dx = cellC(d.c) - S.px, dz = cellC(d.r) - S.pz, dist = Math.hypot(dx, dz);
    if (dist < bd && (!needFacing || (dx * fx + dz * fz) / (dist || 1) > 0.35)) { bd = dist; best = d; }
  }
  return best;
}

// ---------- notifications ----------
let noteTimer = 0;
function note(txt, secs = 2.5) { const n = $('note'); n.textContent = txt; n.style.opacity = 1; noteTimer = secs; }

// ---------- input ----------
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (S.mode === 'dead' && e.code === 'KeyR') startGame();
  if (S.mode !== 'play') return;
  if (e.code === 'Tab') { e.preventDefault(); toggleTablet(); }
  if (S.tablet) { const n = '1234'.indexOf(e.key); if (n >= 0) { S.camIdx = n; sfx('click'); } return; }
  if (e.code === 'KeyF') { if (S.battery > 0) { S.lightOn = !S.lightOn; sfx('click'); } }
  if (e.code === 'KeyE') { const d = nearestDoor(4, true); if (d) toggleDoor(d, 'player'); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('mousemove', (e) => {
  if (S.mode !== 'play' || S.tablet || document.pointerLockElement !== canvas) return;
  S.yaw -= e.movementX * 0.0022;
  S.pitch = Math.max(-1.3, Math.min(1.3, S.pitch - e.movementY * 0.0022));
});
function toggleTablet() {
  S.tablet = !S.tablet; sfx('click');
  camLayer.style.display = S.tablet ? 'block' : 'none';
  hud.style.display = S.tablet ? 'none' : 'block';
}

function lock() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
function startGame() {
  audio(); reset(); startHum();
  S.mode = 'play';
  for (const id of ['menu', 'dead', 'win']) $(id).style.display = 'none';
  hud.style.display = 'block';
  lock();
}
$('start').onclick = startGame; $('retry').onclick = startGame; $('again').onclick = startGame;
canvas.addEventListener('click', () => { if (S.mode === 'play' && document.pointerLockElement !== canvas) lock(); });

// ---------- update ----------
const tmp = new THREE.Vector3();
function updatePlayer(dt) {
  if (S.tablet) return;
  const mult = keys.ShiftLeft || keys.ShiftRight ? SPRINT_MULT : 1;
  let mx = 0, mz = 0;
  if (keys.KeyW) mz -= 1; if (keys.KeyS) mz += 1; if (keys.KeyA) mx -= 1; if (keys.KeyD) mx += 1;
  const l = Math.hypot(mx, mz);
  if (l) {
    mx /= l; mz /= l;
    const s = Math.sin(S.yaw), c = Math.cos(S.yaw);
    const vx = (mx * c + mz * s) * WALK * mult * dt, vz = (-mx * s + mz * c) * WALK * mult * dt;
    if (playerFits(S.px + vx, S.pz)) S.px += vx;
    if (playerFits(S.px, S.pz + vz)) S.pz += vz;
  }
  // battery pickup
  for (const b of batteries) {
    if (!b.taken && Math.hypot(b.x - S.px, b.z - S.pz) < 1.3) {
      b.taken = true; b.mesh.visible = false;
      S.battery = Math.min(BATTERY_MAX, S.battery + BATTERY_PICKUP); sfx('pick'); note('배터리 +5초');
    }
  }
}

function lightActive() { return S.lightOn && S.battery > 0 && !S.tablet; }

function updateFlashlight(dt) {
  if (S.lightOn && S.battery > 0 && !S.tablet) S.battery -= dt;
  if (S.battery <= 0) { S.battery = 0; S.lightOn = false; }
  flashlight.visible = lightActive();
}

function inPlayerView(e) {
  const dx = e.x - S.px, dz = e.z - S.pz, dist = Math.hypot(dx, dz);
  if (dist > 24) return false;
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  if ((dx * fx + dz * fz) / (dist || 1) < Math.cos(0.5)) return false;
  return lineClear(S.px, S.pz, e.x, e.z);
}

function updateEnemy(e, dt) {
  const d = e.def;
  if (!e.alive) {
    if (S.hour >= d.hour) { e.alive = true; e.wakeT = 2; sfx('wake'); note(d.name + ' 이(가) 깨어났다!'); }
    e.model.userData.eyeM.color.setHex(0x000000);
    return;
  }
  e.model.userData.eyeM.color.setHex(d.eye);
  if (e.wakeT > 0) { e.wakeT -= dt; return; }

  e.frozen = lightActive() && inPlayerView(e);
  if (e.frozen) return;

  e.pathT -= dt;
  if (e.pathT <= 0 || !e.path) { e.path = findPath(e.x, e.z, S.px, S.pz); e.pathT = 0.3; }
  // open weak doors that are near and on the way
  for (const dr of doors) {
    if (!dr.strong && !dr.open && Math.hypot(cellC(dr.c) - e.x, cellC(dr.r) - e.z) < 3.5) { dr.open = true; sfx('door'); }
  }
  let tgt = e.path.length > 1 ? e.path[1] : null;   // path[0] is the cell the enemy stands in
  const reachedPlayer = toCell(e.x) === toCell(S.px) && toCell(e.z) === toCell(S.pz);
  if (reachedPlayer) tgt = { x: S.px, z: S.pz };
  if (tgt) {
    const dx = tgt.x - e.x, dz = tgt.z - e.z, l = Math.hypot(dx, dz) || 1;
    const ok = (x, z) => { const c = toCell(x), r = toCell(z), dd = doorAt.get(r * COLS + c); return passableForEnemy(c, r) && !(dd && dd.t < 0.5); };
    const sx = dx / l * d.speed * dt, sz = dz / l * d.speed * dt;
    if (ok(e.x + sx, e.z + sz)) { e.x += sx; e.z += sz; }
    else if (ok(e.x + sx, e.z)) e.x += sx;
    else if (ok(e.x, e.z + sz)) e.z += sz;
    e.yaw = Math.atan2(dx, dz);
    e.anim += dt * d.speed * 3;
  }
  // jumpscare (EnemyAI: only while walking, i.e. not frozen)
  if (Math.hypot(S.px - e.x, S.pz - e.z) < JUMPSCARE_DIST) beginJumpscare(e);
}

function beginJumpscare(e) {
  S.mode = 'jump'; S.jumpT = 0; S.killer = e;
  if (document.pointerLockElement) document.exitPointerLock();
  hud.style.display = 'none'; camLayer.style.display = 'none'; flashlight.visible = false;
  sfx('scare'); stopHum();
}

function updateJumpscare(dt) {
  S.jumpT += dt;
  const e = S.killer, m = e.model;
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  const k = Math.min(1, S.jumpT / 0.25);
  m.position.set(S.px + fx * (2.4 - 1.3 * k), 0, S.pz + fz * (2.4 - 1.3 * k));
  m.rotation.y = Math.atan2(S.px - m.position.x, S.pz - m.position.z);
  m.scale.setScalar(1 + 0.25 * Math.sin(S.jumpT * 60));
  m.userData.head.rotation.z = Math.sin(S.jumpT * 70) * 0.25;
  // look toward the head
  S.pitch += ((0.25) - S.pitch) * Math.min(1, dt * 8);
  const f = $('flash'); f.style.opacity = Math.max(0, 0.9 * Math.sin(S.jumpT * 40) * (S.jumpT < 0.6 ? 1 : 0));
  if (S.jumpT > 0.9) {
    f.style.opacity = 0; S.mode = 'dead';
    $('deadby').textContent = e.def.name + ' 에게 잡혔습니다.  ' + (S.hour === 0 ? '12' : S.hour) + ' AM';
    $('dead').style.display = 'flex';
  }
}

function updateDoors(dt) {
  for (const d of doors) {
    d.t += ((d.open ? 1 : 0) - d.t) * Math.min(1, dt * 6);
    d.mesh.position.y = d.baseY + d.t * (WALL_H - 0.2);
  }
}

function updateClock(dt) {
  S.clock += dt * CLOCK_RATE;
  S.hour = Math.floor(S.clock / 60);
  if (S.clock >= 60 * NIGHT_HOURS) { win(); return; }
  $('clock').textContent = (S.hour === 0 ? '12' : S.hour) + ' AM';
}
function win() {
  S.mode = 'win'; sfx('win'); stopHum();
  if (document.pointerLockElement) document.exitPointerLock();
  hud.style.display = 'none'; camLayer.style.display = 'none';
  enemies.forEach((e) => { e.model.visible = false; });
  $('win').style.display = 'flex';
}

function updateHud(dt) {
  const bars = 5, on = Math.ceil((S.battery / BATTERY_MAX) * bars - 1e-6);
  const el = $('bat');
  if (el.children.length === 1) for (let i = 0; i < bars; i++) el.appendChild(document.createElement('i'));
  for (let i = 0; i < bars; i++) el.children[i + 1].className = i < on ? 'on' : '';
  const d = nearestDoor(4, true);
  $('tip').textContent = d ? `E: ${d.strong ? '강한 문' : '문'} ${d.open ? '닫기' : '열기'}` : (S.battery <= 0 ? '배터리 없음 — 초록 배터리를 찾으세요' : '');
  if (noteTimer > 0) { noteTimer -= dt; if (noteTimer <= 0) $('note').style.opacity = 0; }
}

// security-camera noise
const nz = $('noise'), nzc = nz.getContext('2d'); nz.width = 160; nz.height = 90;
function drawNoise() {
  const img = nzc.createImageData(160, 90);
  for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  nzc.putImageData(img, 0, 0);
}

// enemy visuals
function syncEnemies() {
  for (const e of enemies) {
    if (S.mode !== 'jump' || e !== S.killer) {
      e.model.position.set(e.x, 0, e.z); e.model.rotation.y = e.yaw; e.model.scale.setScalar(1);
    }
    const u = e.model.userData, sw = e.alive && !e.frozen && e.wakeT <= 0 ? Math.sin(e.anim) * 0.6 : 0;
    u.legs[0].rotation.x = sw; u.legs[1].rotation.x = -sw; u.arms[0].rotation.x = -sw; u.arms[1].rotation.x = sw;
    if (!e.alive) { u.head.rotation.x = 0.35; } else if (e.wakeT > 0) { u.head.rotation.x = 0.35 * (e.wakeT / 2); u.head.rotation.z = Math.sin(e.wakeT * 30) * 0.08; }
    else u.head.rotation.x = 0;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.mode === 'play') {
    updateClock(dt);
    if (S.mode === 'play') {
      updateDoors(dt); updatePlayer(dt); updateFlashlight(dt);
      for (const e of enemies) if (S.mode === 'play') updateEnemy(e, dt);
      updateHud(dt);
    }
  } else if (S.mode === 'jump') { updateDoors(dt); updateJumpscare(dt); }
  syncEnemies();

  camera.position.set(S.px, 1.6 + (S.mode === 'play' && (keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD) ? Math.sin(now / 120) * 0.03 : 0), S.pz);
  camera.rotation.set(S.pitch, S.yaw, 0);

  if (S.tablet && S.mode === 'play') {
    drawNoise();
    const c = camSpots[S.camIdx];
    camCam.position.set(c.x, WALL_H - 0.6, c.z); camCam.lookAt(c.tx, 1.2, c.tz);
    $('camname').textContent = c.name;
    flashlight.visible = false;
    renderer.render(scene, camCam);
  } else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize(); reset();
// idle menu backdrop
S.px = cellC(10); S.pz = cellC(6);
requestAnimationFrame(frame);

// test hooks (also handy for debugging in the console)
window.__fnaf = { S, enemies: () => enemies, doors, MAP, findPath, startGame, win };
})();
