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
    home:     { x: 80,  y: 660 }, // "Выйти" — bottom-left, returns from friend farm
    next:     { x: 0,   y: 0   }, // "Далее" — bottom (right of home), advances to next friend farm. SET via setNextBtn
    voyage:   { x: 765, y: 260 }, // "В путь!" on TRAVELS_HUB
    travels:  { x: 0,   y: 0   }, // "Путешествия" on main farm — TBD
    sessionEndOk: { x: 0, y: 0 }, // confirm on "backpack full" dialog — TBD
  };

  // Dense grid covering the playable area, skipping top/bottom UI bands.
  // 14 cols × 9 rows = 126 cells; ~70px spacing — small enough to hit
  // most resource sprites which appear ~50-90px wide.
  const GRID_X = [];
  const GRID_Y = [];
  for (let x = 80; x <= 940; x += 70) GRID_X.push(x);  // 14 cols
  for (let y = 130; y <= 620; y += 70) GRID_Y.push(y); // 9 rows

  const VCFG = {
    clickGap:         300,   // ms between blind clicks during a sweep (no per-cell await)
    settleAfterSweep: 1800,  // ms to wait after sweep for last responses to arrive
    advanceWait:      2500,  // ms after clicking "Далее"/"Выйти" for next farm to load
    maxSweepsPerFarm: 4,     // bound how many full passes we do per farm
    // Threshold: net.totalOk delta from one sweep that counts as "real
    // collection". Below this, we treat the sweep as failed (probably just
    // background polls) and advance to the next farm. Tuned for ~38s sweep
    // time during which the game emits maybe 1-2 unrelated polls.
    minOkPerSweep:    3,
  };

  let running = false;
  let stats = { passes: 0, hits: 0, attempts: 0, farms: 0, lastResult: null, hitCoords: [] };

  function click(cx, cy) {
    // Prefer chrome.debugger backend (trusted events). Falls back to
    // synthetic dispatch only if the extension bridge isn't installed
    // — synthetic clicks are silently dropped by PIXI on this game.
    const rect = canvas.getBoundingClientRect();
    if (window.HC_DbgClick) {
      // Canvas sits at iframe origin and is 1:1 with viewport (verified:
      // rectL=0, rectT=0, rectW=canvas.width). If that ever changes,
      // translate here.
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      const vx = rect.left + cx / sx;
      const vy = rect.top + cy / sy;
      window.HC_DbgClick.click(vx, vy);
      return;
    }
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

  // Blind sweep: fire all 126 cells with `clickGap` between each. No per-cell
  // oracle wait — instead we measure net.totalOk delta after the sweep
  // settles. The raw clicks themselves are reliable; only our per-cell
  // timing window was flaky.
  // forStop: honor running flag for early termination (true for loop,
  // false for one-off sweepOnce).
  async function farmPass(forStop) {
    const okBefore = net.getStats().totalOk;
    for (const y of GRID_Y) {
      for (const x of GRID_X) {
        if (forStop && !running) break;
        click(x, y);
        stats.attempts++;
        await sleep(VCFG.clickGap);
      }
      if (forStop && !running) break;
    }
    // Let final responses arrive
    await sleep(VCFG.settleAfterSweep);
    const okAfter = net.getStats().totalOk;
    const gained = okAfter - okBefore;
    stats.hits += gained;
    stats.lastResult = 'sweep+' + gained;
    return gained;
  }

  async function loop() {
    let sweepsThisFarm = 0;
    while (running) {
      const gained = await farmPass(true);
      stats.passes++;
      sweepsThisFarm++;
      console.log('[HC_Visit] Sweep', sweepsThisFarm, '→ net oks gained:', gained);
      // Advance if: didn't collect enough OR hit per-farm cap
      if (gained < VCFG.minOkPerSweep || sweepsThisFarm >= VCFG.maxSweepsPerFarm) {
        console.log('[HC_Visit] Advancing farm — total sweeps:', sweepsThisFarm);
        const target = (BTN.next.x || BTN.next.y) ? BTN.next : BTN.home;
        click(target.x, target.y);
        stats.farms++;
        await sleep(VCFG.advanceWait);
        sweepsThisFarm = 0;
      }
    }
  }

  function start() {
    if (running) return;
    if (!net) { console.error('[HC_Visit] HC_Net missing — cannot start'); return; }
    running = true;
    stats = { passes: 0, hits: 0, attempts: 0, farms: 0, lastResult: null, hitCoords: [] };
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
    setHomeBtn(x, y)         { BTN.home.x = x; BTN.home.y = y; },
    setNextBtn(x, y)         { BTN.next.x = x; BTN.next.y = y; },
    setVoyageBtn(x, y)       { BTN.voyage.x = x; BTN.voyage.y = y; },
    setTravelsBtn(x, y)      { BTN.travels.x = x; BTN.travels.y = y; },
    setSessionEndOkBtn(x, y) { BTN.sessionEndOk.x = x; BTN.sessionEndOk.y = y; },
    // Manual one-shot helper for calibration/testing
    sweepOnce: farmPass,
  };
})();
}
