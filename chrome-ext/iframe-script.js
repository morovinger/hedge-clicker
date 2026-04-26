// Hedgehog Vision — Chrome extension content script (auto-injected into game iframe)
// Built: 2026-04-26
// Runs at document_start in MAIN world inside https://valley.redspell.ru/play/vk/index.html

(function() {
  "use strict";

  // Cleanup any prior instance (re-injection on hot-reload)
  const old = document.getElementById && document.getElementById("hc-panel");
  if (old) old.remove();
  if (window.__hcTimer) clearTimeout(window.__hcTimer);
  if (window.__hcExtInit) {
    console.log('[HC-Ext] Re-injecting (already initialized — capture hook stays)');
  }
  window.__hcExtInit = true;

  // ═══ config.js (eager) ═══
  // ── Configuration ──
  // Color targets and scanning parameters.
  // Edit targets here or use Calibrate in the UI to find HSL values.
  
  window.HC_CFG = {
    targets: [
      // Purple/violet badges (resource ready indicators)
      // Calibrate on actual badges to refine these ranges!
      { name: 'purple', hMin: 260, hMax: 320, sMin: 30, sMax: 100, lMin: 25, lMax: 70 },
      // Gold badges — DISABLED by default (matches too much scenery).
      // Enable after calibrating on an actual gold badge.
      // { name: 'gold', hMin: 40, hMax: 50, sMin: 80, sMax: 100, lMin: 50, lMax: 70 },
    ],
    scanInterval: 2000,   // ms between scans in smart mode
    clickDelay: 300,       // ms between clicks
    minCluster: 15,        // min pixel hits to count as a badge (raised from 8)
    clusterRadius: 30,     // px radius for grouping hits
    skipTop: 70,           // skip UI bar at top
    skipBottom: 40,        // skip bottom bar
    scanStep: 3,           // pixel step (lower = more detail, slower)
  };
  

  // ═══ capture.js (eager) ═══
  // ── WebGL Frame Capture ──
  // Hooks HTMLCanvasElement.prototype.getContext at document_start so we can
  // piggy-back on whatever WebGL context PIXI creates (no preemptive creation
  // — that would steal the context type and break PIXI with a null-ctx crash).
  //
  // When PIXI calls canvas.getContext('webgl' | 'webgl2'), our hook records the
  // canvas+context and wraps every draw-* method. Capture itself happens on the
  // last drawcall of each frame (count detected via setTimeout-based idle).
  
  // Idempotent guard: if already installed (e.g. extension reload), reuse it
  // rather than wrapping the prototype again — re-wrapping causes draw methods
  // to call readPixels N times per call and freezes the renderer.
  if (window.HC_Capture) {
    console.log('[HC] Capture already installed — reusing.');
  } else {
  window.HC_Capture = (function() {
    let canvas = null;
    let gl = null;
    let frameData = null;
    let captureRequested = true;
    let totalDrawCalls = 0;
    let drawsThisFrame = 0;
    let drawsLastFrame = 0;
    let drawsLastFrameValid = false;
    let frameEndTimer = null;
    let missedFrames = 0;
    const wrappedNames = [];
    const readyCallbacks = [];
  
    function maybeCapture() {
      totalDrawCalls++;
      drawsThisFrame++;
  
      if (frameEndTimer) clearTimeout(frameEndTimer);
      frameEndTimer = setTimeout(() => {
        if (drawsThisFrame > 0) {
          if (captureRequested) {
            missedFrames++;
            if (missedFrames >= 2) drawsLastFrame = drawsThisFrame;
          } else {
            drawsLastFrame = drawsThisFrame;
          }
          drawsLastFrameValid = true;
        }
        drawsThisFrame = 0;
        frameEndTimer = null;
      }, 1);
  
      if (captureRequested && drawsLastFrameValid && drawsThisFrame >= drawsLastFrame) {
        try {
          const w = canvas.width, h = canvas.height;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          frameData = { data: pixels, width: w, height: h, time: Date.now() };
          captureRequested = false;
          missedFrames = 0;
        } catch(e) {}
      }
    }
  
    function wrap(obj, name) {
      const orig = obj[name];
      if (typeof orig !== 'function') return false;
      obj[name] = function() {
        orig.apply(obj, arguments);
        maybeCapture();
      };
      return true;
    }
  
    function attachToContext(c, ctx) {
      if (gl) return;
      canvas = c;
      gl = ctx;
  
      for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced',
                       'drawArraysInstanced', 'drawRangeElements']) {
        if (wrap(gl, n)) wrappedNames.push(n);
      }
      try {
        const ext = gl.getExtension && gl.getExtension('ANGLE_instanced_arrays');
        if (ext) {
          for (const n of ['drawElementsInstancedANGLE', 'drawArraysInstancedANGLE']) {
            if (wrap(ext, n)) wrappedNames.push('ext.' + n);
          }
        }
      } catch (e) {}
  
      console.log('[HC] Capture attached. Hooks:', wrappedNames.join(', '),
                  'canvas:', canvas.width + 'x' + canvas.height);
      while (readyCallbacks.length) {
        try { readyCallbacks.shift()(); } catch (e) { console.error(e); }
      }
    }
  
    // Hook getContext on the prototype (document_start ensures we beat PIXI).
    const proto = HTMLCanvasElement.prototype;
    const origGetContext = proto.getContext;
    proto.getContext = function(type, ...rest) {
      const ctx = origGetContext.call(this, type, ...rest);
      if (!gl && ctx &&
          (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        attachToContext(this, ctx);
      }
      return ctx;
    };
  
    // Paste-mode fallback: if a non-default-size canvas already exists, it almost
    // certainly already has a WebGL context. Probe it (origGetContext on a canvas
    // that already has a context returns the existing one without creating).
    for (const c of document.querySelectorAll('canvas')) {
      if (c.width === 300 && c.height === 150) continue; // default — likely no context
      let ctx = origGetContext.call(c, 'webgl2');
      if (!ctx) ctx = origGetContext.call(c, 'webgl');
      if (ctx) { attachToContext(c, ctx); break; }
    }
  
    return {
      get canvas() { return canvas; },
      get gl() { return gl; },
      requestFrame() { captureRequested = true; },
      getFrame() { return frameData; },
      getDrawCallCount() { return totalDrawCalls; },
      getDrawsLastFrame() { return drawsLastFrame; },
      isReady() { return !!gl; },
      whenReady(cb) { gl ? cb() : readyCallbacks.push(cb); },
      getCaptureState() {
        return {
          ready: !!gl,
          captureRequested,
          totalDrawCalls,
          drawsThisFrame,
          drawsLastFrame,
          drawsLastFrameValid,
          frameAge: frameData ? Date.now() - frameData.time : null,
          wrappedMethods: wrappedNames,
          canvas: canvas ? [canvas.width, canvas.height] : null,
        };
      },
    };
  })();
  } // end HC_Capture install guard
  

  HC_Capture.whenReady(function() {
    // ═══ vision.js (deferred) ═══
    // ── Vision: Color Detection + Clustering ──
    
    window.HC_Vision = (function() {
      function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; }
        else {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
          }
        }
        return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
      }
    
      // Scan frame pixels for target colors, return clustered detections
      function scanFrame(frameData, cfg) {
        if (!frameData) return [];
        const { data, width: w, height: h } = frameData;
        const step = cfg.scanStep;
        const hits = [];
    
        for (let y = cfg.skipTop; y < h - cfg.skipBottom; y += step) {
          for (let x = 10; x < w - 10; x += step) {
            const fy = h - 1 - y; // WebGL Y-flip
            const i = (fy * w + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (r === 0 && g === 0 && b === 0) continue; // skip black
            const [hue, sat, lit] = rgbToHsl(r, g, b);
    
            for (const t of cfg.targets) {
              if (hue >= t.hMin && hue <= t.hMax &&
                  sat >= t.sMin && sat <= t.sMax &&
                  lit >= t.lMin && lit <= t.lMax) {
                hits.push({ x, y, name: t.name });
                break;
              }
            }
          }
        }
    
        // Cluster nearby hits
        const clusters = [];
        const used = new Set();
        const r2 = cfg.clusterRadius * cfg.clusterRadius;
    
        for (let i = 0; i < hits.length; i++) {
          if (used.has(i)) continue;
          let sx = hits[i].x, sy = hits[i].y, cnt = 1;
          used.add(i);
          for (let j = i + 1; j < hits.length; j++) {
            if (used.has(j)) continue;
            const dx = hits[j].x - hits[i].x, dy = hits[j].y - hits[i].y;
            if (dx * dx + dy * dy < r2) {
              sx += hits[j].x; sy += hits[j].y; cnt++;
              used.add(j);
            }
          }
          if (cnt >= cfg.minCluster) {
            clusters.push({
              x: Math.round(sx / cnt),
              y: Math.round(sy / cnt),
              count: cnt,
              name: hits[i].name
            });
          }
        }
    
        return clusters;
      }
    
      // Read pixel color at canvas coords from captured frame
      function samplePixel(frameData, cx, cy) {
        if (!frameData) return null;
        const { data, width: w, height: h } = frameData;
        const fy = h - 1 - cy;
        const i = (fy * w + cx) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const hsl = rgbToHsl(r, g, b);
        return { r, g, b, h: hsl[0], s: hsl[1], l: hsl[2] };
      }
    
      return { rgbToHsl, scanFrame, samplePixel };
    })();
    

    // ═══ clicker.js (deferred) ═══
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
    

    // ═══ visit.js (deferred) ═══
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
    

    // ═══ ui.js (deferred) ═══
    // ── UI Panel ──
    
    window.HC_UI = (function() {
      const cap = window.HC_Capture;
      const vis = window.HC_Vision;
      const cfg = window.HC_CFG;
      const clicker = window.HC_Clicker;
      const visit = window.HC_Visit;
      const canvas = cap.canvas;
    
      const MODES = ['smart', 'grid', 'single'];
      const MODE_NAMES = { smart: 'Smart', grid: 'Grid', single: 'Single' };
    
      // Cleanup previous instance
      const old = document.getElementById('hc-panel');
      if (old) old.remove();
    
      const panel = document.createElement('div');
      panel.id = 'hc-panel';
      panel.innerHTML = `
        <style>
          #hc-panel{position:fixed;top:10px;right:10px;width:280px;background:rgba(18,18,18,.96);color:#eee;border-radius:12px;font-family:Arial,sans-serif;font-size:13px;z-index:999999;box-shadow:0 4px 24px rgba(0,0,0,.7);user-select:none;border:1px solid rgba(255,255,255,.08)}
          #hc-hdr{background:linear-gradient(135deg,#6a3093,#4a1068);padding:8px 12px;border-radius:12px 12px 0 0;cursor:move;display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-size:14px}
          #hc-body{padding:10px 12px}
          #hc-st{text-align:center;padding:6px;margin-bottom:8px;border-radius:6px;font-weight:bold}
          .hr{display:flex;align-items:center;margin-bottom:5px;gap:6px}.hr label{flex:0 0 78px;font-size:11px;color:#aaa}.hr input[type=range]{flex:1}.hr .v{flex:0 0 38px;text-align:right;font-size:11px;color:#ccc}
          .hb{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;color:#fff;flex:1;text-align:center}.hb:hover{opacity:.85}
          .hbs{display:flex;gap:5px;margin-top:5px}
          .g{background:#2d7a3a}.r{background:#c0392b}.b{background:#2980b9}.p{background:#6a3093}.o{background:#e67e22}
          .sep{border-top:1px solid rgba(255,255,255,.06);margin:7px 0}
          #hc-det{font-size:11px;color:#b388ff;margin-top:4px;max-height:60px;overflow-y:auto}
          #hc-stats{font-size:11px;color:#888;margin-top:3px}
          #hc-cal-out{font-size:10px;color:#f1c40f;margin-top:2px;min-height:13px}
          #hc-info{font-size:10px;color:#555;margin-top:5px;line-height:1.3}
        </style>
        <div id="hc-hdr"><span>Hedgehog Vision</span><span id="hc-min" style="cursor:pointer;font-size:18px">-</span></div>
        <div id="hc-body">
          <div id="hc-st">STOPPED</div>
          <div class="hbs">
            <button class="hb g" id="hc-tog">START (F2)</button>
            <button class="hb p" id="hc-mode">Smart</button>
          </div>
          <div class="sep"></div>
          <div class="hr"><label>Scan interval</label><input type="range" id="hc-si" min="500" max="5000" value="${cfg.scanInterval}" step="100"><span class="v" id="hc-si-v">${cfg.scanInterval/1000}s</span></div>
          <div class="hr"><label>Click delay</label><input type="range" id="hc-cd" min="50" max="1000" value="${cfg.clickDelay}" step="50"><span class="v" id="hc-cd-v">${cfg.clickDelay}ms</span></div>
          <div class="hr"><label>Min cluster</label><input type="range" id="hc-mc" min="2" max="60" value="${cfg.minCluster}" step="1"><span class="v" id="hc-mc-v">${cfg.minCluster}</span></div>
          <div class="hr"><label>Scan detail</label><input type="range" id="hc-ss" min="1" max="6" value="${cfg.scanStep}" step="1"><span class="v" id="hc-ss-v">${cfg.scanStep}</span></div>
          <div class="sep"></div>
          <div class="hbs">
            <button class="hb o" id="hc-scan1" style="font-size:11px">Scan Once</button>
            <button class="hb b" id="hc-cal" style="font-size:11px">Calibrate</button>
            <button class="hb b" id="hc-pick" style="font-size:11px">Pick Target</button>
          </div>
          <div class="hbs">
            <button class="hb p" id="hc-visit" style="font-size:11px">Visit Loop</button>
            <button class="hb b" id="hc-pick-home" style="font-size:11px">Set Home Btn</button>
          </div>
          <div id="hc-visit-stats" style="font-size:10px;color:#b388ff;margin-top:3px"></div>
          <div id="hc-cal-out"></div>
          <div id="hc-det">Detected: -</div>
          <div id="hc-stats">Clicks: 0 | Scans: 0</div>
          <div id="hc-info">
            <b>Smart</b>: Detects badges via pixel colors, clicks them.<br>
            <b>Grid</b>: Dense sweep. <b>Single</b>: One spot.<br>
            Use <b>Calibrate</b> to check pixel colors.
          </div>
        </div>
      `;
      document.body.appendChild(panel);
    
      // ── Drag ──
      let drag = 0, dx = 0, dy = 0;
      document.getElementById('hc-hdr').addEventListener('mousedown', e => {
        drag = 1; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop;
      });
      document.addEventListener('mousemove', e => {
        if (drag) { panel.style.left = (e.clientX - dx) + 'px'; panel.style.right = 'auto'; panel.style.top = (e.clientY - dy) + 'px'; }
      });
      document.addEventListener('mouseup', () => drag = 0);
    
      // ── Minimize ──
      const bodyEl = document.getElementById('hc-body');
      document.getElementById('hc-min').addEventListener('click', () => {
        const hidden = bodyEl.style.display === 'none';
        bodyEl.style.display = hidden ? 'block' : 'none';
        document.getElementById('hc-min').textContent = hidden ? '-' : '+';
      });
    
      // ── Sliders ──
      document.getElementById('hc-si').addEventListener('input', function() { cfg.scanInterval = +this.value; document.getElementById('hc-si-v').textContent = (cfg.scanInterval / 1000) + 's'; });
      document.getElementById('hc-cd').addEventListener('input', function() { cfg.clickDelay = +this.value; document.getElementById('hc-cd-v').textContent = cfg.clickDelay + 'ms'; });
      document.getElementById('hc-mc').addEventListener('input', function() { cfg.minCluster = +this.value; document.getElementById('hc-mc-v').textContent = cfg.minCluster; });
      document.getElementById('hc-ss').addEventListener('input', function() { cfg.scanStep = +this.value; document.getElementById('hc-ss-v').textContent = cfg.scanStep; });
    
      // ── Buttons ──
      document.getElementById('hc-tog').addEventListener('click', () => { clicker.toggle(); updateUI(); });
      document.getElementById('hc-mode').addEventListener('click', () => {
        const cur = clicker.getMode();
        const next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
        clicker.setMode(next);
        document.getElementById('hc-mode').textContent = MODE_NAMES[next];
        updateUI();
      });
    
      // ── Scan Once ──
      document.getElementById('hc-scan1').addEventListener('click', () => clicker.scanOnce());
    
      // ── Calibrate ──
      let cal = false;
      document.getElementById('hc-cal').addEventListener('click', () => {
        cal = !cal;
        document.getElementById('hc-cal').textContent = cal ? 'Click canvas...' : 'Calibrate';
        document.getElementById('hc-cal').className = cal ? 'hb o' : 'hb b';
        if (cal) cap.requestFrame();
      });
      canvas.addEventListener('click', e => {
        if (!cal) return;
        setTimeout(() => {
          const rect = canvas.getBoundingClientRect();
          const cx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
          const cy = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
          const px = vis.samplePixel(cap.getFrame(), cx, cy);
          if (px) {
            const msg = `(${cx},${cy}) RGB(${px.r},${px.g},${px.b}) HSL(${px.h},${px.s}%,${px.l}%)`;
            console.log('[Calibrate]', msg);
            document.getElementById('hc-cal-out').textContent = msg;
          }
        }, 100);
        cal = false;
        document.getElementById('hc-cal').textContent = 'Calibrate';
        document.getElementById('hc-cal').className = 'hb b';
      }, true);
    
      // ── Pick Target ──
      let picking = false;
      document.getElementById('hc-pick').addEventListener('click', () => {
        picking = true;
        document.getElementById('hc-pick').textContent = 'Click...';
        document.getElementById('hc-pick').className = 'hb o';
      });
      canvas.addEventListener('click', e => {
        if (!picking) return;
        const rect = canvas.getBoundingClientRect();
        const tx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
        const ty = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
        clicker.setTarget(tx, ty);
        picking = false;
        document.getElementById('hc-pick').textContent = '(' + tx + ',' + ty + ')';
        document.getElementById('hc-pick').className = 'hb b';
      }, true);
    
      // ── Visit Loop ──
      const visitBtn = document.getElementById('hc-visit');
      visitBtn.addEventListener('click', () => {
        if (!visit) return;
        visit.toggle();
        updateVisitUI();
      });
    
      // ── Set Home Button (calibrate "Домой" coords) ──
      let pickingHome = false;
      document.getElementById('hc-pick-home').addEventListener('click', () => {
        pickingHome = true;
        document.getElementById('hc-pick-home').textContent = 'Click Домой...';
        document.getElementById('hc-pick-home').className = 'hb o';
      });
      canvas.addEventListener('click', e => {
        if (!pickingHome) return;
        const rect = canvas.getBoundingClientRect();
        const tx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
        const ty = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
        if (visit) visit.setHomeBtn(tx, ty);
        pickingHome = false;
        document.getElementById('hc-pick-home').textContent = 'Home(' + tx + ',' + ty + ')';
        document.getElementById('hc-pick-home').className = 'hb b';
      }, true);
    
      // ── F2 hotkey ──
      document.addEventListener('keydown', e => {
        if (e.key === 'F2') { e.preventDefault(); clicker.toggle(); updateUI(); }
      });
    
      function updateUI() {
        const st = document.getElementById('hc-st'), btn = document.getElementById('hc-tog');
        const r = clicker.isRunning(), m = MODE_NAMES[clicker.getMode()];
        if (r) {
          st.textContent = 'RUNNING \u2014 ' + m; st.style.background = 'rgba(106,48,147,.5)'; st.style.color = '#b388ff';
          btn.textContent = 'STOP (F2)'; btn.className = 'hb r';
        } else {
          st.textContent = 'STOPPED'; st.style.background = 'rgba(192,57,43,.3)'; st.style.color = '#ff6b6b';
          btn.textContent = 'START (F2)'; btn.className = 'hb g';
        }
      }
    
      function updateInfo(stats) {
        document.getElementById('hc-stats').textContent = 'Clicks: ' + stats.clicks + ' | Scans: ' + stats.scans + ' | Found: ' + stats.found;
        if (stats.mode === 'smart' && stats.detected.length) {
          document.getElementById('hc-det').textContent = 'Last: ' + stats.detected.map(d => d.name + '(' + d.x + ',' + d.y + ')').join(' ');
        }
      }
    
      function showDetected(detected) {
        document.getElementById('hc-det').textContent =
          'Found: ' + detected.length + (detected.length
            ? ' \u2014 ' + detected.map(d => d.name + '(' + d.x + ',' + d.y + ')[' + d.count + 'px]').join(', ')
            : '');
      }
    
      function updateVisitUI() {
        if (!visit) return;
        const r = visit.isRunning();
        const s = visit.getStats();
        visitBtn.textContent = r ? 'STOP Visit' : 'Visit Loop';
        visitBtn.className = r ? 'hb r' : 'hb p';
        document.getElementById('hc-visit-stats').textContent =
          'Visit: ' + s.cycleClicks + ' clicks, ' + s.visited + ' farms';
      }
    
      updateUI();
      updateVisitUI();
      return { updateUI, updateInfo, showDetected, updateVisitUI };
    })();
    


    // ── postMessage bridge ──
    // Accept commands posted to this window (parent page can do
    // iframe.contentWindow.postMessage({type:'HC_CMD', id, cmd, args}, '*')).
    // Replies go back via window.parent.postMessage({type:'HC_RES', id, ok, value, error}, '*').
    if (window.__hcBridgeInstalled) {
      console.log('[HC-Ext] Bridge already installed — skipping listener.');
    } else {
    window.__hcBridgeInstalled = true;
    window.addEventListener('message', async function(ev) {
      const m = ev.data;
      if (!m || m.type !== 'HC_CMD') return;
      const reply = (ok, value, error) => {
        try {
          window.parent.postMessage({type: 'HC_RES', id: m.id, ok, value, error}, '*');
        } catch (e) { /* parent may be cross-origin; ignore */ }
      };
      try {
        const args = m.args || [];
        let value;
        switch (m.cmd) {
          case 'ping':         value = {ok: true, canvas: HC_Capture.canvas ? [HC_Capture.canvas.width, HC_Capture.canvas.height] : null, ready: HC_Capture.isReady()}; break;
          case 'start':        HC_Clicker.start(); value = HC_Clicker.getStats(); break;
          case 'stop':         HC_Clicker.stop(); value = HC_Clicker.getStats(); break;
          case 'setMode':      HC_Clicker.setMode(args[0]); value = HC_Clicker.getMode(); break;
          case 'scan':         HC_Clicker.scanOnce(); value = 'scan triggered'; break;
          case 'getStats':     value = HC_Clicker.getStats(); break;
          case 'visitStart':   HC_Visit.start(); value = HC_Visit.getStats(); break;
          case 'visitStop':    HC_Visit.stop(); value = HC_Visit.getStats(); break;
          case 'visitStats':   value = HC_Visit.getStats(); break;
          case 'setHomeBtn':   HC_Visit.setHomeBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          case 'setVoyageBtn': HC_Visit.setVoyageBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          case 'click':        // raw click at canvas (x, y)
            HC_Clicker.setMode('single');
            HC_Clicker.setTarget(args[0], args[1]);
            // single mode loops; for one-shot use the internal click
            // — easier: call the dispatch directly via a tiny helper below
            value = 'queued';
            break;
          case 'sample':       value = HC_Vision.samplePixel(HC_Capture.getFrame(), args[0], args[1]); break;
          case 'getCfg':       value = HC_CFG; break;
          case 'setCfg':       Object.assign(HC_CFG, args[0]); value = HC_CFG; break;
          case 'enumCanvases': {
            const list = Array.from(document.querySelectorAll('canvas')).map((c, i) => {
              const r = c.getBoundingClientRect();
              const ctxs = ['webgl2','webgl','2d'].map(t => { try { return c.getContext(t) ? t : null; } catch(e) { return null; } }).filter(Boolean);
              return { i, w: c.width, h: c.height, rectW: Math.round(r.width), rectH: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), contexts: ctxs };
            });
            value = { count: list.length, canvases: list, hookedCanvasIs: HC_Capture.canvas === document.querySelector('canvas') ? 'first' : 'other' };
            break;
          }
          case 'capState':      value = HC_Capture.getCaptureState(); break;
          case 'dumpFrameStats': {
            const fd = HC_Capture.getFrame();
            if (!fd) { value = { hasFrame: false, capState: HC_Capture.getCaptureState() }; break; }
            // sample 100 random pixels and bucket by HSL
            const { data, width: w, height: h } = fd;
            const buckets = {};
            let blackCount = 0;
            for (let n = 0; n < 200; n++) {
              const x = Math.floor(Math.random() * w);
              const y = Math.floor(Math.random() * h);
              const i = (y * w + x) * 4;
              const r = data[i], g = data[i+1], b = data[i+2];
              if (r === 0 && g === 0 && b === 0) { blackCount++; continue; }
              const hsl = HC_Vision.rgbToHsl(r, g, b);
              const hb = Math.floor(hsl[0] / 30) * 30;
              buckets[hb] = (buckets[hb] || 0) + 1;
            }
            value = { hasFrame: true, w, h, age: Date.now() - fd.time, blackCount, hueBuckets: buckets, drawCalls: HC_Capture.getDrawCallCount() };
            break;
          }
          case 'rawScan': {
            // Run scan with very low minCluster to see all hits
            const orig = HC_CFG.minCluster;
            HC_CFG.minCluster = 1;
            HC_Capture.requestFrame();
            value = await new Promise(res => setTimeout(() => {
              const r = HC_Vision.scanFrame(HC_Capture.getFrame(), HC_CFG);
              HC_CFG.minCluster = orig;
              res({ clusterCount: r.length, clusters: r.slice(0, 20) });
            }, 400));
            break;
          }
          default:             return reply(false, null, 'unknown cmd: ' + m.cmd);
        }
        reply(true, value);
      } catch (e) {
        reply(false, null, String(e && e.stack || e));
      }
    });
    console.log('[HC-Ext] Bridge ready — listening for HC_CMD postMessage.');
    } // end bridge install guard

    console.log('[HC-Ext] Hedgehog Vision ready. Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
    console.log('[HC-Ext] Targets:', HC_CFG.targets.map(t => t.name).join(', ') || 'NONE');
  });  // end whenReady
})();
