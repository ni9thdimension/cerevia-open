// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Rahul Vats, Cerevia (cerevia.in)
// node test_motion.js : the motion library must obey the physics it claims to.
const M = require('./motion.js');
let failed = 0;
const check = (name, ok, detail) => { console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); if (!ok) failed++; };

// springs: Apple's response / damping-ratio form maps to stiffness and damping correctly
{
  const { k, c } = M.springConstants(0.4, 1);
  check('damping ratio 1 is exactly critical damping (c = 2 * sqrt(k))', Math.abs(c - 2 * Math.sqrt(k)) < 1e-9, `c ${c.toFixed(3)}, 2*sqrt(k) ${(2 * Math.sqrt(k)).toFixed(3)}`);
  const crit = M.simulateSpring({ from: 0, to: 100, response: 0.4, ratio: 1 });
  check('a critically damped spring never overshoots', crit.peak <= 100 + 1e-6, `peak ${crit.peak.toFixed(4)}`);
  const wn = 2 * Math.PI / 0.4; let tt = 0; while ((1 + wn * tt) * Math.exp(-wn * tt) > 1e-4) tt += 1e-4;   // theory: (1 + w t) e^(-w t) = 1e-4
  check('and settles when theory says it should', Math.abs(crit.settleTime - tt) / tt < 0.08, `${crit.settleTime.toFixed(3)} s vs theory ${tt.toFixed(3)} s`);
  const bouncy = M.simulateSpring({ from: 0, to: 100, response: 0.4, ratio: 0.5 });
  const zeta = 0.5, expected = 100 * Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta));
  check('an under-damped spring overshoots by the textbook amount', Math.abs((bouncy.peak - 100) - expected) / expected < 0.03, `overshoot ${(bouncy.peak - 100).toFixed(2)} vs theory ${expected.toFixed(2)}`);
}

// the flow field is divergence free, so particles neither clump nor drain
{
  const noise = M.makeNoise(3), R = M.rng(5); let worst = 0, mag = 0;
  for (let i = 0; i < 400; i++) {
    const x = R() * 40, y = R() * 40, h = 1e-3;
    const [ax] = M.curl(noise, x + h, y), [bx] = M.curl(noise, x - h, y), [, ay] = M.curl(noise, x, y + h), [, by] = M.curl(noise, x, y - h);
    worst = Math.max(worst, Math.abs((ax - bx) / (2 * h) + (ay - by) / (2 * h)));
    const [vx, vy] = M.curl(noise, x, y); mag = Math.max(mag, Math.hypot(vx, vy));
  }
  check('the curl-noise flow is divergence free (no sources or sinks)', worst < 0.05 * mag, `largest divergence ${worst.toExponential(2)} against field strength ${mag.toFixed(2)}`);
}

// particles: deterministic, stable, and they settle onto their targets without overshoot
{
  const mk = () => new M.ParticleSystem({ count: 600, width: 400, height: 200, seed: 21 });
  const a = mk(), b = mk(); for (let i = 0; i < 300; i++) { a.step(); b.step(); }
  check('the same seed gives the same particles (deterministic)', a.x.every((v, i) => v === b.x[i]) && a.y.every((v, i) => v === b.y[i]));

  const s = mk(); const pts = []; for (let i = 0; i < 400; i++) pts.push([100 + (i % 20) * 10, 50 + Math.floor(i / 20) * 5]);
  s.setTargets(pts); const start = s.settleError(); let prev = start, rose = 0;
  for (let t = 0; t < 120 * 3; t++) { s.step(); if (t % 12 === 0) { const e = s.settleError(); if (e > prev + 0.5) rose++; prev = e; } }
  const end = s.settleError();
  check('particles given a target settle onto it (noise becomes signal)', end < 1.5, `mean distance from ${start.toFixed(1)} px to ${end.toFixed(2)} px in 3 s`);
  check('they arrive without swinging back and forth', rose === 0, `${rose} rises in the error curve`);
  const free = [...Array(s.n).keys()].filter((i) => !s.has[i]);
  check('the remaining particles stay free (the noise is still there)', free.length === 200);

  const f = mk(); let bad = false, maxSpeed = 0;
  for (let t = 0; t < 120 * 60; t++) { f.step(); if (t % 120 === 0) { maxSpeed = Math.max(maxSpeed, f.speed()); for (let i = 0; i < f.n; i++) if (!isFinite(f.x[i]) || !isFinite(f.y[i])) bad = true; } }
  let inside = true; for (let i = 0; i < f.n; i++) if (f.x[i] < -6 || f.x[i] > f.w + 6 || f.y[i] < -6 || f.y[i] > f.h + 6) inside = false;
  check('a free field stays stable for a minute (no blow-up, no NaN)', !bad && maxSpeed < 3, `largest mean speed ${(maxSpeed * 120).toFixed(1)} px/s`);
  check('free particles wrap at the edges and never leave the field', inside);
  f.release();
}

// pointer: particles move away from a pointer and come back when it leaves
{
  const s = new M.ParticleSystem({ count: 400, width: 300, height: 150, seed: 4 }); const pts = []; for (let i = 0; i < 400; i++) pts.push([100 + (i % 20) * 5, 50 + Math.floor(i / 20) * 2.5]);
  s.setTargets(pts); for (let t = 0; t < 360; t++) s.step(); const settled = s.settleError();
  s.mouse.x = 150; s.mouse.y = 75; for (let t = 0; t < 60; t++) s.step(); const pushed = s.settleError();
  s.mouse.x = s.mouse.y = -1e9; for (let t = 0; t < 360; t++) s.step(); const back = s.settleError();
  check('a pointer pushes particles away, and they return when it leaves', pushed > settled + 2 && back < 1.5, `settled ${settled.toFixed(2)} → pushed ${pushed.toFixed(2)} → back ${back.toFixed(2)} px`);
}
// rest: a picture where every particle has a place can be told apart from one with free noise, and it settles to a still state
{
  const n = 300, pts = []; for (let i = 0; i < n; i++) pts.push([60 + (i % 30) * 6, 40 + Math.floor(i / 30) * 6]);
  const all = new M.ParticleSystem({ count: n, width: 300, height: 150, seed: 6 }); all.setTargets(pts);
  const some = new M.ParticleSystem({ count: n + 50, width: 300, height: 150, seed: 6 }); some.setTargets(pts);
  for (let t = 0; t < 480; t++) { all.step(); some.step(); }
  check('"full" is true only when every particle has a target', all.full === true && some.full === false, `all ${all.full}, with free particles ${some.full}`);
  check('a fully targeted picture settles below the rest threshold (so the loop can stop)', all.settleError() < 1.6 && all.speed() < 0.14 && some.speed() > all.speed(), `error ${all.settleError().toFixed(2)} px, speed ${all.speed().toFixed(3)} vs ${some.speed().toFixed(3)} with noise`);
  all.release(); check('releasing the targets makes it free again', all.full === false);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall motion checks passed');
process.exit(failed ? 1 : 0);
