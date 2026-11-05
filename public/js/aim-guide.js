import { R, POCKETS } from './physics.js';

// 目标球到袋口：需要把母球打到「幽灵球」位置，使目标球沿袋口方向前进。
export function pocketGuide(balls, target, pocket) {
  const dx = pocket.x - target.x;
  const dy = pocket.y - target.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 1e-6)) return null;
  const ux = dx / dist, uy = dy / dist;
  // 目标球被撞后沿 u 前进；母球撞点必须在目标球「后方」2R 处
  const ghost = { x: target.x - ux * 2 * R, y: target.y - uy * 2 * R };
  const cue = balls.find((b) => b.id === 0 && !b.potted);
  if (!cue) return null;
  return {
    pocket,
    ghost,
    target,
    angle: Math.atan2(ghost.y - cue.y, ghost.x - cue.x),
    dist,
    targetDist: Math.hypot(ghost.x - cue.x, ghost.y - cue.y),
  };
}

function blocked(balls, from, to, ignore) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return false;
  const ux = dx / len, uy = dy / len;
  for (const b of balls) {
    if (b.potted || ignore.includes(b.id)) continue;
    const ox = b.x - from.x, oy = b.y - from.y;
    const proj = ox * ux + oy * uy;
    if (proj <= 0 || proj >= len) continue;
    const perp = Math.abs(ox * uy - oy * ux);
    if (perp < 2 * R * 0.98) return true;
  }
  return false;
}

/** 最近、且两条线段都没有球挡住的袋口 */
export function bestPocketGuide(balls, target) {
  let best = null;
  const cue = balls.find((b) => b.id === 0 && !b.potted);
  if (!cue) return null;
  for (const pocket of POCKETS) {
    const g = pocketGuide(balls, target, pocket);
    if (!g) continue;
    if (blocked(balls, cue, g.ghost, [0, target.id])) continue;
    if (blocked(balls, target, pocket, [0, target.id])) continue;
    // 优先短路径，袋口方向太贴库也会被上面的遮挡过滤掉
    g.score = g.targetDist + g.dist * 0.35;
    if (!best || g.score < best.score) best = g;
  }
  return best;
}
