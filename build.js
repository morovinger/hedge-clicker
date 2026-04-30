// Build script: produces two outputs from src/
//   1. clicker.js                       — paste-into-DevTools bundle
//   2. chrome-ext/iframe-script.js      — content script for the Chrome extension
// Both use the same modules; only the wrapper differs.
// Run: node build.js

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const PASTE_OUT = path.join(__dirname, 'clicker.js');
const EXT_OUT = path.join(__dirname, 'chrome-ext', 'iframe-script.js');

// Load order matters: capture stub first, then GL/network spies, then visit + ui.
const modules = ['glspy.js', 'network.js', 'dbgclick.js', 'capture.js', 'scenegraph.js', 'overlay.js', 'visit.js', 'ui.js'];

function readModules() {
  return modules.map(file => ({
    file,
    src: fs.readFileSync(path.join(SRC, file), 'utf8'),
  }));
}

function indent(text, n = 2) {
  const pad = ' '.repeat(n);
  return text.split('\n').map(l => pad + l).join('\n');
}

// ── Build #1: paste bundle ──
function buildPasteBundle(mods) {
  const header = `// Hedgehog Clicker (Ёжики) — autonomous friend-farm collector
// Built: ${new Date().toISOString().slice(0, 10)}
//
// HOW TO USE:
// 1. Open the game at https://vk.com/ezhiky_game
// 2. Press F12 → Console tab
// 3. Switch context from "top" to "valley.redspell.ru" iframe
// 4. Paste this script and press Enter
//
// NOTE: paste-mode does not get debugger-trusted clicks; the Visit loop
// only works through the Chrome extension. Manual paste is for poking
// at HC_Net / HC_Scene / HC_Overlay from DevTools.
//
// CONTROLS: F2 = toggle on/off
`;

  const initCheck = `
  // Cleanup
  const old = document.getElementById("hc-panel");
  if (old) old.remove();
  if (window.__hcTimer) clearTimeout(window.__hcTimer);

  const canvas = document.querySelector("canvas");
  if (!canvas) { console.error("[HC] No canvas!"); return; }
`;

  const footer = `
  // ── Init ──
  console.log('[HC] Hedgehog Vision loaded! Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
  console.log('[HC] Press F2 or START to begin.');
`;

  let out = header + '\n(function() {\n  "use strict";\n' + initCheck + '\n';
  for (const { file, src } of mods) {
    out += `  // ═══ ${file} ═══\n` + indent(src) + '\n\n';
  }
  out += indent(footer.trim()) + '\n})();\n';
  return out;
}

