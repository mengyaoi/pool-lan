/**
 * render.js — Canvas 2D 渲染（天天台球风格：木框 + 绿绒 + 高光球 + 虚线辅助线 + 球杆）
 * 唯一做「米 → 像素」换算的地方，physics 永远不碰像素。
 */
import { R, TW, TH, HX, HY, POCKETS, BALL_COLORS } from './physics.js';

const RAIL = 0.115;                 // 木框世界宽度（米）
const OUTER_W = TW + RAIL * 2;
const OUTER_H = TH + RAIL * 2;
const SPR = 56;                     // 球贴图半径（像素）
const SPS = 128;                    // 球贴图边长
const SPRITE_K = SPS / (2 * SPR);   // 贴图与真实直径的比例

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1, cssW = 0, cssH = 0, scale = 1, cx = 0, cy = 0;
  let staticLayer = null;
  const sprites = new Map();

  /* ---------------- 坐标 ---------------- */
  const sx = (x) => cx + x * scale;
  const sy = (y) => cy - y * scale;          // 物理 y 向上 → 屏幕 y 向下

  function screenToWorld(px, py) {
    return { x: (px - cx) / scale, y: -(py - cy) / scale };
  }
  function worldToScreen(x, y) {
    return { x: cx + x * scale, y: cy - y * scale };
  }

  /* ---------------- 球贴图 ---------------- */
  function getSprite(id) {
    if (sprites.has(id)) return sprites.get(id);
    const c = document.createElement('canvas');
    c.width = c.height = SPS;
    const g = c.getContext('2d');
    const m = SPS / 2;
    const base = BALL_COLORS[id] || '#999';
    const striped = id >= 9 && id <= 15;

    g.save();
    g.beginPath(); g.arc(m, m, SPR, 0, Math.PI * 2); g.clip();

    if (striped) {
      g.fillStyle = '#f7f4e8'; g.fillRect(0, 0, SPS, SPS);
      g.fillStyle = base; g.fillRect(0, m - SPR * 0.56, SPS, SPR * 1.12);
    } else {
      g.fillStyle = base; g.fillRect(0, 0, SPS, SPS);
    }

    // 球面明暗：模拟球体受光
    const shade = g.createRadialGradient(m - SPR * 0.36, m - SPR * 0.42, SPR * 0.04, m, m, SPR * 1.04);
    shade.addColorStop(0, 'rgba(255,255,255,0.80)');
    shade.addColorStop(0.26, 'rgba(255,255,255,0.20)');
    shade.addColorStop(0.62, 'rgba(0,0,0,0.05)');
    shade.addColorStop(0.88, 'rgba(0,0,0,0.34)');
    shade.addColorStop(1, 'rgba(0,0,0,0.62)');
    g.fillStyle = shade; g.fillRect(0, 0, SPS, SPS);

    // 号码白圈
    if (id > 0) {
      g.beginPath(); g.arc(m, m, SPR * 0.52, 0, Math.PI * 2);
      g.fillStyle = '#fcfbf6'; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = '#191919';
      // 号码是手机端辨认球组的主要线索，尽量占满白圈。
      g.font = `900 ${Math.round(SPR * 0.73)}px Arial, "Arial Black", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(id), m, m + SPR * 0.04);
    }
    g.restore();

    // 轮廓
    g.beginPath(); g.arc(m, m, SPR - 1, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(0,0,0,0.58)'; g.lineWidth = 2.4; g.stroke();

    // 顶部高光 + 边缘光
    g.save();
    g.beginPath(); g.arc(m, m, SPR - 1, 0, Math.PI * 2); g.clip();
    const hl = g.createRadialGradient(m - SPR * 0.40, m - SPR * 0.46, 0, m - SPR * 0.40, m - SPR * 0.46, SPR * 0.52);
    hl.addColorStop(0, 'rgba(255,255,255,0.94)');
    hl.addColorStop(0.55, 'rgba(255,255,255,0.22)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl; g.fillRect(0, 0, SPS, SPS);
    // 底部反光
    const rl = g.createRadialGradient(m + SPR * 0.30, m + SPR * 0.52, 0, m + SPR * 0.30, m + SPR * 0.52, SPR * 0.42);
    rl.addColorStop(0, 'rgba(255,255,255,0.18)');
    rl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rl; g.fillRect(0, 0, SPS, SPS);
    // 左上边缘光（让球从绒面上「浮」起来）
    const rim = g.createRadialGradient(m, m, SPR * 0.80, m, m, SPR);
    rim.addColorStop(0, 'rgba(255,255,255,0)');
    rim.addColorStop(1, 'rgba(255,255,255,0.14)');
    g.fillStyle = rim; g.fillRect(0, 0, SPS, SPS);
    g.restore();

    sprites.set(id, c);
    return c;
  }

  /* ---------------- 静态桌面（缓存） ---------------- */
  function buildStatic() {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const L = sx(-TW / 2), T = sy(TH / 2), W = TW * scale, H = TH * scale;
    const ox = sx(-OUTER_W / 2), oy = sy(OUTER_H / 2);
    const oW = OUTER_W * scale, oH = OUTER_H * scale;
    const rad = Math.min(oW, oH) * 0.055;

    /* --- 外框木质 --- */
    // 桌面投影（让整张桌子从背景里浮出来）
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.75)';
    g.shadowBlur = 34;
    g.shadowOffsetY = 14;
    g.fillStyle = '#1a0f06';
    roundRect(g, ox, oy, oW, oH, rad);
    g.fill();
    g.restore();

    g.save();
    roundRect(g, ox, oy, oW, oH, rad);
    const wood = g.createLinearGradient(ox, oy, ox + oW * 0.6, oy + oH);
    wood.addColorStop(0, '#7a5330');
    wood.addColorStop(0.25, '#5d3c20');
    wood.addColorStop(0.55, '#4a2e17');
    wood.addColorStop(1, '#2c1a0c');
    g.fillStyle = wood; g.fill();
    g.clip();

    // 木纹
    g.globalAlpha = 0.13;
    for (let i = 0; i < 70; i++) {
      const yy = oy + Math.random() * oH;
      g.beginPath();
      g.moveTo(ox - 10, yy);
      let px = ox - 10, py = yy;
      while (px < ox + oW + 10) {
        px += 40 + Math.random() * 70;
        py += (Math.random() - 0.5) * 5;
        g.lineTo(px, py);
      }
      g.strokeStyle = Math.random() > 0.5 ? '#c69a63' : '#1b0f06';
      g.lineWidth = 0.6 + Math.random() * 1.4;
      g.stroke();
    }
    g.globalAlpha = 1;

    // 外框高光边
    g.strokeStyle = 'rgba(255,214,160,0.18)';
    g.lineWidth = 2;
    roundRect(g, ox + 1.5, oy + 1.5, oW - 3, oH - 3, rad);
    g.stroke();
    g.restore();

    /* --- 内框阴影（木框投在绒面上的影子） --- */
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.75)';
    g.shadowBlur = 14 * (scale / 300);
    g.shadowOffsetY = 2;
    g.fillStyle = '#08281a';
    roundRect(g, L - 7, T - 7, W + 14, H + 14, 4);
    g.fill();
    g.restore();

    /* --- 绒面 --- */
    g.save();
    g.beginPath(); g.rect(L, T, W, H); g.clip();
    const felt = g.createRadialGradient(
      L + W / 2, T + H * 0.42, Math.min(W, H) * 0.08,
      L + W / 2, T + H / 2, Math.max(W, H) * 0.78
    );
    felt.addColorStop(0.00, '#219055');
    felt.addColorStop(0.18, '#1d8851');
    felt.addColorStop(0.36, '#187e4a');
    felt.addColorStop(0.54, '#147344');
    felt.addColorStop(0.70, '#10663c');
    felt.addColorStop(0.84, '#0c5a34');
    felt.addColorStop(1.00, '#08471f');
    g.fillStyle = felt; g.fillRect(L, T, W, H);

    // 绒布颗粒（同时充当渐变抖色，压掉大面积渐变的色阶带）
    g.globalAlpha = 0.075;
    for (let i = 0; i < 4600; i++) {
      const x = L + Math.random() * W, y = T + Math.random() * H;
      g.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#001a0d';
      const s = Math.random() > 0.8 ? 1.8 : 1.2;
      g.fillRect(x, y, s, s);
    }
    g.globalAlpha = 1;

    // 斜向反光
    const sheen = g.createLinearGradient(L, T, L + W * 0.55, T + H);
    sheen.addColorStop(0, 'rgba(255,255,255,0.075)');
    sheen.addColorStop(0.35, 'rgba(255,255,255,0.015)');
    sheen.addColorStop(0.62, 'rgba(0,0,0,0.05)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = sheen; g.fillRect(L, T, W, H);

    // 台面内阴影（贴近库边）
    g.globalAlpha = 0.35;
    const topSh = g.createLinearGradient(0, T, 0, T + H * 0.07);
    topSh.addColorStop(0, 'rgba(0,0,0,0.55)'); topSh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = topSh; g.fillRect(L, T, W, H * 0.07);
    const botSh = g.createLinearGradient(0, T + H, 0, T + H * 0.93);
    botSh.addColorStop(0, 'rgba(0,0,0,0.5)'); botSh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = botSh; g.fillRect(L, T + H * 0.93, W, H * 0.07);
    // 左右库边内阴影（让绒面有包裹感）
    const lSh = g.createLinearGradient(L, 0, L + W * 0.045, 0);
    lSh.addColorStop(0, 'rgba(0,0,0,0.42)'); lSh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lSh; g.fillRect(L, T, W * 0.045, H);
    const rSh = g.createLinearGradient(L + W, 0, L + W * 0.955, 0);
    rSh.addColorStop(0, 'rgba(0,0,0,0.42)'); rSh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rSh; g.fillRect(L + W * 0.955, T, W * 0.045, H);
    g.globalAlpha = 1;

    /* --- 开球线 + 开球点（真实球台细节） --- */
    const headX = L + W * 0.25;
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.065)';
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(headX, T); g.lineTo(headX, T + H); g.stroke();
    g.beginPath();
    g.arc(headX, T + H / 2, Math.max(1.6, scale * 0.0042), 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fill();
    g.restore();

    /* --- 台面中央水印徽记 --- */
    g.save();
    g.globalAlpha = 0.033;
    g.translate(L + W / 2, T + H / 2);
    const r0 = H * 0.235;
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1.6, H * 0.010);
    g.beginPath(); g.arc(0, 0, r0, 0, Math.PI * 2); g.stroke();
    g.lineWidth = Math.max(1, H * 0.005);
    g.beginPath(); g.arc(0, 0, r0 * 0.74, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffffff';
    g.font = `bold ${Math.round(r0 * 0.62)}px Arial, "Arial Black", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('8', 0, r0 * 0.04);
    g.restore();
    g.restore();

    /* --- 库边菱形标记 --- */
    g.save();
    const dot = (x, y) => {
      const px = sx(x), py = sy(y), r = Math.max(2.4, scale * 0.0085);
      g.beginPath();
      g.moveTo(px, py - r); g.lineTo(px + r * 0.72, py);
      g.lineTo(px, py + r); g.lineTo(px - r * 0.72, py);
      g.closePath();
      g.fillStyle = 'rgba(248,240,214,0.9)';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 0.6;
      g.stroke();
    };
    for (let i = 1; i < 4; i++) {
      dot(-TW / 2 + (TW * i) / 4, TH / 2 + 0.075);
      dot(-TW / 2 + (TW * i) / 4, -TH / 2 - 0.075);
    }
    for (let i = 1; i < 4; i++) {
      if (i === 2) continue; // 中袋位置跳过
      dot(TW / 2 + 0.075, -TH / 2 + (TH * i) / 4);
      dot(-TW / 2 - 0.075, -TH / 2 + (TH * i) / 4);
    }
    g.restore();

    /* --- 袋口 --- */
    POCKETS.forEach((p) => {
      const px = sx(p.x), py = sy(p.y);
      const pr = Math.max(6, 0.062 * scale);

      // 袋口暗腔
      const pg = g.createRadialGradient(px, py, pr * 0.15, px, py, pr);
      pg.addColorStop(0, '#000000');
      pg.addColorStop(0.66, '#040d08');
      pg.addColorStop(1, 'rgba(6,26,16,0.42)');
      g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2);
      g.fillStyle = pg; g.fill();

      // 铜质包边（有厚度的环，带斜向光影）
      const r1 = pr * 1.0, r2 = pr * 1.22;
      const ringG = g.createLinearGradient(px - r2, py - r2, px + r2, py + r2);
      ringG.addColorStop(0, 'rgba(255,238,196,0.58)');
      ringG.addColorStop(0.48, 'rgba(178,143,88,0.30)');
      ringG.addColorStop(1, 'rgba(54,38,20,0.62)');
      g.beginPath();
      g.arc(px, py, r2, 0, Math.PI * 2);
      g.arc(px, py, r1, 0, Math.PI * 2, true);
      g.fillStyle = ringG; g.fill();

      // 环内侧投影（让袋看起来是凹进去的）
      g.beginPath();
      g.arc(px, py - pr * 0.06, pr * 0.96, Math.PI * 0.12, Math.PI * 0.88);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = Math.max(1.4, pr * 0.12);
      g.stroke();

      // 环外侧高光
      g.beginPath();
      g.arc(px, py + pr * 0.05, pr * 1.14, Math.PI * 1.15, Math.PI * 1.85);
      g.strokeStyle = 'rgba(255,240,205,0.30)';
      g.lineWidth = Math.max(1, pr * 0.07);
      g.stroke();
    });

    return c;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  /* ---------------- 背景 ---------------- */
  function drawBackdrop() {
    const bg = ctx.createRadialGradient(cssW * 0.5, cssH * 0.42, 0, cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.82);
    bg.addColorStop(0, '#12211a');
    bg.addColorStop(0.55, '#0a1511');
    bg.addColorStop(1, '#050a08');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  /* ---------------- 球 ---------------- */
  function drawBalls(balls) {
    if (!balls) return;
    const d = 2 * R * scale;

    // 先画全部阴影
    for (const b of balls) {
      if (b.potted) continue;
      const px = sx(b.x), py = sy(b.y);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(px + d * 0.10, py + d * 0.16, d * 0.52, d * 0.40, 0, 0, Math.PI * 2);
      const sh = ctx.createRadialGradient(px + d * 0.1, py + d * 0.16, 0, px + d * 0.1, py + d * 0.16, d * 0.55);
      sh.addColorStop(0, 'rgba(0,0,0,0.42)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh; ctx.fill();
      ctx.restore();
    }

    const size = d * SPRITE_K;
    for (const b of balls) {
      if (b.potted) continue;
      const px = sx(b.x), py = sy(b.y);
      const img = getSprite(b.id);
      if (b.alpha != null) ctx.globalAlpha = b.alpha;
      ctx.drawImage(img, px - size / 2, py - size / 2, size, size);
      if (b.alpha != null) ctx.globalAlpha = 1;
    }
  }

  /* ---------------- 自由球摆放提示 ---------------- */
  // 说明：深绿台面上细描边几乎看不见，这里统一用「实心盘 + 粗环 + 发光」三层叠加
  function drawPlaceHint(h) {
    const px = sx(h.x), py = sy(h.y);
    const ok = !!h.ok;
    const r = R * scale;
    const rgb = ok ? '53,224,140' : '239,91,82';

    ctx.save();

    // 1) 落地光斑：让幽灵球看起来"悬"在台面上
    const glow = ctx.createRadialGradient(px, py, 0, px, py, r * 2.7);
    glow.addColorStop(0, `rgba(${rgb},0.22)`);
    glow.addColorStop(0.62, `rgba(${rgb},0.08)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.beginPath();
    ctx.arc(px, py, r * 2.7, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    // 2) 外圈虚线范围环（粗 + 发光）
    ctx.beginPath();
    ctx.arc(px, py, r * 2.5, 0, Math.PI * 2);
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = Math.max(2, scale * 0.0058);
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${rgb},0.95)`;
    ctx.shadowColor = `rgba(${rgb},0.9)`;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // 3) 内圈实线：标出球位本身
    ctx.beginPath();
    ctx.arc(px, py, r * 1.2, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.8, scale * 0.0036);
    ctx.strokeStyle = `rgba(${rgb},1)`;
    ctx.stroke();

    // 4) 十字准心
    const arm = r * 3.2;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = Math.max(1.6, scale * 0.0032);
    ctx.beginPath();
    ctx.moveTo(px - arm, py); ctx.lineTo(px - r * 1.55, py);
    ctx.moveTo(px + r * 1.55, py); ctx.lineTo(px + arm, py);
    ctx.moveTo(px, py - arm); ctx.lineTo(px, py - r * 1.55);
    ctx.moveTo(px, py + r * 1.55); ctx.lineTo(px, py + arm);
    ctx.stroke();

    // 5) 不合法：禁止符盖在上面
    if (!ok) {
      const rr = r * 1.65;
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(2.2, scale * 0.0052);
      ctx.strokeStyle = `rgba(${rgb},1)`;
      ctx.shadowColor = `rgba(${rgb},0.95)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.moveTo(px - rr * 0.68, py - rr * 0.68);
      ctx.lineTo(px + rr * 0.68, py + rr * 0.68);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* 自由球「待摆放」：母球脉冲环 + 四向箭头，告诉玩家这颗球能抓起来拖 */
  function drawGrabHint(ball, now) {
    const px = sx(ball.x), py = sy(ball.y);
    const r = R * scale;
    const pulse = (Math.sin(now / 360) + 1) / 2;          // 0..1
    const rad = r * (1.85 + pulse * 0.9);
    const alpha = 0.9 - pulse * 0.4;

    ctx.save();

    // 光晕底盘
    const glow = ctx.createRadialGradient(px, py, 0, px, py, rad * 1.5);
    glow.addColorStop(0, `rgba(255,214,102,${0.16 - pulse * 0.06})`);
    glow.addColorStop(1, 'rgba(255,214,102,0)');
    ctx.beginPath();
    ctx.arc(px, py, rad * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    // 脉冲环
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, scale * 0.0046);
    ctx.strokeStyle = `rgba(255,214,102,${alpha})`;
    ctx.shadowColor = 'rgba(255,205,80,0.9)';
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 四向箭头
    const inner = rad + r * 0.35;
    const outer = rad + r * 1.15;
    const wing = r * 0.5;
    ctx.lineWidth = Math.max(1.8, scale * 0.0038);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(255,230,160,${0.95 - pulse * 0.3})`;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x0 = px + dx * inner, y0 = py + dy * inner;
      const x1 = px + dx * outer, y1 = py + dy * outer;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      // 箭头翼：沿 -(方向) 退一点，再向两侧垂直张开
      const bx = x1 - dx * wing, by = y1 - dy * wing;
      const vx = -dy, vy = dx;                        // 垂直单位向量
      ctx.moveTo(bx + vx * wing, by + vy * wing);
      ctx.lineTo(x1, y1);
      ctx.lineTo(bx - vx * wing, by - vy * wing);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 瞄准辅助 ---------------- */
  function drawAimLine(cuePos, pred, alpha) {
    const from = { x: sx(cuePos.x), y: sy(cuePos.y) };
    const to = { x: sx(pred.hit.x), y: sy(pred.hit.y) };

    ctx.save();
    ctx.setLineDash([9, 7]);
    ctx.lineWidth = Math.max(1.4, scale * 0.0038);
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.shadowColor = `rgba(255,255,255,${alpha * 0.8})`;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (pred.ghost) {
      // 幽灵球：半透明填充 + 实线轮廓，一眼能看出母球该停在哪
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(to.x, to.y, R * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.20})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.95, alpha * 1.7)})`;
      ctx.lineWidth = Math.max(1.6, scale * 0.0042);
      ctx.stroke();

      // 目标球去向
      if (pred.targetPos) {
        const tp = { x: sx(pred.targetPos.x), y: sy(pred.targetPos.y) };
        const dx = tp.x - to.x, dy = tp.y - to.y;
        const len = Math.hypot(dx, dy) || 1;
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.moveTo(tp.x, tp.y);
        ctx.lineTo(tp.x + (dx / len) * R * scale * 5.5, tp.y + (dy / len) * R * scale * 5.5);
        ctx.strokeStyle = `rgba(255,225,120,${Math.min(0.85, alpha * 1.4)})`;
        ctx.lineWidth = Math.max(1.4, scale * 0.0034);
        ctx.stroke();
      }
    } else if (pred.bounce) {
      // 一次库边反弹
      const bp = { x: sx(pred.bounce.x), y: sy(pred.bounce.y) };
      const target = { x: bp.x + pred.bounce.dir.x * R * scale * 14, y: bp.y - pred.bounce.dir.y * R * scale * 14 };
      ctx.setLineDash([5, 9]);
      ctx.beginPath();
      ctx.moveTo(bp.x, bp.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.45})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 对手瞄准射线 ---------------- */
  /** 被选中的目标球：给一个脉冲高亮环，点完能确认到底对准了哪颗 */
  function drawTargetRing(balls, id, nowMs) {
    const b = balls && balls.find((x) => x.id === id && !x.potted);
    if (!b) return;
    const px = sx(b.x), py = sy(b.y);
    const t = ((nowMs != null ? nowMs : performance.now()) % 1200) / 1200;
    const grow = 1 + t * 0.45;
    const alpha = 0.85 * (1 - t);

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, R * scale * 1.35 * grow, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,225,120,${alpha})`;
    ctx.lineWidth = Math.max(2, scale * 0.005);
    ctx.shadowColor = 'rgba(255,214,90,0.9)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, R * scale * 1.22, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,225,120,0.85)';
    ctx.lineWidth = Math.max(1.6, scale * 0.0036);
    ctx.stroke();
    ctx.restore();
  }

  function drawOpponentRay(cuePos, angle) {
    if (!Number.isFinite(angle)) return;
    const px = sx(cuePos.x), py = sy(cuePos.y);
    const len = R * scale * 34;
    ctx.save();
    ctx.setLineDash([7, 9]);
    ctx.lineWidth = Math.max(1.2, scale * 0.003);
    ctx.strokeStyle = 'rgba(232,196,106,0.30)';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(angle) * len, py - Math.sin(angle) * len);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- 球杆 ---------------- */
  function drawCue(cuePos, angle, power) {
    const px = sx(cuePos.x), py = sy(cuePos.y);
    const pull = (0.045 + power * 0.24) + R;      // 杆头到球心距离（米）
    const len = 0.86;                             // 杆长（米）：够长有分量，又不会甩到画面外
    const wTip = Math.max(4.4, scale * 0.012);
    const wButt = wTip * 2.2;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-angle);        // 屏幕 y 向下 → 取反

    const xTip = -pull * scale;
    const xButt = xTip - len * scale;
    const xJoint = xTip - len * scale * 0.55;

    // 投影
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 6;

    // 后节（深木）
    ctx.beginPath();
    ctx.moveTo(xJoint, -wTip * 1.7);
    ctx.lineTo(xButt, -wButt);
    ctx.lineTo(xButt, wButt);
    ctx.lineTo(xJoint, wTip * 1.7);
    ctx.closePath();
    const butt = ctx.createLinearGradient(xButt, -wButt, xButt, wButt);
    butt.addColorStop(0, '#241408');
    butt.addColorStop(0.26, '#6b4526');
    butt.addColorStop(0.45, '#b98a55');
    butt.addColorStop(0.62, '#7c5230');
    butt.addColorStop(1, '#1d0f05');
    ctx.fillStyle = butt;
    ctx.fill();
    ctx.restore();

    // 前节（浅木）
    ctx.beginPath();
    ctx.moveTo(xTip, -wTip);
    ctx.lineTo(xJoint, -wTip * 1.7);
    ctx.lineTo(xJoint, wTip * 1.7);
    ctx.lineTo(xTip, wTip);
    ctx.closePath();
    const shaft = ctx.createLinearGradient(xTip, -wTip, xTip, wTip);
    shaft.addColorStop(0, '#6a4a26');
    shaft.addColorStop(0.3, '#dcc094');
    shaft.addColorStop(0.48, '#fbf0dc');
    shaft.addColorStop(0.68, '#cbab7d');
    shaft.addColorStop(1, '#4a3117');
    ctx.fillStyle = shaft;
    ctx.fill();

    // 杆身一线高光，更有质感
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(1, wTip * 0.5);
    ctx.beginPath();
    ctx.moveTo(xTip, -wTip * 0.32);
    ctx.lineTo(xJoint, -wTip * 0.95);
    ctx.stroke();

    // 接箍
    ctx.fillStyle = '#dfe6ec';
    ctx.fillRect(xJoint, -wTip * 1.72, Math.max(2, wTip * 0.5), wTip * 3.44);
    // 皮头
    ctx.fillStyle = '#2f6fa8';
    ctx.fillRect(xTip - Math.max(2.5, wTip * 0.55), -wTip, Math.max(2.5, wTip * 0.55), wTip * 2);

    // 握把环纹
    ctx.strokeStyle = 'rgba(0,0,0,0.26)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const x = xButt + (xJoint - xButt) * (i / 4);
      const hw = wButt - ((wButt - wTip * 1.7) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x, -hw);
      ctx.lineTo(x, hw);
      ctx.stroke();
    }

    // 尾部橡胶垫
    ctx.fillStyle = '#15100b';
    ctx.fillRect(xButt, -wButt, Math.max(2.5, wTip * 0.8), wButt * 2);

    ctx.restore();
  }

  /* ---------------- 确定性伪随机（粒子用，避免逐帧抖动） ---------------- */
  function hash1(seed, i) {
    let h = (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** 深色球（黑8/紫/蓝）在绿台面上直接画会糊掉，向白色提亮一档 */
  function liftColor(hex, k = 0.55) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#fff3d8';
    const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const m = v.map((x) => Math.round(x + (255 - x) * k));
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  }

  /* ---------------- 进袋特效：缩球 + 冲击波 + 彩色粒子 ---------------- */
  function drawEffects(effects) {
    if (!effects || !effects.length) return;
    for (const e of effects) {
      const t = e.t;               // 0 → 1（总时长由 net.js 的 FX_LIFE 决定，0.9s）
      if (t >= 1) continue;
      const px = sx(e.x), py = sy(e.y);
      const r = R * scale;
      const seed = e.seed != null ? e.seed : 7919;
      const cueBall = e.id === 0;
      const ballColor = cueBall ? '#ffd66e' : (BALL_COLORS[e.id] || '#f2e8d5');
      const color = liftColor(ballColor, 0.40);   // 提亮后仍保留球色倾向
      const glowColor = liftColor(ballColor, 0.62);

      // 1) 冲击波环：袋口向外扩散（0 → 0.38）
      const shock = Math.min(1, t / 0.38);
      if (shock < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - shock) * 0.9;
        ctx.lineWidth = Math.max(1.4, r * 0.3 * (1 - shock) + 1);
        ctx.strokeStyle = cueBall ? 'rgba(255,214,110,1)' : 'rgba(255,255,255,0.95)';
        ctx.shadowColor = cueBall ? 'rgba(255,190,60,0.9)' : glowColor;
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.arc(px, py, r * (0.45 + shock * 2.8), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 2) 球缩入袋口（0 → 0.34）
      const sink = Math.min(1, t / 0.34);
      if (sink < 1) {
        const d = 2 * r * (1 - sink * 0.92) * SPRITE_K;
        ctx.save();
        ctx.globalAlpha = 1 - sink * sink;
        ctx.drawImage(getSprite(e.id), px - d / 2, py - d / 2, d, d);
        ctx.restore();
      }

      // 3) 粒子喷射：初速方向按球号/袋口确定性打散，带阻尼 + 重力 + 拖尾
      const N = 22;
      const life = 0.78;
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < N; i++) {
        const u = Math.min(1, t / life);
        if (u >= 1) continue;
        const ang = (i / N) * Math.PI * 2 + (hash1(seed, i) - 0.5) * 0.85;
        const spd = r * (3.2 + hash1(seed, i + 64) * 6.0);
        const travel = spd * u * (1 - 0.48 * u);
        const dx = Math.cos(ang) * travel;
        const dy = Math.sin(ang) * travel + r * 7.5 * u * u;  // 屏幕 y 向下 = 重力
        const size = r * (0.17 + hash1(seed, i + 128) * 0.24);
        const alpha = Math.pow(1 - u, 1.1) * 1.0;
        const spark = i % 6 === 0;                            // 每 6 颗一颗亮白火花
        const px2 = px + dx, py2 = py + dy;

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = spark ? '#ffffff' : color;
        ctx.shadowColor = spark ? '#ffffff' : glowColor;
        ctx.shadowBlur = spark ? 12 : 7;
        ctx.lineWidth = size;
        // 拖尾：沿运动方向拉一小段
        ctx.beginPath();
        ctx.moveTo(px2 - Math.cos(ang) * size * 2.2, py2 - Math.sin(ang) * size * 2.2);
        ctx.lineTo(px2, py2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* ---------------- 胜利彩带（独立全屏层） ----------------
     必须画在 overlay 遮罩(z-index:40)之上，否则半透明黑底会把彩带压暗。 */
  const CONFETTI_LIFE = 5.2;       // 秒
  const CONFETTI_COLORS = [
    '#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f78c6b',
    '#ffffff', '#c77dff', '#ff8fa3', '#90e0a0',
  ];
  let confetti = [];
  let confettiStart = 0;
  let fxCanvas = null, fxCtx = null;

  function ensureFxLayer() {
    if (fxCtx) return;
    fxCanvas = document.createElement('canvas');
    fxCanvas.setAttribute('aria-hidden', 'true');
    fxCanvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:50';
    document.body.appendChild(fxCanvas);
    fxCtx = fxCanvas.getContext('2d');
    resizeFxLayer();
  }

  function resizeFxLayer() {
    if (!fxCanvas) return;
    const d = Math.min(2, window.devicePixelRatio || 1);
    fxCanvas.width = Math.round(window.innerWidth * d);
    fxCanvas.height = Math.round(window.innerHeight * d);
    fxCtx.setTransform(d, 0, 0, d, 0, 0);
  }

  /** winner 为 null 时清空（重开一局用） */
  function celebrate(winner) {
    if (winner == null) {
      confetti = []; confettiStart = 0;
      if (fxCtx) fxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      return;
    }
    ensureFxLayer();
    const drawGame = winner === 'draw';
    const n = drawGame ? 55 : 170;
    confetti = [];
    for (let i = 0; i < n; i++) {
      confetti.push({
        x: Math.random(),
        y0: -0.05 - Math.random() * 1.1,
        w: 4 + Math.random() * 8,
        h: 9 + Math.random() * 15,
        vy: 0.11 + Math.random() * 0.17,       // 归一化屏高 / 秒
        sway: 0.02 + Math.random() * 0.06,
        phase: Math.random() * Math.PI * 2,
        spin: (Math.random() * 2 - 1) * 7,
        tilt: Math.random() * Math.PI,
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        delay: Math.random() * (drawGame ? 0.6 : 1.4),
      });
    }
    confettiStart = performance.now();
  }

  function drawConfetti(now) {
    if (!fxCtx) return;
    const W = window.innerWidth, H = window.innerHeight;
    fxCtx.clearRect(0, 0, W, H);
    if (!confettiStart || !confetti.length) return;
    const age = (now - confettiStart) / 1000;
    if (age > CONFETTI_LIFE) { confetti = []; confettiStart = 0; return; }
    const fade = Math.min(1, (CONFETTI_LIFE - age) / 1.3);
    for (const c of confetti) {
      const a = age - c.delay;
      if (a < 0) continue;
      const y = (c.y0 + c.vy * a) * H;
      if (y > H + 40) continue;
      const x = (c.x + Math.sin(a * 2.1 + c.phase) * c.sway) * W;
      fxCtx.save();
      fxCtx.translate(x, y);
      fxCtx.rotate(c.tilt + c.spin * a);
      fxCtx.globalAlpha = fade;
      fxCtx.fillStyle = c.color;
      // 翻转感：用 cos 压扁纸片宽度
      const squash = 0.28 + 0.72 * Math.abs(Math.cos(a * 3.4 + c.phase));
      fxCtx.fillRect(-c.w * squash / 2, -c.h / 2, c.w * squash, c.h);
      fxCtx.restore();
    }
  }

  /* ---------------- 对外 ---------------- */
  function resize() {
    // 界面被 CSS 旋转 90° 时，外接矩形的宽高是反的，用元素自身尺寸才准
    const rotated = document.body.classList.contains('fake-landscape');
    const rect = rotated
      ? { width: canvas.offsetWidth, height: canvas.offsetHeight }
      : canvas.getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cssW = Math.max(320, rect.width);
    cssH = Math.max(200, rect.height);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 手机横屏 HUD/操作栏是悬浮层，桌边留一点空隙避免被按钮压住。
    // 整桌始终完整入镜：任何方向都用同一个留白系数，绝不裁切袋口。
    const pad = 0.985;
    scale = Math.min(cssW / OUTER_W, cssH / OUTER_H) * pad;
    cx = cssW / 2;
    cy = cssH / 2;
    staticLayer = buildStatic();
    resizeFxLayer();
  }

  function render(state) {
    const now = state.now != null ? state.now : performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    drawBackdrop();
    if (staticLayer) ctx.drawImage(staticLayer, 0, 0, cssW, cssH);

    drawBalls(state.balls);

    // 自由球待摆放：给母球挂一个"抓我"的脉冲环（有 placeHint 时由幽灵球代替）
    if (state.grabHint && !state.placeHint) {
      drawGrabHint(state.grabHint, state.now != null ? state.now : performance.now());
    }
    if (state.placeHint) drawPlaceHint(state.placeHint);

    const cue = state.balls && state.balls.find((b) => b.id === 0 && !b.potted);

    if (state.opponentAim && cue && !state.isMyTurn) {
      drawOpponentRay(cue, state.opponentAim.angle);
    }
    if (state.aim && state.aim.pred && cue) {
      if (state.aim.targetId != null) drawTargetRing(state.balls, state.aim.targetId, state.now);
      drawAimLine(cue, state.aim.pred, 0.55);
      if (state.aim.showCue) drawCue(cue, state.aim.angle, state.aim.power);
    }

    drawEffects(state.effects);
    if (state.magnifier) drawMagnifier(state.magnifier);
    // 彩带画在最上层（DOM overlay 之下、所有 canvas 内容之上）
    drawConfetti(now);
  }

  /* 手指放大镜：把手指附近的画面放大到手指上方，松手即消失。
     只是读 canvas 自己再画一份，不改变任何游戏坐标。 */
  let magCanvas = null;
  function drawMagnifier(m) {
    const R_MAG = Math.max(48, Math.min(64, Math.min(cssW, cssH) * 0.14));
    const zoom = 2.35;
    // 默认在手指上方；靠近顶部时翻到下方，永远不出画面。
    const above = m.y - R_MAG - 26;
    const cy2 = above - R_MAG / 2 >= 4 ? above : m.y + R_MAG + 26;
    const cx2 = Math.max(R_MAG + 6, Math.min(cssW - R_MAG - 6, m.x));

    // 直接截取当前画面（含台面、球、瞄准线），比重新画一遍更真实
    if (!magCanvas) magCanvas = document.createElement('canvas');
    const size = Math.ceil(R_MAG * 2 * dpr);
    if (magCanvas.width !== size) { magCanvas.width = size; magCanvas.height = size; }
    const mg = magCanvas.getContext('2d');
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, size, size);
    const srcHalf = (R_MAG / zoom) * dpr;
    const sx2 = m.tx * dpr - srcHalf;
    const sy2 = m.ty * dpr - srcHalf;
    mg.drawImage(canvas, sx2, sy2, srcHalf * 2, srcHalf * 2, 0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx2, cy2, R_MAG, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(magCanvas, cx2 - R_MAG, cy2 - R_MAG, R_MAG * 2, R_MAG * 2);
    ctx.restore();

    // 镜片边框 + 准星
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx2, cy2, R_MAG, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(53,224,140,0.9)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx2, cy2, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.restore();
  }

  return {
    resize,
    render,
    celebrate,
    screenToWorld,
    worldToScreen,
    get scale() { return scale; },
    get size() { return { w: cssW, h: cssH }; },
  };
}
