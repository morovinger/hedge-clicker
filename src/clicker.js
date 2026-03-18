// ── Click Simulation + Auto-Collect Loops ──

window.HC_Clicker = (function() {
  const cap = window.HC_Capture;
  const vis = window.HC_Vision;
  const cfg = window.HC_CFG;
  const canvas = cap.canvas;

  let running = false;
  let mode = 'smart'; // smart, grid, single
  let detected = [];
  let clicks = 0, scans = 0, found = 0;
  let targetX = 500, targetY = 350;
  let gridIdx = 0;

  function click(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const clientX = rect.left + cx / sx, clientY = rect.top + cy / sy;
    const o = { clientX, clientY, bubbles: true, cancelable: true, view: window };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new MouseEvent('mousedown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    canvas.dispatchEvent(new MouseEvent('mouseup', o));
    canvas.dispatchEvent(new MouseEvent('click', o));
    clicks++;
  }

  // ── Smart Mode: scan + click detections ──
  function smartLoop() {
    if (!running || mode !== 'smart') return;
    cap.requestFrame();
    setTimeout(() => {
      detected = vis.scanFrame(cap.getFrame(), cfg);
      scans++;
      found += detected.length;
      if (window.HC_UI) window.HC_UI.updateInfo(getStats());

      if (detected.length === 0) {
        window.__hcTimer = setTimeout(smartLoop, cfg.scanInterval);
        return;
      }
      console.log('[HC] Smart found', detected.length, 'targets:', detected.map(d => d.name + '(' + d.x + ',' + d.y + ')').join(' '));
      let i = 0;
      function next() {
        if (!running || i >= detected.length) {
          window.__hcTimer = setTimeout(smartLoop, cfg.scanInterval);
          return;
        }
        click(detected[i].x, detected[i].y + 10);
        if (window.HC_UI) window.HC_UI.updateInfo(getStats());
        i++;
        setTimeout(next, cfg.clickDelay);
      }
      next();
    }, 200);
  }

  // ── Grid Mode: dense sweep ──
  function gridLoop() {
    if (!running || mode !== 'grid') return;
    const cols = 12, rows = 9, total = cols * rows;
    if (gridIdx >= total) { gridIdx = 0; window.__hcTimer = setTimeout(gridLoop, 2000); return; }
    const col = gridIdx % cols, row = Math.floor(gridIdx / cols);
    gridIdx++;
    const x = 20 + (col / (cols - 1)) * (canvas.width - 40) + (Math.random() - 0.5) * 15;
    const y = 70 + (row / (rows - 1)) * (canvas.height - 110) + (Math.random() - 0.5) * 15;
    click(x, y);
    if (window.HC_UI) window.HC_UI.updateInfo(getStats());
    window.__hcTimer = setTimeout(gridLoop, 80);
  }

  // ── Single Mode: click one spot ──
  function singleLoop() {
    if (!running || mode !== 'single') return;
    click(targetX, targetY);
    if (window.HC_UI) window.HC_UI.updateInfo(getStats());
    window.__hcTimer = setTimeout(singleLoop, 200);
  }

  function start() {
    if (running) return;
    running = true; gridIdx = 0;
    if (mode === 'smart') smartLoop();
    else if (mode === 'grid') gridLoop();
    else singleLoop();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearTimeout(window.__hcTimer);
  }

  function getStats() {
    return { clicks, scans, found, detected, running, mode };
  }

  return {
    start, stop,
    toggle() { running ? stop() : start(); },
    isRunning() { return running; },
    getMode() { return mode; },
    setMode(m) { if (running) stop(); mode = m; },
    setTarget(x, y) { targetX = x; targetY = y; },
    getStats,
    scanOnce() {
      cap.requestFrame();
      setTimeout(() => {
        detected = vis.scanFrame(cap.getFrame(), cfg);
        scans++;
        found += detected.length;
        console.log('[HC Scan]', detected.length, 'clusters:', detected);
        if (window.HC_UI) {
          window.HC_UI.updateInfo(getStats());
          window.HC_UI.showDetected(detected);
        }
      }, 300);
    },
  };
})();
