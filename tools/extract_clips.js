// Node: extract the animation clips of the "@walking" FBX files into small JSON files (the FBXs also carry meshes, ~20 MB).
// usage: node tools/extract_clips.js <three-dir> <web-dir>   (three-dir = unpacked npm three@0.128.0 "package")
const fs = require('fs'), vm = require('vm'), path = require('path');
const [three, web] = process.argv.slice(2);
global.window = global; global.THREE = require(path.join(three, 'build/three.min.js'));
for (const f of ['libs/fflate.min.js', 'curves/NURBSUtils.js', 'curves/NURBSCurve.js', 'loaders/FBXLoader.js']) vm.runInThisContext(fs.readFileSync(path.join(three, 'examples/js', f), 'utf8'));
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };
const assets = JSON.parse(fs.readFileSync(path.join(web, 'data/assets.json')));
const anims = JSON.parse(fs.readFileSync(path.join(web, 'data/anims.json')));
const out = {};
const want = new Set();
for (const c of Object.values(anims.controllers)) for (const l of c.layers) for (const s of Object.values(l.states)) if (s.motion && s.motion.fbx) want.add(s.motion.fbx);
for (const w of want) {
  const buf = fs.readFileSync(path.join(web, w));
  const g = new THREE.FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const clip = g.animations[0];
  if (!clip) continue;
  // round to 4 decimals: the JSON gets much smaller
  const j = THREE.AnimationClip.toJSON(clip);
  for (const t of j.tracks) { t.times = t.times.map((v) => +v.toFixed(4)); t.values = t.values.map((v) => +v.toFixed(4)); }
  out[w] = j;
  console.log(w, clip.tracks.length, 'tracks', (JSON.stringify(j).length / 1024).toFixed(0), 'KB');
}
fs.writeFileSync(path.join(web, 'data/walkclips.json'), JSON.stringify(out));
