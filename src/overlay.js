// ── HC_Overlay: canvas overlay for visualizing parsed farm objects ──
// Draws colored dots at projected screen coords using an isometric transform
// from world tile coords. Used to calibrate the world→screen mapping by
// eyeballing whether dots land on visible resources.
//
// Iso projection (standard 2:1):
//   screen_x = (wx - wy) * tw/2 + cx
//   screen_y = (wx + wy) * th/2 + cy
//
// (cx, cy) is the screen position of world (0,0). Without camera/scroll info
// this is set manually by the user. Once aligned, HC_Visit can use the same
// transform to click each parsed object.

if (window.HC_Overlay) {
  console.log('[HC] Overlay already installed — reusing.');
} else {
window.HC_Overlay = (function() {
  const cap = window.HC_Capture;
  const net = window.HC_Net;

  // Default transform — guesses, will be tuned via UI / calibration.
  const T = { tw: 32, th: 16, cx: 500, cy: 350 };

  let overlay = null, ctx2d = null, visible = false;
  let lastObjects = [];
  let dotRadius = 4;

  // Color per type prefix
  const COLORS = {
    te_: '#ff4d4d', // trees — red
    sb_: '#ffd84d', // seedbeds — gold
    pl_: '#4dff66', // plants — green
    pi_: '#a04dff', // ?
    fl_: '#ff9aff', // flowers
  };
  function colorFor(type) {
    for (const k of Object.keys(COLORS)) if (type.indexOf(k) === 0) return COLORS[k];
    return '#888';
  }

  function ensureOverlay() {
    const game = cap && cap.canvas;
    if (!game) return null;
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('canvas');
    overlay.id = 'hc-overlay';
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '99998';
    overlay.style.left = '0px';
    overlay.style.top = '0px';
    document.body.appendChild(overlay);
    ctx2d = overlay.getContext('2d');
    syncRect();
    return overlay;
  }

  function syncRect() {
    if (!overlay) return;
    const game = cap.canvas;
    const r = game.getBoundingClientRect();
    overlay.style.left = (window.scrollX + r.left) + 'px';
    overlay.style.top  = (window.scrollY + r.top)  + 'px';
    overlay.style.width  = r.width  + 'px';
    overlay.style.height = r.height + 'px';
    // Internal resolution = game canvas resolution so toScreen() math is in
    // canvas pixels, matching HC_Visit/HC_DbgClick coordinate space.
    overlay.width  = game.width;
    overlay.height = game.height;
  }

  function toScreen(wx, wy) {
    return {
      x: (wx - wy) * (T.tw / 2) + T.cx,
      y: (wx + wy) * (T.th / 2) + T.cy,
    };
  }

  function redraw() {
    if (!overlay || !ctx2d) return;
    syncRect();
    ctx2d.clearRect(0, 0, overlay.width, overlay.height);
    if (!visible) return;

    // Faint grid for orientation: world (0..maxX) × (0..maxY) lines every 10 tiles
    ctx2d.lineWidth = 1;
    ctx2d.strokeStyle = 'rgba(255,255,255,0.10)';
    let xMax = 0, yMax = 0;
    for (const o of lastObjects) { if (o.x > xMax) xMax = o.x; if (o.y > yMax) yMax = o.y; }
    xMax = Math.max(xMax, 50); yMax = Math.max(yMax, 30);
    for (let g = 0; g <= xMax + 5; g += 10) {
      const a = toScreen(g, 0), b = toScreen(g, yMax);
      ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y); ctx2d.stroke();
    }
    for (let g = 0; g <= yMax + 5; g += 10) {
      const a = toScreen(0, g), b = toScreen(xMax, g);
      ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y); ctx2d.stroke();
    }

    // Origin marker
    const origin = toScreen(0, 0);
    ctx2d.fillStyle = '#fff';
    ctx2d.beginPath(); ctx2d.arc(origin.x, origin.y, 3, 0, 6.283); ctx2d.fill();

    // Object dots
    for (const o of lastObjects) {
      const p = toScreen(o.x, o.y);
      ctx2d.fillStyle = colorFor(o.type);
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, dotRadius, 0, 6.283);
      ctx2d.fill();
    }
  }

  function loadObjects(opts) {
    if (!net) { console.warn('[HC_Overlay] HC_Net missing'); return 0; }
    const r = net.lastFarmObjects(opts || {});
    lastObjects = r.objects || [];
    return lastObjects.length;
  }

  let resizeObs = null;
  function attachWatchers() {
    if (resizeObs) return;
    if (typeof ResizeObserver === 'function' && cap.canvas) {
      resizeObs = new ResizeObserver(redraw);
      resizeObs.observe(cap.canvas);
    }
    window.addEventListener('scroll', redraw, true);
    window.addEventListener('resize', redraw);
  }

  function show(opts) {
    ensureOverlay();
    attachWatchers();
    visible = true;
    if (opts && (opts.tw || opts.th || opts.cx != null || opts.cy != null)) setTransform(opts);
    if (loadObjects(opts) === 0 && opts && opts.objects) lastObjects = opts.objects;
    redraw();
    return { count: lastObjects.length, transform: { ...T } };
  }

  function hide() {
    visible = false;
    if (overlay && ctx2d) ctx2d.clearRect(0, 0, overlay.width, overlay.height);
    return { hidden: true };
  }

  function setTransform(t) {
    if (!t) return T;
    if (typeof t.tw === 'number') T.tw = t.tw;
    if (typeof t.th === 'number') T.th = t.th;
    if (typeof t.cx === 'number') T.cx = t.cx;
    if (typeof t.cy === 'number') T.cy = t.cy;
    redraw();
    return { ...T };
  }

  function getTransform() { return { ...T }; }

  // Solve transform from two known world↔screen pairs. Caller picks two
  // visible objects on screen (one near origin, one far) and supplies their
  // world coords + the screen pixels they actually appear at.
  // Each pair: { wx, wy, sx, sy }.
  function calibrateFromPairs(p1, p2) {
    // System:  sx = (wx-wy)*a + cx     where a = tw/2
    //          sy = (wx+wy)*b + cy     where b = th/2
    const u1 = p1.wx - p1.wy, v1 = p1.wx + p1.wy;
    const u2 = p2.wx - p2.wy, v2 = p2.wx + p2.wy;
    if (u1 === u2 || v1 === v2) {
      console.warn('[HC_Overlay] degenerate calibration pairs (same diag)');
      return null;
    }
    const a = (p1.sx - p2.sx) / (u1 - u2);
    const cx = p1.sx - u1 * a;
    const b = (p1.sy - p2.sy) / (v1 - v2);
    const cy = p1.sy - v1 * b;
    T.tw = a * 2; T.th = b * 2; T.cx = cx; T.cy = cy;
    redraw();
    return { ...T };
  }

  return {
    show, hide, redraw,
    setTransform, getTransform,
    toScreen,
    calibrateFromPairs,
    loadObjects,
    getObjects() { return lastObjects.slice(); },
    isVisible() { return visible; },
  };
})();
}
