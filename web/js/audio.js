/* WebAudio wrapper: Unity AudioSource-like voices using the original clips (converted to .ogg). */
(function (G) {
'use strict';

class AudioMgr {
  constructor(assets) {
    this.assets = assets; this.ctx = null; this.buffers = new Map(); this.master = null; this.voices = new Set();
    this.paused = false;
  }
  unlock() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination); } catch (e) { return; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  async buffer(clipPath) {
    const web = this.assets.map[clipPath];
    if (!web) return null;
    if (this.buffers.has(web)) return this.buffers.get(web);
    const p = (async () => {
      this.unlock(); if (!this.ctx) return null;
      const ab = await (await fetch(web)).arrayBuffer();
      return await new Promise((res) => this.ctx.decodeAudioData(ab, res, () => res(null)));
    })();
    this.buffers.set(web, p);
    return p;
  }
  // returns a handle {stop(), playing, onended}
  async play(clipPath, opts = {}) {
    const h = { playing: false, stopped: false, onended: null, src: null, gain: null };
    const buf = await this.buffer(clipPath);
    if (!buf || !this.ctx || h.stopped) return h;
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = !!opts.loop;
    const g = this.ctx.createGain(); g.gain.value = opts.vol == null ? 1 : opts.vol;
    src.connect(g); g.connect(this.master);
    src.onended = () => { h.playing = false; this.voices.delete(h); if (h.onended && !h.stopped) h.onended(); };
    src.start(); h.playing = true; h.src = src; h.gain = g; h.duration = buf.duration;
    this.voices.add(h);
    h.stop = () => { if (h.playing) { h.stopped = true; h.playing = false; try { src.stop(); } catch (e) {} this.voices.delete(h); } };
    return h;
  }
  setPaused(p) { if (!this.ctx) return; if (p) this.ctx.suspend(); else this.ctx.resume(); }
}
G.AudioMgr = AudioMgr;
})(window);
