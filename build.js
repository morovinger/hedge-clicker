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

// Load order matters: config → capture → vision → clicker → visit → ui
const modules = ['config.js', 'capture.js', 'scenegraph.js', 'vision.js', 'clicker.js', 'visit.js', 'ui.js'];

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
  const header = `// Hedgehog Smart Collector (Ёжики) - Vision-based Auto-Clicker
// Built: ${new Date().toISOString().slice(0, 10)}
//
// HOW TO USE:
// 1. Open the game at https://vk.com/ezhiky_game
// 2. Press F12 → Console tab
// 3. Switch context from "top" to "valley.redspell.ru" iframe
// 4. Paste this script and press Enter
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
  console.log('[HC] Targets:', HC_CFG.targets.map(t => t.name).join(', ') || 'NONE — use Calibrate to set up');
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
  const header = `// Hedgehog Vision — Chrome extension content script (auto-injected into game iframe)
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
          case 'getCfg':       value = HC_CFG; break;
          case 'setCfg':       Object.assign(HC_CFG, args[0]); value = HC_CFG; break;
          // ── PIXI scene-graph probes ──
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
`;

  const footer = `
    console.log('[HC-Ext] Hedgehog Vision ready. Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
    console.log('[HC-Ext] Targets:', HC_CFG.targets.map(t => t.name).join(', ') || 'NONE');
  });  // end whenReady
`;

  // Eager modules: run immediately at document_start. config has no DOM deps;
  // capture is a thin canvas locator; scenegraph installs no hooks but is safe
  // to load early so its discover() can run any time.
  const eagerFiles = new Set(['config.js', 'capture.js', 'scenegraph.js']);
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