// ── Build #2: chrome extension content script ──
// Runs at document_start in MAIN world. Loads config + capture eagerly so
// our getContext hook beats PIXI. Defers everything else (UI, modules,
// bridge) until HC_Capture has captured a real WebGL context.
function buildExtBundle(mods) {
  const header = `// Hedgehog Clicker — Chrome extension content script (auto-injected into game iframe)
// Built: ${new Date().toISOString().slice(0, 10)}
// Runs at document_start in MAIN world inside https://valley.redspell.ru/play/vk/index.html
`;

  const bootstrap = `
  // Cleanup any prior instance (re-injection on hot-reload)
  const old = document.getElementById && document.getElementById("hc-panel");
  if (old) old.remove();
  if (window.__hcTimer) clearTimeout(window.__hcTimer);
  if (window.__hcExtInit) {
    console.log('[HC-Ext] Re-injecting (already initialized — capture hook stays)');
  }
  window.__hcExtInit = true;
`;

  const bridge = `
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
          case 'visitStart':   HC_Visit.start(); value = HC_Visit.getStats(); break;
          case 'visitStop':    HC_Visit.stop(); value = HC_Visit.getStats(); break;
          case 'visitStats':   value = HC_Visit.getStats(); break;
          case 'setHomeBtn':   HC_Visit.setHomeBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          case 'setVoyageBtn': HC_Visit.setVoyageBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          // ── PIXI scene-graph probes ──
          case 'eval': {
            // Debug-only: evaluate arbitrary JS in iframe context. Returns serializable result.
            const fn = new Function('HC_Scene', 'HC_Capture', 'HC_Visit', args[0]);
            value = await Promise.resolve(fn(window.HC_Scene, window.HC_Capture, window.HC_Visit));
            break;
          }
          case 'glSpy': value = HC_GLSpy.getStats(); break;
          case 'glSpyReset': HC_GLSpy.resetSamples(); value = 'reset'; break;
          case 'glSpyFp': value = HC_GLSpy.getFingerprint(); break;
          case 'glSpyTextures': value = HC_GLSpy.listTextures(); break;
          case 'glSnap': {
            // Save a snapshot under a name. args: [name]
            window.__hcSnaps = window.__hcSnaps || {};
            window.__hcSnaps[args[0]] = HC_GLSpy.snapshot();
            value = { saved: args[0], draws: window.__hcSnaps[args[0]].draws };
            break;
          }
          case 'glDiff': {
            // Diff named snapshot vs current. args: [name]
            const prev = (window.__hcSnaps || {})[args[0]];
            if (!prev) { value = { err: 'no snap named ' + args[0] }; break; }
            value = HC_GLSpy.diff(prev, HC_GLSpy.snapshot());
            break;
          }
          case 'glWindow': {
            // Capture textures across N ms. args: [ms]
            value = await HC_GLSpy.captureWindow(args[0] || 800);
            break;
          }
          case 'netStats':     value = HC_Net ? HC_Net.getStats() : { err: 'no HC_Net' }; break;
          case 'netAwait':     value = HC_Net ? await HC_Net.awaitNextResponse(args[0] || 800) : 'no HC_Net'; break;
          case 'netDump':      value = HC_Net ? HC_Net.dump(args[0] || {}) : 'no HC_Net'; break;
          case 'netClear':     HC_Net && HC_Net.clearRing(); value = { cleared: true }; break;
          case 'netFarmObjects': {
            if (!HC_Net) { value = 'no HC_Net'; break; }
            const r = HC_Net.lastFarmObjects(args[0] || {});
            // Without overlay/calibration, just summarize types and bbox
            const types = {};
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            for (const o of r.objects) {
              types[o.type] = (types[o.type] || 0) + 1;
              if (o.x < xMin) xMin = o.x; if (o.x > xMax) xMax = o.x;
              if (o.y < yMin) yMin = o.y; if (o.y > yMax) yMax = o.y;
            }
            value = {
              found: r.found, count: r.count, totalRecords: r.totalRecords,
              source: r.source,
              types,
              bbox: r.objects.length ? { xMin, xMax, yMin, yMax } : null,
              sample: r.objects.slice(0, 12),
            };
            break;
          }
          case 'netFarmObjectsRaw': {
            if (!HC_Net) { value = 'no HC_Net'; break; }
            value = HC_Net.lastFarmObjects(args[0] || {});
            break;
          }
          case 'overlayShow':       value = HC_Overlay ? HC_Overlay.show(args[0] || {}) : 'no HC_Overlay'; break;
          case 'overlayHide':       value = HC_Overlay ? HC_Overlay.hide() : 'no HC_Overlay'; break;
          case 'overlaySet':        value = HC_Overlay ? HC_Overlay.setTransform(args[0] || {}) : 'no HC_Overlay'; break;
          case 'overlayGet':        value = HC_Overlay ? HC_Overlay.getTransform() : 'no HC_Overlay'; break;
          case 'overlayCalibrate':  value = HC_Overlay ? HC_Overlay.calibrateFromPairs(args[0], args[1]) : 'no HC_Overlay'; break;
          case 'overlayProject': {
            // Project a world (wx, wy) to canvas pixel coords using current transform.
            if (!HC_Overlay) { value = 'no HC_Overlay'; break; }
            value = HC_Overlay.toScreen(args[0], args[1]);
            break;
          }
          case 'dbgPing':      value = window.HC_DbgClick ? await window.HC_DbgClick.probe() : 'no HC_DbgClick'; break;
          case 'dbgTargets':   value = window.HC_DbgClick ? await window.HC_DbgClick.listTargets() : 'no HC_DbgClick'; break;
          case 'dbgClick': {
            if (!window.HC_DbgClick) { value = { err: 'no HC_DbgClick' }; break; }
            const c = HC_Capture.canvas;
            const r = c.getBoundingClientRect();
            const sx = c.width / r.width, sy = c.height / r.height;
            const vx = r.left + args[0] / sx;
            const vy = r.top  + args[1] / sy;
            value = await window.HC_DbgClick.click(vx, vy);
            break;
          }
          case 'visitSweep':       value = HC_Visit ? await HC_Visit.sweepOnce() : 'no HC_Visit'; break;
          case 'visitParsedSweep': value = HC_Visit ? await HC_Visit.parsedSweepOnce() : 'no HC_Visit'; break;
          case 'visitProjected':   value = HC_Visit ? HC_Visit.projectedClickList(args[0]) : 'no HC_Visit'; break;
          case 'visitSetMode':     value = HC_Visit ? HC_Visit.setSweepMode(args[0]) : 'no HC_Visit'; break;
          case 'visitGetMode':     value = HC_Visit ? HC_Visit.getSweepMode() : 'no HC_Visit'; break;
          case 'visitGetCfg':      value = HC_Visit ? HC_Visit.getCfg() : 'no HC_Visit'; break;
          case 'visitSetCfg':      value = HC_Visit ? HC_Visit.setCfg(args[0]) : 'no HC_Visit'; break;
          case 'visitSetNext':    HC_Visit.setNextBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          case 'visitSetTravels': HC_Visit.setTravelsBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          case 'visitSetSessionEndOk': HC_Visit.setSessionEndOkBtn(args[0], args[1]); value = HC_Visit.getButtons(); break;
          case 'clickAt': {
            // Dispatch a click on the canvas at (x, y) in canvas coords.
            const c = HC_Capture.canvas;
            const r = c.getBoundingClientRect();
            const sx = c.width / r.width, sy = c.height / r.height;
            const o = { clientX: r.left + args[0] / sx, clientY: r.top + args[1] / sy, bubbles: true, cancelable: true, view: window };
            c.dispatchEvent(new PointerEvent('pointerdown', o));
            c.dispatchEvent(new MouseEvent('mousedown', o));
            c.dispatchEvent(new PointerEvent('pointerup', o));
            c.dispatchEvent(new MouseEvent('mouseup', o));
            c.dispatchEvent(new MouseEvent('click', o));
            value = { clickedAt: [args[0], args[1]] };
            break;
          }
          case 'pixiTrap': {
            const T = window.__hcPixiTrap;
            if (!T) { value = { installed: false }; break; }
            value = {
              installed: true,
              renderers: T.renderers.length,
              stages: T.stages.length,
              events: T.events.slice(-30),
              firstRenderer: T.renderers[0] ? {
                ctor: T.renderers[0].constructor.name,
                w: T.renderers[0].width, h: T.renderers[0].height,
                hasGl: !!T.renderers[0].gl,
              } : null,
              firstStage: T.stages[0] ? {
                ctor: T.stages[0].constructor.name,
                children: T.stages[0].children ? T.stages[0].children.length : null,
              } : null,
            };
            break;
          }
          case 'pixiDiscover': value = { found: !!HC_Scene.discover(), ready: HC_Scene.isReady() }; break;
          case 'pixiDeep': {
            const out = { hasPIXI: !!window.PIXI };
            if (window.PIXI) {
              out.pixiKeys = Object.keys(window.PIXI).slice(0, 50);
              out.version = window.PIXI.VERSION || window.PIXI.version || null;
              out.hasApplication = !!window.PIXI.Application;
            }
            out.devtoolsHook = !!window.__PIXI_DEVTOOLS_GLOBAL_HOOK__;
            if (window.__PIXI_DEVTOOLS_GLOBAL_HOOK__) {
              const h = window.__PIXI_DEVTOOLS_GLOBAL_HOOK__;
              out.devtoolsKeys = Object.keys(h).slice(0, 30);
              // PIXI's devtools register: store all registered apps
              try {
                if (h.apps) out.appsCount = h.apps.length || Object.keys(h.apps).length;
                if (h.app) out.hasApp = true;
                if (h.renderers) out.renderersCount = h.renderers.length || Object.keys(h.renderers).length;
              } catch (e) {}
            }
            // Also check inspector hook
            out.inspectorHook = !!window.__PIXI_INSPECTOR_GLOBAL_HOOK__;
            // Probe canvas backref
            try {
              const c = HC_Capture.canvas;
              if (c) {
                out.canvasKeys = Object.keys(c).filter(k => k.toLowerCase().includes('pixi') || k.startsWith('_'));
              }
            } catch (e) {}
            // Search nested: PIXI.utils, PIXI.Application
            try {
              if (window.PIXI && window.PIXI.utils) {
                out.utilsKeys = Object.keys(window.PIXI.utils).slice(0, 20);
                if (window.PIXI.utils.TextureCache) {
                  out.textureCacheCount = Object.keys(window.PIXI.utils.TextureCache).length;
                }
              }
            } catch (e) {}
            value = out;
            break;
          }
          case 'pixiSummary':  value = HC_Scene.summarize(args[0] || 200); break;
          case 'pixiTextures': value = HC_Scene.listTextures(args[0] || 100); break;
          case 'pixiFindTex':  value = HC_Scene.findByTexture(...args); break;
          case 'pixiGlobals':  {
            // List window properties that look like a PIXI app (have .stage)
            const out = [];
            try {
              for (const k of Object.keys(window)) {
                if (k.startsWith('__hc') || k.startsWith('HC_')) continue;
                let v;
                try { v = window[k]; } catch (e) { continue; }
                if (v && typeof v === 'object') {
                  const has = {
                    stage: !!v.stage,
                    renderer: !!v.renderer,
                    ticker: !!v.ticker,
                    view: !!v.view,
                  };
                  if (has.stage || (has.renderer && has.view)) {
                    out.push({ key: k, has, ctor: v.constructor && v.constructor.name });
                  }
                }
              }
            } catch (e) {}
            value = { hits: out, hasPIXI: !!window.PIXI };
            break;
          }
          case 'enumCanvases': {
            const list = Array.from(document.querySelectorAll('canvas')).map((c, i) => {
              const r = c.getBoundingClientRect();
              const ctxs = ['webgl2','webgl','2d'].map(t => { try { return c.getContext(t) ? t : null; } catch(e) { return null; } }).filter(Boolean);
              return { i, w: c.width, h: c.height, rectW: Math.round(r.width), rectH: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), contexts: ctxs };
            });
            value = { count: list.length, canvases: list, hookedCanvasIs: HC_Capture.canvas === document.querySelector('canvas') ? 'first' : 'other' };
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
`;

  const footer = `
    console.log('[HC-Ext] Hedgehog Vision ready. Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
  });  // end whenReady
`;

  // Eager modules: run immediately at document_start. capture is a thin
  // canvas locator; scenegraph installs no hooks but is safe to load early
  // so its discover() can run any time.
  const eagerFiles = new Set(['glspy.js', 'network.js', 'dbgclick.js', 'capture.js', 'scenegraph.js']);
  const eagerMods = mods.filter(m => eagerFiles.has(m.file));
  const lazyMods = mods.filter(m => !eagerFiles.has(m.file));

  let out = header + '\n(function() {\n  "use strict";\n' + bootstrap + '\n';
  for (const { file, src } of eagerMods) {
    out += `  // ═══ ${file} (eager) ═══\n` + indent(src, 2) + '\n\n';
  }
  // Defer the rest until HC_Capture has the real WebGL context.
  out += '  HC_Capture.whenReady(function() {\n';
  for (const { file, src } of lazyMods) {
    out += `    // ═══ ${file} (deferred) ═══\n` + indent(src, 4) + '\n\n';
  }
  out += bridge + footer + '})();\n';
  return out;
}

const mods = readModules();

const paste = buildPasteBundle(mods);
fs.writeFileSync(PASTE_OUT, paste, 'utf8');
console.log(`Built ${PASTE_OUT} (${(paste.length / 1024).toFixed(1)} KB)`);

const ext = buildExtBundle(mods);
fs.writeFileSync(EXT_OUT, ext, 'utf8');
console.log(`Built ${EXT_OUT} (${(ext.length / 1024).toFixed(1)} KB)`);
