/* 浏览器端自动出杆脚本（联调/回归用，通过 agent-browser eval 注入）
   依赖 game.js 暴露的只读句柄 window.__pool */
(function () {
  if (window.__autoTimer) clearInterval(window.__autoTimer);

  const c = document.getElementById('table');
  const stat = { shots: 0, busy: false, last: '' };

  const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: y, pointerId: 7, bubbles: true,
    isPrimary: true, pointerType: 'mouse', button: 0,
    buttons: t === 'pointerup' ? 0 : 1,
  }));

  function shoot() {
    const p = window.__pool;
    const v = p && p.view;
    if (!v || !v.canShoot || v.phase !== 'aim') return;

    const r = c.getBoundingClientRect();
    const cx = r.left + r.width * 0.5;
    const cy = r.top + r.height * 0.5;
    const maxD = Math.max(60, Math.min(r.width, r.height) * 0.42);
    const power = 0.42 + Math.random() * 0.3;

    stat.busy = true;
    // 1) 瞄准：瞄准点放在球堆方向（偏右），微随机抖动
    ev('pointermove', r.left + r.width * 0.86, cy + (Math.random() - 0.5) * r.height * 0.16);

    setTimeout(() => {
      // 2) 按住 → 3) 往拖拉杆 → 4) 松开
      ev('pointerdown', cx, cy);
      setTimeout(() => {
        ev('pointermove', cx, cy + maxD * power);
        setTimeout(() => {
          ev('pointerup', cx, cy + maxD * power);
          stat.shots++;
          stat.last = `power≈${power.toFixed(2)}`;
          setTimeout(() => { stat.busy = false; }, 400);
        }, 50);
      }, 60);
    }, 60);
  }

  window.__autoTimer = setInterval(() => { if (!stat.busy) shoot(); }, 1600);
  window.__autoStat = stat;
  window.__autoStop = () => { clearInterval(window.__autoTimer); window.__autoTimer = null; return 'autoplay stopped'; };
  return 'autoplay installed';
})()
