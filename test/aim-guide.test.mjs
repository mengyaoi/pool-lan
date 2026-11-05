/**
 * aim-guide.test.mjs — 入袋辅助线几何回归
 *
 * 这里只测「选哪个袋口、幽灵球在哪」，不测物理：辅助线绝不能
 * 把目标球算到不可能进袋的位置，也不能无视挡球。
 */
import { R, POCKETS } from '../public/js/physics.js';
import { bestPocketGuide, pocketGuide } from '../public/js/aim-guide.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// 1. 正对右中袋：幽灵球应在目标球左侧 2R，角度指向幽灵球
{
  const balls = [{ id: 0, x: -0.6, y: 0 }, { id: 1, x: 0.55, y: 0.05 }];
  const g = bestPocketGuide(balls, balls[1]);
  ok(!!g, '能找到一个可用袋口');
  ok(g && Math.abs(g.ghost.x - (0.55 - 2 * R)) < 0.02, `幽灵球贴在目标球后方（x=${g && g.ghost.x.toFixed(3)}）`);
  ok(g && Math.abs(g.angle) < 0.25, `面向袋口时角度接近水平（${g && g.angle.toFixed(3)} rad）`);
}

// 2. 目标球到某袋口被另一颗球完全挡住：应改选没有被挡的袋口
{
  const balls = [
    { id: 0, x: -0.9, y: 0 },
    { id: 1, x: 0.0, y: 0 },
    { id: 9, x: 0.59, y: 0 },   // 正好堵在 1 号 → 右中袋的路上
  ];
  const g = bestPocketGuide(balls, balls[1]);
  ok(!!g, '被挡时仍能找到另一条线路');
  ok(g && !(Math.abs(g.pocket.x - POCKETS[2].x) < 1e-6 && Math.abs(g.pocket.y - POCKETS[2].y) < 1e-6),
    '没有选择被球挡住的那个袋口');
}

// 3. 没有母球 / 球已落袋：不应崩，也不应给路线
{
  ok(pocketGuide([{ id: 1, x: 0, y: 0 }], { id: 1, x: 0, y: 0 }, POCKETS[0]) === null,
    '没有母球时返回 null');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
