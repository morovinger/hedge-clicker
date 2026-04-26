// ── HC_Visit: hybrid auto-collect on friend farms ──
// Drives the game by dispatching synthetic pointer events on the canvas
// (proven to work — see exit-popup capture). Uses HC_Net's success oracle
// (next /proto.html response after click → 0x80 = collect succeeded) to
// distinguish real resource clicks from grass.
//
// Requires user to be inside a friend farm before start(). The "next farm"
// popup confirm + main-farm "Путешествия" entry will be wired once we have
// their canvas coords.

if (window.HC_Visit) {
  console.log('[HC] Visit already installed — reusing.');
} else {
window.HC_Visit = (function() {
  const cap = window.HC_Capture;
  const net = window.HC_Net;
  const canvas = cap.canvas;

  // Static UI button coords (canvas-relative, 1000×700).
  const BTN = {
    home:     { x: 80,  y: 660 }, // "Домой" — bottom-left, returns from friend farm
    voyage:   { x: 765, y: 260 }, // "В путь!" on TRAVELS_HUB
    travels:  { x: 0,   y: 0   }, // "Путешествия" on main farm — TBD
    nextOk:   { x: 0,   y: 0   }, // confirm button on "next farm" popup — TBD
  };

  // Coarse grid covering the playable area, skipping top/bottom UI bands.
  // 9 cols × 5 rows = 45 cells; ~120 px spacing covers most resource sprites.
  const GRID_X = [125, 235, 345, 455, 565, 675, 785, 850, 925];
  const GRID_Y = [180, 285, 390, 495, 595];

  const VCFG = {
    clickWait:        700,   // ms to await /proto.html response after a click
    repeatGap:        450,   // ms between repeat clicks on a confirmed cell
    maxRepeats:       5,     // tap a confirmed cell up to N times
    interCellGap:     200,   // ms between distinct cells
    homeWait:         2500,  // ms after clicking home (popup may appear)
    maxEmptyPasses:   2,     // give up after this many sweeps with zero hits
  };

  let running = false;
  let stats = { passes: 0, hits: 0, attempts: 0, farms: 0, lastResult: null };

  function click(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const o = {
      clientX: rect.left + cx / sx, clientY: rect.top + cy / sy,
      bubbles: true, cancelable: true, view: window,
      button: 0, pointerType: 'mouse', pointerId: 1, isPrimary: true,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new MouseEvent('mousedown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    canvas.dispatchEvent(new MouseEvent('mouseup', o));
    canvas.dispatchEvent(new MouseEvent('click', o));
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Returns 'ok' | 'err' | 'none' — see HC_Net.awaitNextResponse.
  async function probe(x, y) {
    stats.attempts++;
    click(x, y);
    return await net.awaitNextResponse(VCFG.clickWait);
  }

  async function farmPass() {
    let hits = 0;
    for (const y of GRID_Y) {
      for (const x of GRID_X) {
        if (!running) return hits;
        const r = await probe(x, y);
        if (r === 'ok') {
          hits++; stats.hits++; stats.lastResult = 'ok@' + x + ',' + y;
          // Multi-click the same spot — a tree usually needs 3-5 hits
          for (let i = 0; i < VCFG.maxRepeats - 1; i++) {
            if (!running) return hits;
            await sleep(VCFG.repeatGap);
            const r2 = await probe(x, y);
            if (r2 !== 'ok') break;
            hits++; stats.hits++;
          }
        }
        await sleep(VCFG.interCellGap);
      }
    }
    return hits;
  }

  async function loop() {
    let emptyPasses = 0;
    while (running) {
      const hits = await farmPass();
      stats.passes++;
      if (hits === 0) {
        emptyPasses++;
        if (emptyPasses >= VCFG.maxEmptyPasses) {
          console.log('[HC_Visit] No hits for', VCFG.maxEmptyPasses, 'passes — trying home button');
          click(BTN.home.x, BTN.home.y);
          stats.farms++;
          await sleep(VCFG.homeWait);
          // Auto-confirm popup if coords set
          if (BTN.nextOk.x || BTN.nextOk.y) {
            click(BTN.nextOk.x, BTN.nextOk.y);
            await sleep(VCFG.homeWait);
          }
          emptyPasses = 0;
        }
      } else {
        emptyPasses = 0;
      }
    }
  }

  function start() {
    if (running) return;
    if (!net) { console.error('[HC_Visit] HC_Net missing — cannot start'); return; }
    running = true;
    stats = { passes: 0, hits: 0, attempts: 0, farms: 0, lastResult: null };
    console.log('[HC_Visit] START — assumes you are inside a friend farm');
    loop();
  }

  function stop() {
    running = false;
    console.log('[HC_Visit] STOP', stats);
  }

  return {
    start, stop,
    toggle() { running ? stop() : start(); },
    isRunning() { return running; },
    getStats() { return Object.assign({ running }, stats); },
    getButtons() { return BTN; },
    setHomeBtn(x, y)    { BTN.home.x = x; BTN.home.y = y; },
    setVoyageBtn(x, y)  { BTN.voyage.x = x; BTN.voyage.y = y; },
    setNextOkBtn(x, y)  { BTN.nextOk.x = x; BTN.nextOk.y = y; },
    setTravelsBtn(x, y) { BTN.travels.x = x; BTN.travels.y = y; },
    // Manual one-shot helpers for calibration/testing
    probeCell: probe,
    sweepOnce: farmPass,
  };
})();
}
