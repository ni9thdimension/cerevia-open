// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Ninth Dimension
/* cradle-physics.js: Newton's cradle as a real simulation, not an animation.
 *
 * Each ball is a point mass on a rigid string of length L under gravity g (a pendulum): theta'' = -(g/L) sin(theta) - drag*theta'.
 * Neighbouring balls collide. The impulse is solved along the line of centres and respects the strings (a ball can only move along
 * its own tangent), so momentum and energy behave as they do on a real cradle: with restitution 1 and equal masses the velocity
 * is handed along the chain and the far ball swings out. Several passes per step let a hit travel through balls that are touching.
 * Integration is semi-implicit (symplectic) Euler at a fixed 480 Hz, so energy does not drift.
 *
 * Units: metres, seconds, unit mass. The page maps metres to pixels.
 * Works in a browser (window.CradlePhysics) and in Node (module.exports) so the physics can be tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CradlePhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const G = 9.81;

  function create(opt) {
    opt = opt || {};
    const n = opt.n || 5, L = opt.L || 0.30, r = opt.r || 0.05;
    const e = opt.e == null ? 0.985 : opt.e, drag = opt.drag == null ? 0.22 : opt.drag, dt = 1 / 480;
    const th = new Array(n).fill(0), om = new Array(n).fill(0);
    let held = -1, acc = 0;

    const pivotX = i => i * 2 * r;
    const cx = i => pivotX(i) + L * Math.sin(th[i]);
    const cy = i => L * Math.cos(th[i]);

    function integrate() {
      for (let i = 0; i < n; i++) {
        if (i === held) continue;
        om[i] += (-(G / L) * Math.sin(th[i]) - drag * om[i]) * dt;
        th[i] += om[i] * dt;
      }
    }

    function collide() {
      for (let pass = 0; pass < 40; pass++) {
        let any = false;
        const order = pass % 2 ? [...Array(n - 1).keys()].reverse() : [...Array(n - 1).keys()];
        for (const i of order) {
          const j = i + 1;
          if (i === held || j === held) continue;
          const dx = cx(j) - cx(i), dy = cy(j) - cy(i), dist = Math.hypot(dx, dy);
          if (dist > 2 * r + 1e-4) continue;
          const nx = dx / dist, ny = dy / dist;
          const ti = Math.cos(th[i]) * nx - Math.sin(th[i]) * ny;         // tangent of ball i along the contact normal
          const tj = Math.cos(th[j]) * nx - Math.sin(th[j]) * ny;
          const vn = L * om[j] * tj - L * om[i] * ti;                      // relative normal velocity (j relative to i)
          if (vn < -1e-9) {
            const J = -(1 + e) * vn / (ti * ti + tj * tj);                 // impulse along the normal, constrained by the strings
            om[i] += -J * ti / L;
            om[j] += J * tj / L;
            any = true;
          }
          const overlap = 2 * r - dist;                                    // keep touching balls from sinking into each other
          if (overlap > 0 && Math.abs(ti) > .2 && Math.abs(tj) > .2) { th[i] -= overlap / (2 * L * ti); th[j] += overlap / (2 * L * tj); }
        }
        if (!any) break;
      }
    }

    return {
      n, L, r, e, theta: th, omega: om,
      /* advance by wall-clock seconds; a fixed step, so the result does not depend on frame rate */
      advance(seconds) { acc += Math.min(seconds, 1 / 20); while (acc >= dt) { integrate(); collide(); acc -= dt; } },
      step(count) { for (let k = 0; k < (count || 1); k++) { integrate(); collide(); } },
      lift(i, angle) { th[i] = angle; om[i] = 0; },
      hold(i, angle) { held = i; th[i] = angle; om[i] = 0; },
      release() { held = -1; },
      get held() { return held; },
      reset() { th.fill(0); om.fill(0); held = -1; acc = 0; },
      energy() { let ke = 0, pe = 0; for (let i = 0; i < n; i++) { ke += 0.5 * (L * om[i]) ** 2; pe += G * L * (1 - Math.cos(th[i])); } return { ke, pe, total: ke + pe }; },
      momentumX() { let p = 0; for (let i = 0; i < n; i++) p += L * om[i] * Math.cos(th[i]); return p; },
      atRest(eps) { const E = this.energy().total; return held < 0 && E < (eps || 2e-4); },
      center: i => ({ x: cx(i), y: cy(i) }),
      pivotX
    };
  }
  return { create, G };
});
