// ── Visit Loop: auto-traverse "Путешествия" friend farms ──
// Flow:
//   1. User opens Путешествия → clicks "В путь!" → enters first friend's farm
//   2. HC_Visit takes over: clicks purple badges
//   3. When no purple found for `idleScansToExit` scans → clicks "Домой"
//   4. Game auto-advances to next friend farm; loop continues
//   5. When all bars fill, game returns to TRAVELS_HUB. We detect by absence
//      of purple AND repeated "Домой" clicks doing nothing → stop.

window.HC_Visit = (function() {
  const cap = window.HC_Capture;
  const vis = window.HC_Vision;
  const cfg = window.HC_CFG;
  const clicker = window.HC_Clicker;
  const canvas = cap.canvas;

  // Canvas-relative coords for static UI buttons.
  // Calibrate via Pick Target if your canvas is non-standard.
  const BTN = {
    home:   { x: 80,  y: 660 }, // "Домой" / "На ферму" — bottom-left blue
    voyage: { x: 765, y: 260 }, // "В путь!" — only on TRAVELS_HUB
  };

  const VCFG = {
    scanInterval: 1200,        // ms between scans inside friend farm
    clickDelay: 350,           // ms between badge clicks
    idleScansToExit: 3,        // empty scans before clicking "Домой"
    homeWait: 2500,            // ms to wait after "Домой" for next farm to load
    maxHomeRetries: 3,         // if "Домой" doesn't change state (still empty), assume hub → stop
    yOffset: 10,               // click slightly below badge (hits house body)
  };

  let running = false;
  let emptyScans = 0;
  let homeRetries = 0;
  let visited = 0;
  let cycleClicks = 0;

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
  }

  function step() {
    if (!running) return;
    cap.requestFrame();
    setTimeout(() => {
      const detected = vis.scanFrame(cap.getFrame(), cfg);
      if (window.HC_UI) window.HC_UI.updateInfo({
        clicks: cycleClicks, scans: 0, found: detected.length,
        detected, running, mode: 'visit',
      });

      if (detected.length > 0) {
        emptyScans = 0;
        homeRetries = 0;
        let i = 0;
        (function next() {
          if (!running || i >= detected.length) {
            window.__hcTimer = setTimeout(step, VCFG.scanInterval);
            return;
          }
          click(detected[i].x, detected[i].y + VCFG.yOffset);
          cycleClicks++;
          i++;
          setTimeout(next, VCFG.clickDelay);
        })();
        return;
      }

      // No badges visible
      emptyScans++;
      if (emptyScans < VCFG.idleScansToExit) {
        window.__hcTimer = setTimeout(step, VCFG.scanInterval);
        return;
      }

      // Try to advance to next farm
      if (homeRetries >= VCFG.maxHomeRetries) {
        console.log('[HC_Visit] Bars likely full — stopping. Visited:', visited, 'clicks:', cycleClicks);
        stop();
        return;
      }
      console.log('[HC_Visit] No targets, clicking Домой (retry', homeRetries + 1, ')');
      click(BTN.home.x, BTN.home.y);
      homeRetries++;
      visited++;
      emptyScans = 0;
      window.__hcTimer = setTimeout(step, VCFG.homeWait);
    }, 200);
  }

  function start() {
    if (running) return;
    if (clicker && clicker.isRunning()) clicker.stop();
    running = true;
    emptyScans = 0; homeRetries = 0; visited = 0; cycleClicks = 0;
    console.log('[HC_Visit] START — make sure you are inside a friend farm or on TRAVELS_HUB');
    step();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearTimeout(window.__hcTimer);
    if (window.HC_UI && window.HC_UI.updateVisitUI) window.HC_UI.updateVisitUI();
  }

  return {
    start, stop,
    toggle() { running ? stop() : start(); },
    isRunning() { return running; },
    getStats() { return { visited, cycleClicks, running }; },
    getButtons() { return BTN; },
    setHomeBtn(x, y) { BTN.home.x = x; BTN.home.y = y; },
    setVoyageBtn(x, y) { BTN.voyage.x = x; BTN.voyage.y = y; },
  };
})();
