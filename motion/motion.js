// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Rahul Vats, Cerevia
/* motion.js: Cerevia Motion, a small physics-based UI motion library. Four laws: spring, gravity, pendulum and collision, path. Plus a real particle system.
 *
 * Research behind it:
 *  - Springs are specified the way Apple does it (WWDC23 "Animate with springs"): a response (seconds per oscillation) and a damping
 *    ratio (1 = critically damped, no overshoot). With mass 1: stiffness k = (2*pi/response)^2, damping c = 4*pi*ratio/response.
 *    A spring keeps its velocity when it is retargeted, so interrupted motion stays smooth.
 *  - Durations and easings follow the productive / expressive split used by IBM Carbon and Material 3: short and quiet for tasks,
 *    longer for the one moment that matters.
 *  - Reduced motion (WCAG 2.3.3, techniques C39 and SCR40): every function jumps to its end state when the operating system asks for
 *    less motion OR when the person switches motion off on the site (html[data-motion="reduce"]). The preference is read live.
 *  - Particles: semi-implicit Verlet integration at a fixed step, a curl-noise flow field (divergence free, so particles neither clump
 *    nor drain away), a critically damped pull toward targets, typed arrays, batched drawing, device pixel ratio capped at 2,
 *    paused when off screen or when the tab is hidden.
 *
 * The physics core has no DOM dependency, so `node test_motion.js` can check it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CereviaMotion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  const raf = hasDOM ? (f) => window.requestAnimationFrame(f) : (f) => setTimeout(() => f(Date.now()), 16);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ---------------------------------------------------------------- tokens */
  const DURATION = { instant: 70, fast: 160, base: 280, slow: 480, scene: 900, story: 1400 };
  const EASE = {
    out: (t) => 1 - Math.pow(1 - t, 3),                                   // arrive
    in: (t) => t * t * t,                                                // leave
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), // travel
    linear: (t) => t,
  };
  const SPRING = { gentle: { response: 0.55, ratio: 1 }, base: { response: 0.4, ratio: 1 }, snappy: { response: 0.28, ratio: 1 } };

  /* ---------------------------------------------------------------- reduced motion, read live */
  let mq = null;
  if (hasDOM && window.matchMedia) mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() {
    if (!hasDOM) return false;
    if (document.documentElement.dataset.motion === 'reduce') return true;
    if (document.documentElement.dataset.motion === 'full') return false;
    return !!(mq && mq.matches);
  }

  /* ---------------------------------------------------------------- spring maths (pure) */
  function springConstants(response, ratio) {
    const k = Math.pow((2 * Math.PI) / response, 2);
    const c = (4 * Math.PI * ratio) / response;
    return { k, c };
  }
  /* one step of a damped spring, semi-implicit Euler; returns [x, v] */
  function springStep(x, v, target, k, c, dt) {
    const a = -k * (x - target) - c * v;
    v += a * dt;
    x += v * dt;
    return [x, v];
  }
  /* simulate a spring to rest; used by tests and by reduced-motion fallbacks */
  function simulateSpring({ from, to, response = 0.4, ratio = 1, dt = 1 / 4000, max = 10 }) {
    const { k, c } = springConstants(response, ratio);
    let x = from, v = 0, t = 0, peak = from;
    const trace = [];
    while (t < max) {
      [x, v] = springStep(x, v, to, k, c, dt); t += dt; trace.push(x);
      if (Math.abs(to - from) > 0) peak = (to > from) ? Math.max(peak, x) : Math.min(peak, x);
      const span = Math.max(1e-9, Math.abs(to - from)), w = (2 * Math.PI) / response;
      if (Math.abs(x - to) < 1e-4 * span && Math.abs(v) < 1e-4 * span * w) break;   // settled: within 0.01% of the move, relative to its speed scale
    }
    return { settleTime: t, peak, trace };
  }

  /* ---------------------------------------------------------------- animation primitives (DOM time) */
  function tween(duration, onUpdate, { delay = 0, ease = EASE.out, onDone } = {}) {
    if (reduced()) { onUpdate(1); if (onDone) onDone(); return { cancel() {} }; }
    let stop = false; const t0 = now() + delay;
    const f = (n) => { if (stop) return; const tn = typeof n === 'number' ? n : now(); if (tn < t0) { raf(f); return; }
      const t = Math.min(1, (tn - t0) / duration); onUpdate(ease(t)); if (t < 1) raf(f); else if (onDone) onDone(); };
    raf(f);
    return { cancel() { stop = true; } };
  }

  /* a retargetable spring: createSpring({value, response, ratio, onUpdate}).to(target) keeps velocity */
  function createSpring({ value = 0, response = SPRING.base.response, ratio = SPRING.base.ratio, onUpdate = () => {}, onRest } = {}) {
    let x = value, v = 0, target = value, running = false, last = 0;
    let { k, c } = springConstants(response, ratio);
    const loop = (n) => {
      const tn = typeof n === 'number' ? n : now(); const dt = Math.min(0.032, last ? (tn - last) / 1000 : 1 / 60); last = tn;
      let steps = Math.max(1, Math.round(dt / (1 / 240)));
      for (let i = 0; i < steps; i++) [x, v] = springStep(x, v, target, k, c, dt / steps);
      onUpdate(x, v);
      if (Math.abs(x - target) < 1e-3 && Math.abs(v) < 1e-3) { x = target; v = 0; onUpdate(x, v); running = false; if (onRest) onRest(x); return; }
      raf(loop);
    };
    return {
      to(t, { velocity } = {}) {
        target = t; if (velocity != null) v = velocity;
        if (reduced()) { x = t; v = 0; onUpdate(x, v); if (onRest) onRest(x); return this; }
        if (!running) { running = true; last = 0; raf(loop); }
        return this;
      },
      set(t) { x = target = t; v = 0; onUpdate(x, v); return this; },
      configure(o) { ({ k, c } = springConstants(o.response || response, o.ratio == null ? ratio : o.ratio)); return this; },
      get value() { return x; }, get velocity() { return v; },
    };
  }
  /* compatibility helper with the app's existing signature: spring(from, to, apply, {k, delay}) */
  function springTo(from, to, apply, { k = 170, delay = 0, response, ratio = 1 } = {}) {
    const resp = response || (2 * Math.PI) / Math.sqrt(k);
    if (reduced()) { apply(to); return; }
    const s = createSpring({ value: from, response: resp, ratio, onUpdate: (x) => apply(x) });
    setTimeout(() => s.to(to), delay);
  }

  /* gravity: free fall d = g t^2 / 2, stops at distance */
  function fall({ distance, g = 2400, delay = 0, onUpdate, onDone }) {
    if (reduced()) { onUpdate(distance); if (onDone) onDone(); return; }
    const t0 = now() + delay;
    const f = (n) => { const tn = typeof n === 'number' ? n : now(); const t = Math.max(0, (tn - t0) / 1000); const d = Math.min(distance, 0.5 * g * t * t);
      onUpdate(d); if (d < distance) raf(f); else if (onDone) onDone(); };
    raf(f);
  }

  /* path: draw an SVG path (or line) as if a pen were moving */
  function drawPath(el, { duration = DURATION.scene, delay = 0, ease = EASE.inOut } = {}) {
    el.setAttribute('pathLength', '1'); el.setAttribute('stroke-dasharray', '1'); el.setAttribute('stroke-dashoffset', '1');
    return tween(duration, (t) => el.setAttribute('stroke-dashoffset', String(1 - t)), { delay, ease });
  }

  /* ---------------------------------------------------------------- seeded randomness and noise (pure) */
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function makeNoise(seed = 7) {
    const R = rng(seed), p = new Uint8Array(512), perm = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const grad = (h, x, y) => { const g = h & 7; const u = g < 4 ? x : y, v = g < 4 ? y : x; return ((g & 1) ? -u : u) + ((g & 2) ? -2 * v : 2 * v); };
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    return function noise2(x, y) {   // Perlin gradient noise, about -1..1
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
      const u = fade(x), v = fade(y), a = p[X] + Y, b = p[X + 1] + Y;
      const l1 = grad(p[a], x, y) + u * (grad(p[b], x - 1, y) - grad(p[a], x, y));
      const l2 = grad(p[a + 1], x, y - 1) + u * (grad(p[b + 1], x - 1, y - 1) - grad(p[a + 1], x, y - 1));
      return (l1 + v * (l2 - l1)) * 0.5;
    };
  }
  /* the curl of a scalar noise field: (dN/dy, -dN/dx). Divergence free by construction. */
  function curl(noise, x, y, eps = 0.01) {
    const n1 = noise(x, y + eps), n2 = noise(x, y - eps), n3 = noise(x + eps, y), n4 = noise(x - eps, y);
    return [(n1 - n2) / (2 * eps), -(n3 - n4) / (2 * eps)];
  }

  /* ---------------------------------------------------------------- particle system: physics only (pure, testable) */
  class ParticleSystem {
    /* units: pixels and seconds. settle = seconds for a targeted particle to arrive (one spring period);
       drift = free-particle damping per second; flow = flow-field acceleration in px/s^2; push = pointer repulsion in px/s^2 */
    constructor({ count = 1200, width = 800, height = 400, seed = 11, settle = 0.7, drift = 2.4, flow = 60, flowScale = 0.0042, push = 4000 } = {}) {
      this.n = count; this.w = width; this.h = height; this.R = rng(seed); this.noise = makeNoise(seed + 1);
      this.x = new Float32Array(count); this.y = new Float32Array(count); this.px = new Float32Array(count); this.py = new Float32Array(count);
      this.tx = new Float32Array(count); this.ty = new Float32Array(count); this.has = new Uint8Array(count); this.hi = new Uint8Array(count);
      this.settle = settle; this.drift = drift; this.flow = flow; this.flowScale = flowScale; this.t = 0; this.dt = 1 / 120;
      this.mouse = { x: -1e9, y: -1e9, r: 70, push };
      for (let i = 0; i < count; i++) { this.x[i] = this.px[i] = this.R() * width; this.y[i] = this.py[i] = this.R() * height; }
    }
    resize(w, h) { const sx = w / this.w, sy = h / this.h; for (let i = 0; i < this.n; i++) { this.x[i] *= sx; this.px[i] *= sx; this.y[i] *= sy; this.py[i] *= sy; this.tx[i] *= sx; this.ty[i] *= sy; } this.w = w; this.h = h; }
    /* targets: [[x,y], ...]; particles beyond the target count stay free (the noise). highlight: indices or a fraction to mark */
    setTargets(points, { shuffle = true } = {}) {
      const idx = [...Array(this.n).keys()];
      if (shuffle) for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(this.R() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      this.has.fill(0); this.full = Math.min(points.length, this.n) === this.n;      // every particle has a place: nothing is left to drift
      for (let k = 0; k < Math.min(points.length, this.n); k++) { const i = idx[k]; this.tx[i] = points[k][0]; this.ty[i] = points[k][1]; this.has[i] = 1; }
      return this;
    }
    release() { this.has.fill(0); this.full = false; return this; }
    highlight(fraction) { this.hi.fill(0); const cut = Math.floor(this.n * fraction); for (let i = 0; i < cut; i++) this.hi[i] = 1; return this; }
    step() {
      const dt = this.dt, dt2 = dt * dt;
      const k = Math.pow((2 * Math.PI) / this.settle, 2);          // spring constant for the pull toward a target
      const dampT = Math.min(0.9, 2 * Math.sqrt(k) * dt);          // critical damping: arrive without overshoot
      const dampF = Math.min(0.9, this.drift * dt);                // free particles: light air drag
      this.t += dt; const tz = this.t * 0.08, fs = this.flowScale, m = this.mouse;
      for (let i = 0; i < this.n; i++) {
        const free = !this.has[i];
        const [fx, fy] = curl(this.noise, this.x[i] * fs + tz, this.y[i] * fs - tz * 0.6);
        let ax = fx * this.flow * (free ? 1 : 0.05), ay = fy * this.flow * (free ? 1 : 0.05);
        if (!free) { ax += (this.tx[i] - this.x[i]) * k; ay += (this.ty[i] - this.y[i]) * k; }
        const dxm = this.x[i] - m.x, dym = this.y[i] - m.y, d2 = dxm * dxm + dym * dym;
        if (d2 < m.r * m.r && d2 > 1) { const d = Math.sqrt(d2), f = m.push * (1 - d / m.r); ax += (dxm / d) * f; ay += (dym / d) * f; }
        const damp = free ? dampF : dampT;
        const vx = (this.x[i] - this.px[i]) * (1 - damp), vy = (this.y[i] - this.py[i]) * (1 - damp);
        this.px[i] = this.x[i]; this.py[i] = this.y[i];
        this.x[i] += vx + ax * dt2; this.y[i] += vy + ay * dt2;
        if (free) {
          if (this.x[i] < -4) { this.x[i] += this.w + 8; this.px[i] = this.x[i]; } else if (this.x[i] > this.w + 4) { this.x[i] -= this.w + 8; this.px[i] = this.x[i]; }
          if (this.y[i] < -4) { this.y[i] += this.h + 8; this.py[i] = this.y[i]; } else if (this.y[i] > this.h + 4) { this.y[i] -= this.h + 8; this.py[i] = this.y[i]; }
        }
      }
    }
    advance(seconds) { this._acc = (this._acc || 0) + Math.min(seconds, 1 / 15); while (this._acc >= this.dt) { this.step(); this._acc -= this.dt; } }
    /* mean distance of targeted particles from their targets: the "how settled" measure */
    settleError() { let s = 0, m = 0; for (let i = 0; i < this.n; i++) if (this.has[i]) { s += Math.hypot(this.tx[i] - this.x[i], this.ty[i] - this.y[i]); m++; } return m ? s / m : 0; }
    speed() { let s = 0; for (let i = 0; i < this.n; i++) s += Math.hypot(this.x[i] - this.px[i], this.y[i] - this.py[i]); return s / this.n; }
  }

  /* ---------------------------------------------------------------- particle field: rendering, interaction, lifecycle (DOM) */
  function sampleText(text, w, h, { font = '700 220px "Barlow Condensed", sans-serif', step = 3 } = {}) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font;
    let size = parseInt((font.match(/(\d+)px/) || [0, 160])[1], 10);
    while ((g.measureText(text).width > w * 0.9 || size > h * 0.8) && size > 20) { size -= 6; g.font = font.replace(/\d+px/, size + 'px'); }
    g.fillText(text, w / 2, h / 2);
    const d = g.getImageData(0, 0, w, h).data, pts = [];
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (d[(y * w + x) * 4 + 3] > 128) pts.push([x + (Math.random() - 0.5), y + (Math.random() - 0.5)]);
    return pts;
  }
  function samplePoints(fn, count) { const pts = []; for (let i = 0; i < count; i++) pts.push(fn(i / count, i)); return pts; }

  class ParticleField {
    constructor(canvas, { count = 1400, colors = ['#226192', '#EF8557'], size = 2.2, seed = 11, interactive = true, label = '', rest = false, still = false, sysOpts = {} } = {}) {
      this.cv = canvas; this.g = canvas.getContext('2d'); this.colors = colors; this.size = size;
      const r = canvas.getBoundingClientRect(); this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
      this.sys = new ParticleSystem({ count, width: this.w, height: this.h, seed, ...sysOpts }); this.rest = rest; this.still = still;   // rest: stop animating once everything has arrived, so a settled picture costs nothing
      this.visible = true; this.running = false; this.last = 0; this.label = label;
      if (label) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label); }
      this._fit();
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._fit()).observe(canvas);
      if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver((es) => { this.visible = es[0].isIntersecting; if (this.visible) this.play(); }, { threshold: 0.05 }).observe(canvas);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.play(); });
      if (interactive) {
        canvas.addEventListener('pointermove', (e) => { const b = canvas.getBoundingClientRect(); this.sys.mouse.x = e.clientX - b.left; this.sys.mouse.y = e.clientY - b.top; this.play(); });
        canvas.addEventListener('pointerleave', () => { this.sys.mouse.x = this.sys.mouse.y = -1e9; });
      }
      this.draw(); this.play();
    }
    _fit() {
      const r = this.cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (r.width < 2) return;
      this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr); this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (Math.abs(r.width - this.w) > 1 || Math.abs(r.height - this.h) > 1) { this.sys.resize(r.width, r.height); this.w = r.width; this.h = r.height; }
      this.draw();
    }
    draw() {
      const g = this.g, s = this.sys, z = this.size; g.clearRect(0, 0, this.w, this.h);
      const batch = (color, alpha, test) => { g.globalAlpha = alpha; g.fillStyle = color; g.beginPath();
        for (let i = 0; i < s.n; i++) if (test(i)) g.rect(s.x[i] - z / 2, s.y[i] - z / 2, z, z); g.fill(); };
      batch(this.colors[0], 0.45, (i) => !s.has[i] && !s.hi[i]);   // the noise: free and faint
      batch(this.colors[0], 1, (i) => s.has[i] && !s.hi[i]);       // the signal: settled into shape
      batch(this.colors[1], 1, (i) => s.hi[i]);                    // the one thing that needs you
      g.globalAlpha = 1;
    }
    play() {
      if (this.still) return;                     // a still scatter is drawn once and never animated
      if (reduced()) { this.settleNow(); return; }
      if (this.running || !this.visible || document.hidden) return; this.running = true; this.last = 0;
      const loop = (n) => { if (!this.visible || document.hidden || !this.cv.isConnected) { this.running = false; return; }
        const dt = this.last ? (n - this.last) / 1000 : 1 / 60; this.last = n; this.sys.advance(dt); this.draw();
        if (this.rest && this.sys.full && this.sys.settleError() < 1.6 && this.sys.speed() < 0.14) { this.running = false; return; }
        raf(loop); };
      raf(loop);
    }
    settleNow() { for (let i = 0; i < 900; i++) this.sys.step(); this.draw(); }
    /* noise becomes signal */
    formText(text, opts = {}) { this.still = false; const pts = sampleText(text, Math.round(this.w), Math.round(this.h), opts); this.sys.setTargets(pts); this.play(); return pts.length; }
    formPoints(pts) { this.still = false; this.sys.setTargets(pts); this.play(); }
    scatter() { this.sys.release(); this.play(); }
    highlight(f) { this.sys.highlight(f); this.draw(); }
  }

  return { DURATION, EASE, SPRING, reduced, springConstants, springStep, simulateSpring, tween, createSpring, springTo, fall, drawPath,
           rng, makeNoise, curl, ParticleSystem, ParticleField, sampleText, samplePoints };
});
