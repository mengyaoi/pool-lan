/**
 * pro-aid.test.mjs - pro mode aid regression
 *
 * Requirement: keep the cue-ball-to-first-contact aim line,
 * but hide post-contact prediction (ghost ball, object path, cushion bounce).
 */
import { createWorld, addBall, predictAim } from '../public/js/physics.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

function fakeCtx() {
  const calls = [];
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'canvas') return { width: 800, height: 500 };
      return (...args) => { calls.push({ name: String(k), args }); };
    },
    set() { return true; },
  });
  return { ctx, calls };
}

globalThis.document = {
  body: { classList: { contains: () => false, toggle() {} } },
  createElement: () => {
    const { ctx } = fakeCtx();
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
globalThis.window = { innerWidth: 800, innerHeight: 500, devicePixelRatio: 1 };
const { createRenderer } = await import('../public/js/render.js');

function fakeCanvas(w = 800, h = 500) {
  const { ctx, calls } = fakeCtx();
  return {
    width: w, height: h, offsetWidth: w, offsetHeight: h,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h }),
    calls,
  };
}

function draw(balls, angle, pred, pro, targetId = null) {
  const canvas = fakeCanvas();
  const r = createRenderer(canvas);
  r.resize();
  canvas.calls.length = 0;
  r.render({
    balls,
    aim: { angle, power: 0.3, spin: { a: 0, b: 0 }, pred, guide: null, showCue: true, pro, targetId },
    effects: [], now: 1000,
  });
  const n = (name) => canvas.calls.filter((c) => c.name === name).length;
  return { lineTo: n('lineTo'), arc: n('arc'), stroke: n('stroke') };
}

const world = createWorld();
addBall(world, { id: 0, x: -0.6, y: 0 });
addBall(world, { id: 1, x: 0.45, y: 0 });
const pred = predictAim(world, 0);
ok(!!pred && !!pred.hit, 'predictAim gives first contact');
ok(!!pred && !!pred.ghost, 'normal mode has ghost ball');

const base = draw(world.balls, 0, null, false);
const normal = draw(world.balls, 0, pred, false);
const pro = draw(world.balls, 0, pred, true);
ok(pro.lineTo > base.lineTo, 'pro mode still draws the front aim line: ' + base.lineTo + ' -> ' + pro.lineTo);
ok(pro.lineTo < normal.lineTo, 'pro mode drops follow-up lines: ' + pro.lineTo + ' < ' + normal.lineTo);
ok(pro.arc === base.arc, 'pro mode drops ghost circle: ' + pro.arc + ' == ' + base.arc);

const ringNormal = draw(world.balls, 0, pred, false, 1);
const ringPro = draw(world.balls, 0, pred, true, 1);
ok(ringPro.arc === base.arc, 'pro mode drops target ring: ' + ringPro.arc + ' == ' + base.arc);
ok(ringNormal.arc > ringPro.arc, 'normal mode still shows target ring');

const empty = createWorld();
addBall(empty, { id: 0, x: -1.0, y: 0.9 });
const wallPred = predictAim(empty, -Math.PI / 2);
ok(wallPred && wallPred.cushion === true, 'aim at empty table hits cushion');
ok(!!wallPred.bounce, 'normal mode has bounce prediction');

const wallBase = draw(empty.balls, -Math.PI / 2, null, false);
const wallNormal = draw(empty.balls, -Math.PI / 2, wallPred, false);
const wallPro = draw(empty.balls, -Math.PI / 2, wallPred, true);
ok(wallPro.lineTo > wallBase.lineTo, 'pro mode still draws the front aim line: ' + wallBase.lineTo + ' -> ' + wallPro.lineTo);
ok(wallPro.lineTo < wallNormal.lineTo, 'pro mode drops bounce line: ' + wallPro.lineTo + ' < ' + wallNormal.lineTo);
ok(normal.lineTo > 1, 'normal mode unchanged');

console.log('\nresult: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
