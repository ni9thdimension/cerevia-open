// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Rahul Vats, Cerevia (cerevia.in)
// node test_cradle.js : the cradle must obey the physics it claims to.
const { create, G } = require('./cradle-physics.js');
let failed = 0;
const check = (name, ok, detail) => { console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); if (!ok) failed++; };
const deg = x => x * 180 / Math.PI, rad = x => x * Math.PI / 180;

// 1. a single pendulum keeps the right period: T = 2*pi*sqrt(L/g) * (1 + a^2/16 + 11 a^4/3072)
{
  const c = create({ n: 1, drag: 0 }), a = 0.35; c.lift(0, a);
  let t = 0, last = c.theta[0], crossings = []; const dt = 1 / 480;
  for (let k = 0; k < 480 * 6; k++) { c.step(1); t += dt; if (last > 0 && c.theta[0] <= 0) crossings.push(t); last = c.theta[0]; }
  const T = crossings[1] - crossings[0], Tth = 2 * Math.PI * Math.sqrt(c.L / G) * (1 + a * a / 16 + 11 * a ** 4 / 3072);
  check('pendulum period matches theory', Math.abs(T - Tth) / Tth < 0.005, `measured ${T.toFixed(4)} s, theory ${Tth.toFixed(4)} s`);
}

// 2. with no losses, a swinging cradle conserves energy
{
  const c = create({ n: 5, e: 1, drag: 0 }); c.lift(4, rad(36)); const E0 = c.energy().total; let worst = 0;
  for (let k = 0; k < 480 * 8; k++) { c.step(1); worst = Math.max(worst, Math.abs(c.energy().total - E0) / E0); }
  check('energy is conserved (e = 1, no drag) over 8 s', worst < 0.01, `worst drift ${(worst * 100).toFixed(2)} %`);
}

// 3. the classic result: lift one ball, one ball leaves the other end at the same height, the middle balls barely move
{
  const c = create({ n: 5, e: 1, drag: 0 }); c.lift(4, rad(36)); const a0 = 36; let peak0 = 0, peakMid = 0, hit = false;
  for (let k = 0; k < 480 * 1.2; k++) { c.step(1); peak0 = Math.max(peak0, -deg(c.theta[0])); peakMid = Math.max(peakMid, ...[1, 2, 3].map(i => Math.abs(deg(c.theta[i])))); }
  check('lifting one ball sends one ball out the other side at the same angle', Math.abs(peak0 - a0) / a0 < 0.03, `far ball peak ${peak0.toFixed(1)} deg vs ${a0} deg`);
  check('the middle balls hardly move', peakMid < 1.0, `largest middle swing ${peakMid.toFixed(2)} deg`);
}

// 4. two balls lifted send two balls out (the behaviour a scripted animation cannot fake)
{
  const c = create({ n: 5, e: 1, drag: 0 }); c.lift(3, rad(30)); c.lift(4, rad(30)); let p0 = 0, p1 = 0, p2 = 0;
  for (let k = 0; k < 480 * 1.2; k++) { c.step(1); p0 = Math.max(p0, -deg(c.theta[0])); p1 = Math.max(p1, -deg(c.theta[1])); p2 = Math.max(p2, Math.abs(deg(c.theta[2]))); }
  check('lifting two balls sends two out', p0 > 24 && p1 > 24 && p2 < 4, `ball1 ${p0.toFixed(1)} deg, ball2 ${p1.toFixed(1)} deg, middle ${p2.toFixed(1)} deg`);
}

// 5. symmetry: lifting the left ball sends the right ball out
{
  const c = create({ n: 5, e: 1, drag: 0 }); c.lift(0, -rad(36)); let p = 0;
  for (let k = 0; k < 480 * 1.2; k++) { c.step(1); p = Math.max(p, deg(c.theta[4])); }
  check('mirror image: left ball in, right ball out', Math.abs(p - 36) / 36 < 0.03, `${p.toFixed(1)} deg`);
}

// 6. real losses: with the default restitution and drag, the swing decays and the cradle comes to rest
{
  const c = create({ n: 5 }); c.lift(4, rad(36)); let E = c.energy().total, mono = true, t = 0, rest = null;
  for (let k = 0; k < 480 * 60; k++) { c.step(1); t += 1 / 480; if (k % 480 === 0) { const e = c.energy().total; if (e > E * 1.001) mono = false; E = e; } if (rest == null && c.atRest()) rest = t; }
  check('with losses the energy only goes down', mono);
  check('it comes to rest on its own in a sensible time', rest != null && rest < 40, rest != null ? `at ${rest.toFixed(1)} s` : 'did not settle in 60 s');
}

// 7. momentum is handed on through the chain at impact (before gravity acts), within the constraint of the strings
{
  const c = create({ n: 5, e: 1, drag: 0 }); c.lift(4, rad(5)); c.step(480 * 0.6);
  let maxStep = 0; for (let k = 0; k < 480; k++) { const p0 = c.momentumX(); c.step(1); maxStep = Math.max(maxStep, Math.abs(c.momentumX() - p0)); }
  check('no sudden loss or gain of momentum from a collision step beyond gravity', maxStep < 0.02, `largest step change ${maxStep.toExponential(2)}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall cradle physics checks passed');
process.exit(failed ? 1 : 0);
