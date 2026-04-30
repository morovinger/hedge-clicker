// ── HC_Visit: autonomous friend-farm collector ──
// Drives the game by dispatching trusted clicks via HC_DbgClick (the
// extension's chrome.debugger bridge). Uses HC_Net's response stream
// (each /proto.html post → 0x50 0x00 'P\0' = action ok, 0x30 0x00 '0\0' =
// idle tick, 0x00 0x00 = error) as the post-click signal.
//
// Caveat: background tiles also return P\0 on click, so the totalOk delta
// only proves "the click reached the game", not "a resource was collected".
// That's why maxSweepsPerFarm = 1 — there's no clean per-cell early-stop.

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
    next:     { x: 200, y: 660 }, // "Далее" — bottom-left, appears once farm is exhausted
    popupNext:{ x: 500, y: 310 }, // "Далее" inside the centered "nothing more to do" popup
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
    maxSweepsPerFarm: 1,     // one full grid pass per farm, then advance.
                             // Background tiles also return P\0 (ok) so the
                             // gained-oks threshold can't reliably tell an
                             // exhausted farm from a fresh one; just advance.
    minOkPerSweep:    3,     // unused when maxSweepsPerFarm=1, kept for manual override
    hubProbeGap:      400,   // ms between hub farm-icon probe clicks
    hubProbeTimeout:  1500,  // ms to await a farm-load XHR after each probe
    maxHubAttempts:   24,    // bound probes per enterFromHub call
    stopAfterEmptyAdvances: 2, // backpack-full proxy: stop after N advances that produce no new farm-load
    // 'auto' = use parsed list when HC_Net has decoded objects AND the
    // projected coords land inside the canvas; else fall back to grid.
    // 'parsed' = require parsed list (skip farm if missing).
    // 'grid' = always grid (legacy behavior).
    // Default is 'grid' until HC_Overlay exposes a calibrated flag — the
    // current overlay transform is a guess and parsed coords are unreliable.
    sweepMode:        'grid',
    parsedClickGap:   220,   // tighter than grid because we have far fewer clicks
    // Inset around canvas edges to skip projected coords that land in UI
    // bands (top/bottom HUD, side rails).
    edgeInsetX:       40,
    edgeInsetTop:     120,
    edgeInsetBottom:  80,
  };

  let running = false;
  let stats = { passes: 0, hits: 0, attempts: 0, farms: 0, lastResult: null, hitCoords: [] };

  // ── Ring buffer of recent events; UI reads via getLog() ──
  // Logs are also forwarded to window.parent so the top-frame's DevTools
  // console (the "main" tab) shows them — DevTools defaults to the top
  // frame's context and iframe logs are normally hidden behind a context
  // switcher.
  const LOG_MAX = 100;
  const logBuf = [];
  function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    const line = '[' + ts + '] ' + msg;
    logBuf.push(line);
    if (logBuf.length > LOG_MAX) logBuf.shift();
    console.log('[HC_Visit]', msg);
    try { window.parent.postMessage({ type: 'HC_LOG', line: '[HC_Visit] ' + msg }, '*'); } catch (e) {}
  }

  let clickCount = 0, clickFails = 0;

  function click(cx, cy) {
    // Prefer chrome.debugger backend (trusted events). Falls back to
    // synthetic dispatch only if the extension bridge isn't installed
    // — synthetic clicks are silently dropped by PIXI on this game.
    const rect = canvas.getBoundingClientRect();
    if (window.HC_DbgClick) {
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      const vx = rect.left + cx / sx;
      const vy = rect.top + cy / sy;
      clickCount++;
      window.HC_DbgClick.click(vx, vy).then(r => {
        if (r && r.timeout) {
          clickFails++;
          if (clickFails === 1 || clickFails % 20 === 0) {
            log('!! DbgClick TIMEOUT (#' + clickFails + ') — debugger session likely lost');
          }
        }
      });
      return;
    }
    log('!! HC_DbgClick missing — falling back to synthetic events (PIXI may drop them)');
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
  // false for one-off sweepOnce). Returns { ok, resourceItems, withResources }.
  async function farmPass(forStop) {
    const before = net.getStats();
    const seqStart = before.totalSeen ? Math.max(0, before.totalSeen) : 0;
    // Use server time as the "since" cutoff — ring entries carry respAt.
    const cutoffTs = Date.now();
    for (const y of GRID_Y) {
      for (const x of GRID_X) {
        if (forStop && !running) break;
        click(x, y);
        stats.attempts++;
        await sleep(VCFG.clickGap);
      }
      if (forStop && !running) break;
    }
    await sleep(VCFG.settleAfterSweep);
    const after = net.getStats();
    const gained = after.totalOk - before.totalOk;
    // Aggregate the parsed collect responses for *this* sweep window.
    const collect = (net.lastCollectStats && net.lastCollectStats({ sinceMs: Date.now() - cutoffTs + 100 })) || null;
    stats.hits += gained;
    stats.lastResult = 'sweep ok=' + gained + (collect ? ' items=' + collect.resourceItems + ' (resp ' + collect.withResources + '/' + collect.acks + ')' : '');
    return { ok: gained, resourceItems: collect ? collect.resourceItems : 0, withResources: collect ? collect.withResources : 0, ackCount: collect ? collect.acks : 0 };
  }

  // Project parsed world objects to in-canvas screen coords using HC_Overlay's
  // current transform. Filters out points outside the canvas / UI bands.
  function projectedClickList(opts) {
    if (!net || !window.HC_Overlay) return null;
    const r = net.lastFarmObjects(opts || {});
    if (!r.found || !r.objects || r.objects.length === 0) return null;
    const W = canvas.width, H = canvas.height;
    const xLo = VCFG.edgeInsetX, xHi = W - VCFG.edgeInsetX;
    const yLo = VCFG.edgeInsetTop, yHi = H - VCFG.edgeInsetBottom;
    const out = [];
    for (const o of r.objects) {
      const p = window.HC_Overlay.toScreen(o.x, o.y);
      if (p.x < xLo || p.x > xHi || p.y < yLo || p.y > yHi) continue;
      out.push({ type: o.type, wx: o.x, wy: o.y, sx: Math.round(p.x), sy: Math.round(p.y), eid: o.eid });
    }
    return out;
  }

  // Parsed sweep: click each projected collectible position once.
  async function parsedPass(forStop) {
    const list = projectedClickList();
    if (!list || list.length === 0) return null; // signal to caller to fall back
    const cutoffTs = Date.now();
    const okBefore = net.getStats().totalOk;
    for (const c of list) {
      if (forStop && !running) break;
      click(c.sx, c.sy);
      stats.attempts++;
      stats.hitCoords.push([c.sx, c.sy, c.type]);
      await sleep(VCFG.parsedClickGap);
    }
    await sleep(VCFG.settleAfterSweep);
    const gained = net.getStats().totalOk - okBefore;
    const collect = (net.lastCollectStats && net.lastCollectStats({ sinceMs: Date.now() - cutoffTs + 100 })) || null;
    stats.hits += gained;
    stats.lastResult = 'parsed' + list.length + ' ok=' + gained + (collect ? ' items=' + collect.resourceItems : '');
    return { ok: gained, resourceItems: collect ? collect.resourceItems : 0, withResources: collect ? collect.withResources : 0, ackCount: collect ? collect.acks : 0 };
  }

  async function runSweep(forStop) {
    if (VCFG.sweepMode === 'grid') return farmPass(forStop);
    if (VCFG.sweepMode === 'parsed') {
      const g = await parsedPass(forStop);
      return g == null ? { ok: 0, resourceItems: 0, withResources: 0, ackCount: 0 } : g;
    }
    // auto: prefer parsed, fall back to grid
    const g = await parsedPass(forStop);
    if (g != null) return g;
    console.log('[HC_Visit] No parsed objects/transform — falling back to grid sweep');
    return farmPass(forStop);
  }

  // ── Hub entry: probe known farm-icon positions until one loads a farm ──
  // Coarse grid covering the hub playfield; hub farm icons are usually
  // ~80–120 px wide so a ~150 px grid usually hits at least one.
  const HUB_PROBES = [];
  for (let y = 220; y <= 520; y += 100) {
    for (let x = 200; x <= 850; x += 130) HUB_PROBES.push({ x, y });
  }

  async function enterFarmFromHub(opts) {
    const requireRunning = !opts || opts.requireRunning !== false;
    const startSeq = net.lastFarmLoadSeq();
    log('enterFarmFromHub: startSeq=' + startSeq + ' probeCount=' + HUB_PROBES.length + ' requireRunning=' + requireRunning);
    let attempts = 0;
    for (const p of HUB_PROBES) {
      if (requireRunning && !running) { log('enterFarmFromHub aborted: running=false'); break; }
      if (attempts >= VCFG.maxHubAttempts) { log('enterFarmFromHub: hit maxHubAttempts'); break; }
      attempts++;
      log('hub probe #' + attempts + ' @ canvas (' + p.x + ',' + p.y + ')');
      click(p.x, p.y);
      const newSeq = await net.awaitNextFarmLoad({ afterSeq: startSeq, timeoutMs: VCFG.hubProbeTimeout });
      if (newSeq != null && newSeq !== startSeq) {
        log('ENTERED farm via probe #' + attempts + ' (' + p.x + ',' + p.y + ') seq=' + newSeq);
        await sleep(800);
        return true;
      }
      await sleep(VCFG.hubProbeGap);
    }
    log('enterFarmFromHub FAILED after ' + attempts + ' probes (DbgClick timeouts=' + clickFails + ')');
    return false;
  }

  async function loop() {
    let emptyAdvances = 0;
    log('loop start: lastFarmLoadSeq=' + net.lastFarmLoadSeq() + ' BTN.next=(' + BTN.next.x + ',' + BTN.next.y + ')');

    if (net.lastFarmLoadSeq() == null) {
      log('Not inside a farm — bootstrapping via hub probe');
      if (!(await enterFarmFromHub())) {
        log('STOP: bootstrap failed');
        running = false;
        return;
      }
    } else {
      log('Already in a farm — skipping hub bootstrap');
    }

    let zeroCollectSweeps = 0;
    while (running) {
      const seqBeforeSweep = net.lastFarmLoadSeq();
      log('--- pass ' + (stats.passes + 1) + ' starting (seq=' + seqBeforeSweep + ') ---');
      const r = await runSweep(true);
      stats.passes++;
      log('sweep done: ok=' + r.ok + ' items=' + r.resourceItems + ' (resp ' + r.withResources + '/' + r.ackCount + ') totalAttempts=' + stats.attempts + ' clickFails=' + clickFails);

      // Server-side signal: if EVERY P\0 ack we got back included no ra_*
      // resource record, the backpack is full (or the farm has nothing left
      // to give). Two such sweeps in a row → stop. This is the byte-level
      // signal the previous version was lacking; it's far more decisive
      // than the empty-advance counter.
      if (r.ackCount > 0 && r.withResources === 0) {
        zeroCollectSweeps++;
        log('zero-resource sweep #' + zeroCollectSweeps + ' (acks=' + r.ackCount + ', items=0) — likely backpack full or farm exhausted');
        if (zeroCollectSweeps >= 2) {
          log('STOP: 2 consecutive sweeps with no ra_* collected — backpack likely full');
          running = false;
          return;
        }
      } else if (r.resourceItems > 0) {
        zeroCollectSweeps = 0;
      }

      // Try multiple advance candidates: the popup-center Далее (only present
      // when the farm is fully exhausted) AND the bottom-left Далее (always
      // present once any collection happened). Whichever one actually exists
      // will produce the farm-load XHR; the other is a no-op.
      const advanced = await tryAdvance(seqBeforeSweep);
      if (advanced) stats.farms++;

      if (!advanced) {
        emptyAdvances++;
        log('No advance after Далее candidates (#' + emptyAdvances + ' empty)');
        if (emptyAdvances >= VCFG.stopAfterEmptyAdvances) {
          log('STOP: backpack full or out of farms (' + emptyAdvances + ' empty advances)');
          running = false;
          return;
        }
        log('attempting hub recovery');
        if (!(await enterFarmFromHub())) {
          log('STOP: hub recovery failed');
          running = false;
          return;
        }
      } else {
        emptyAdvances = 0;
      }
    }
    log('loop exited (running=false)');
  }

  // Click each candidate Далее position in order, awaiting a farm-load XHR
  // after each. Returns true on the first that produces one. Candidates:
  //   1. Popup-center "Далее" (canvas ~497, 380) — appears only when farm
  //      is fully exhausted; bottom-left button is disabled while popup is up.
  //   2. Bottom-left Далее (BTN.next, default 200, 660) — present after any
  //      collection.
  async function tryAdvance(seqBefore) {
    const candidates = [
      { name: 'popup-Далее', x: BTN.popupNext.x, y: BTN.popupNext.y },
      { name: 'btn-Далее',   x: BTN.next.x, y: BTN.next.y },
    ];
    for (const c of candidates) {
      if (!running) return false;
      log('trying advance: ' + c.name + ' @ (' + c.x + ',' + c.y + ')');
      click(c.x, c.y);
      const newSeq = await net.awaitNextFarmLoad({ afterSeq: seqBefore, timeoutMs: VCFG.advanceWait });
      if (newSeq != null && newSeq !== seqBefore) {
        log('advance OK via ' + c.name + ' → seq=' + newSeq);
        await sleep(600); // settle in new farm
        return true;
      }
      log('  ' + c.name + ' produced no farm-load');
    }
    return false;
  }

  function start() {
    if (running) { log('start ignored — already running'); return; }
    if (!net) { log('start FAILED — HC_Net missing'); console.error('[HC_Visit] HC_Net missing'); return; }
    if (!window.HC_DbgClick) log('WARN: HC_DbgClick missing — using synthetic events (likely dropped)');
    running = true;
    stats = { passes: 0, hits: 0, attempts: 0, farms: 0, lastResult: null, hitCoords: [] };
    clickCount = 0; clickFails = 0;
    log('START: canvas=' + (canvas && canvas.width + 'x' + canvas.height) +
        ' DbgClick=' + (!!window.HC_DbgClick) +
        ' DbgAvailable=' + (window.HC_DbgClick && window.HC_DbgClick.isAvailable()));
    loop().catch(e => log('loop CRASHED: ' + (e && e.message || e)));
  }

  function stop() {
    running = false;
    log('STOP requested. clicks=' + clickCount + ' fails=' + clickFails + ' passes=' + stats.passes);
  }

  return {
    start, stop,
    toggle() { running ? stop() : start(); },
    isRunning() { return running; },
    getStats() { return Object.assign({ running }, stats); },
    getButtons() { return BTN; },
    setHomeBtn(x, y)         { BTN.home.x = x; BTN.home.y = y; },
    setNextBtn(x, y)         { BTN.next.x = x; BTN.next.y = y; },
    setPopupNextBtn(x, y)    { BTN.popupNext.x = x; BTN.popupNext.y = y; },
    setVoyageBtn(x, y)       { BTN.voyage.x = x; BTN.voyage.y = y; },
    setTravelsBtn(x, y)      { BTN.travels.x = x; BTN.travels.y = y; },
    setSessionEndOkBtn(x, y) { BTN.sessionEndOk.x = x; BTN.sessionEndOk.y = y; },
    // Manual one-shot helper for calibration/testing
    sweepOnce: farmPass,
    parsedSweepOnce: parsedPass,
    enterFarmFromHub,
    projectedClickList,
    setSweepMode(m) { if (m === 'auto' || m === 'parsed' || m === 'grid') VCFG.sweepMode = m; return VCFG.sweepMode; },
    getSweepMode() { return VCFG.sweepMode; },
    getCfg() { return Object.assign({}, VCFG); },
    setCfg(p) { Object.assign(VCFG, p || {}); return Object.assign({}, VCFG); },
    getLog() { return logBuf.slice(); },
    clearLog() { logBuf.length = 0; },
    getClickCounters() { return { clicks: clickCount, fails: clickFails }; },
  };
})();
}
