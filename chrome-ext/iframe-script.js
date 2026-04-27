// Hedgehog Vision — Chrome extension content script (auto-injected into game iframe)
// Built: 2026-04-27
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
  

  // ═══ glspy.js (eager) ═══
  // ── Inline WebGL call interceptor (option 2) ──
  // Wraps HTMLCanvasElement.prototype.getContext at document_start so we see
  // the gl context the game gets. Then monkey-patches the methods we care about
  // on that gl object to record per-draw state (program, texture, uniforms).
  // This bypasses the unreachable bundled PIXI scene graph entirely.
  //
  // Phase 1: identification only — count draws/frame, unique textures, unique
  // programs. Once we know whether sprites are batched or per-draw we decide
  // what to extract next (per-sprite position from translationMatrix uniform,
  // or vertex-buffer inspection for batched paths).
  
  if (window.HC_GLSpy) {
    console.log('[HC] GLSpy already installed — reusing.');
  } else {
  window.HC_GLSpy = (function() {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    let glRef = null;
    let canvasRef = null;
  
    // Per-frame stats. drawsThisFrame is reset by the boundary detector.
    const stats = {
      wrapped: false,
      framesSeen: 0,
      drawsLastFrame: 0,
      drawsThisFrame: 0,
      totalDraws: 0,
      drawHistogram: {},   // drawsPerFrame -> count
      programIds: 0,       // assigned via WeakMap
      textureIds: 0,
      samples: [],         // last N draws: {prog, tex}
      sampleCap: 50,
    };
  
    const programIdMap = new WeakMap();
    const textureIdMap = new WeakMap();
    const textureInfoById = new Map();   // id -> { kind, src, w, h, frameUploaded }
    let nextProgramId = 1;
    let nextTextureId = 1;
  
    let currentProgram = null;
    let currentTexture = null;
    let frameTimer = null;
  
    // Per-frame fingerprint (which textures appeared in the most recent frame)
    let texSeenThisFrame = new Set();
    let texSeenLastFrame = new Set();
    let drawByTexThisFrame = new Map();
    let drawByTexLastFrame = new Map();
    let drawByProgThisFrame = new Map();
    let drawByProgLastFrame = new Map();
  
    function idForProgram(p) {
      if (!p) return null;
      let id = programIdMap.get(p);
      if (id == null) { id = nextProgramId++; programIdMap.set(p, id); stats.programIds = nextProgramId - 1; }
      return id;
    }
    function idForTexture(t) {
      if (!t) return null;
      let id = textureIdMap.get(t);
      if (id == null) { id = nextTextureId++; textureIdMap.set(t, id); stats.textureIds = nextTextureId - 1; }
      return id;
    }
  
    function onDraw(kind) {
      stats.drawsThisFrame++;
      stats.totalDraws++;
      const pid = idForProgram(currentProgram);
      const tid = idForTexture(currentTexture);
      if (tid != null) {
        texSeenThisFrame.add(tid);
        drawByTexThisFrame.set(tid, (drawByTexThisFrame.get(tid) || 0) + 1);
      }
      if (pid != null) {
        drawByProgThisFrame.set(pid, (drawByProgThisFrame.get(pid) || 0) + 1);
      }
      if (stats.samples.length < stats.sampleCap) {
        stats.samples.push({ kind, prog: pid, tex: tid });
      }
      if (frameTimer) clearTimeout(frameTimer);
      frameTimer = setTimeout(frameBoundary, 8);
    }
  
    function frameBoundary() {
      const n = stats.drawsThisFrame;
      if (n > 0) {
        stats.drawsLastFrame = n;
        stats.drawHistogram[n] = (stats.drawHistogram[n] || 0) + 1;
        stats.framesSeen++;
      }
      stats.drawsThisFrame = 0;
      texSeenLastFrame = texSeenThisFrame;
      texSeenThisFrame = new Set();
      drawByTexLastFrame = drawByTexThisFrame;
      drawByTexThisFrame = new Map();
      drawByProgLastFrame = drawByProgThisFrame;
      drawByProgThisFrame = new Map();
    }
  
    function describeTexSource(args) {
      // texImage2D has two overloads:
      //   (target, level, internalformat, format, type, source)        // 6 args
      //   (target, level, internalformat, w, h, border, format, type, pixels)  // 9 args
      if (args.length === 6) {
        const src = args[5];
        if (!src) return { kind: 'null' };
        if (src instanceof HTMLImageElement) return { kind: 'img', src: src.src && src.src.slice(0, 200), w: src.naturalWidth, h: src.naturalHeight };
        if (src instanceof HTMLCanvasElement) return { kind: 'canvas', w: src.width, h: src.height };
        if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) return { kind: 'bitmap', w: src.width, h: src.height };
        if (src instanceof ImageData) return { kind: 'imageData', w: src.width, h: src.height };
        if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return { kind: 'video', w: src.videoWidth, h: src.videoHeight };
        return { kind: 'unknown', ctor: src.constructor && src.constructor.name };
      }
      if (args.length >= 8) {
        return { kind: 'pixels', w: args[3], h: args[4], pixelsLen: args[args.length - 1] && args[args.length - 1].length };
      }
      return { kind: 'odd', argc: args.length };
    }
  
    function wrapGl(gl) {
      if (gl.__hcSpyWrapped) return;
      gl.__hcSpyWrapped = true;
      stats.wrapped = true;
  
      const origUseProgram = gl.useProgram.bind(gl);
      gl.useProgram = function(p) { currentProgram = p; return origUseProgram(p); };
  
      const origBindTexture = gl.bindTexture.bind(gl);
      gl.bindTexture = function(target, tex) {
        if (target === gl.TEXTURE_2D) currentTexture = tex;
        return origBindTexture(target, tex);
      };
  
      const origDrawElements = gl.drawElements.bind(gl);
      gl.drawElements = function() { onDraw('elements'); return origDrawElements.apply(null, arguments); };
  
      const origDrawArrays = gl.drawArrays.bind(gl);
      gl.drawArrays = function() { onDraw('arrays'); return origDrawArrays.apply(null, arguments); };
  
      const origTexImage2D = gl.texImage2D.bind(gl);
      gl.texImage2D = function() {
        try {
          const tid = idForTexture(currentTexture);
          if (tid != null) {
            const info = describeTexSource(arguments);
            info.frameUploaded = stats.framesSeen;
            textureInfoById.set(tid, info);
          }
        } catch (e) {}
        return origTexImage2D.apply(null, arguments);
      };
  
      const origTexSubImage2D = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = function() {
        try {
          const tid = idForTexture(currentTexture);
          if (tid != null && !textureInfoById.has(tid)) {
            // texSubImage2D has different overloads; just record kind
            textureInfoById.set(tid, { kind: 'sub-only', frameUploaded: stats.framesSeen });
          }
        } catch (e) {}
        return origTexSubImage2D.apply(null, arguments);
      };
  
      console.log('[HC-GLSpy] gl wrapped');
    }
  
    // Wrap EVERY WebGL context the page asks for. The game may create multiple
    // canvases (e.g. a hidden one for transport, the real game canvas later).
    // Only the first wrap on a given gl object actually patches it (idempotent).
    HTMLCanvasElement.prototype.getContext = function(type) {
      const ctx = origGetContext.apply(this, arguments);
      if (ctx && /webgl/i.test(type)) {
        // Always remember the latest, BUT prefer big canvases (likely the game).
        if (!glRef || (this.width >= 800 && this.height >= 500)) {
          glRef = ctx;
          canvasRef = this;
        }
        wrapGl(ctx);
      }
      return ctx;
    };
  
    return {
      getStats() {
        return {
          wrapped: stats.wrapped,
          framesSeen: stats.framesSeen,
          drawsLastFrame: stats.drawsLastFrame,
          totalDraws: stats.totalDraws,
          drawHistogram: stats.drawHistogram,
          programIds: stats.programIds,
          textureIds: stats.textureIds,
          sampleCount: stats.samples.length,
          samples: stats.samples,
        };
      },
      resetSamples() { stats.samples = []; },
      getGl() { return glRef; },
      getCanvas() { return canvasRef; },
      // Snapshot for current screen: which textures and programs the last frame
      // used. Pair with HC_GLSpy.listTextures() to know what each texture is.
      getFingerprint() {
        const texList = [];
        for (const [tid, count] of drawByTexLastFrame.entries()) {
          const info = textureInfoById.get(tid) || null;
          texList.push({ tex: tid, draws: count, info });
        }
        texList.sort((a, b) => b.draws - a.draws);
        const progList = [];
        for (const [pid, count] of drawByProgLastFrame.entries()) {
          progList.push({ prog: pid, draws: count });
        }
        progList.sort((a, b) => b.draws - a.draws);
        return { drawsLastFrame: stats.drawsLastFrame, framesSeen: stats.framesSeen, textures: texList, programs: progList };
      },
      listTextures() {
        const out = [];
        for (const [id, info] of textureInfoById.entries()) out.push({ id, ...info });
        out.sort((a, b) => a.id - b.id);
        return out;
      },
  
      // Lightweight snapshot for diffing. Only carries texture IDs + per-tex
      // draw counts + named-texture URLs (the stable bits across runs).
      snapshot() {
        const texs = {};
        const named = {};
        for (const [tid, count] of drawByTexLastFrame.entries()) {
          texs[tid] = count;
          const info = textureInfoById.get(tid);
          if (info && info.src && info.src.indexOf('st-valley.redspell.ru/images/') >= 0) {
            named[info.src.split('/').pop()] = count;
          }
        }
        return {
          draws: stats.drawsLastFrame,
          framesSeen: stats.framesSeen,
          texs,
          named,
        };
      },
  
      // Diff two snapshots. Returns texs that appear in `curr` but not in `prev`
      // (new), and texs whose draw count increased significantly.
      diff(prev, curr) {
        const newTexs = [];
        const moreUsed = [];
        for (const tid in curr.texs) {
          const prevCount = prev.texs[tid] || 0;
          const currCount = curr.texs[tid];
          const info = textureInfoById.get(+tid);
          const entry = {
            tex: +tid, was: prevCount, now: currCount,
            src: info && info.src ? info.src.split('/').pop() : null,
            w: info && info.w, h: info && info.h, kind: info && info.kind,
          };
          if (prevCount === 0) newTexs.push(entry);
          else if (currCount > prevCount) moreUsed.push(entry);
        }
        const newNamed = [];
        for (const name in curr.named) {
          if (!prev.named[name]) newNamed.push({ name, draws: curr.named[name] });
        }
        return {
          drawsDelta: curr.draws - prev.draws,
          newTexCount: newTexs.length,
          newTexs,
          moreUsed,
          newNamed,
        };
      },
  
      // Accumulate texture IDs seen across the next `durationMs` of frames.
      // Useful for catching transient pickup animations after a click.
      async captureWindow(durationMs) {
        const start = stats.framesSeen;
        const seenTexs = new Map();    // tex -> max count in any single frame
        const baseTexs = new Set(Object.keys(this.snapshot().texs).map(Number));
        return new Promise(resolve => {
          const tick = () => {
            for (const [tid, count] of drawByTexLastFrame.entries()) {
              const prev = seenTexs.get(tid) || 0;
              if (count > prev) seenTexs.set(tid, count);
            }
            if (Date.now() - t0 < durationMs) setTimeout(tick, 16);
            else {
              const newTexs = [];
              for (const [tid, count] of seenTexs.entries()) {
                if (!baseTexs.has(tid)) {
                  const info = textureInfoById.get(tid);
                  newTexs.push({
                    tex: tid, peakDraws: count,
                    src: info && info.src ? info.src.split('/').pop() : null,
                    w: info && info.w, h: info && info.h, kind: info && info.kind,
                  });
                }
              }
              resolve({
                framesObserved: stats.framesSeen - start,
                newTexs,
                transientCount: newTexs.length,
              });
            }
          };
          const t0 = Date.now();
          tick();
        });
      },
    };
  })();
  }
  

  // ═══ network.js (eager) ═══
  // ── HC_Net: XHR observer for /proto.html responses ──
  // Hybrid auto-collect uses this as the success oracle: after dispatching a
  // synthetic click, await the next /proto.html response. If the body starts
  // with `80 00` the click hit a real interactive element; if `00 00` (error
  // envelope, e.g. "expired request") or no response arrives, the click missed
  // or the action was rejected.
  //
  // Installs at document_start so it captures the very first POST. Idempotent
  // across re-injection. Adds zero behavior to the page — only observes.
  
  if (window.HC_Net) {
    console.log('[HC] Net already installed — reusing.');
  } else {
  window.HC_Net = (function() {
    let totalOk = 0, totalErr = 0, totalSeen = 0;
    let lastOkAt = 0, lastErrAt = 0, lastResponseAt = 0;
  
    // Ring buffer of recent (request, response) pairs for offline decoding.
    const RING_MAX = 32;
    const ring = [];
    let seq = 0;
  
    function pushRing(entry) {
      entry.seq = ++seq;
      ring.push(entry);
      if (ring.length > RING_MAX) ring.shift();
    }
  
    function bodyToBytes(body) {
      if (body == null) return null;
      try {
        if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
        if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
        if (typeof body === 'string') {
          const out = new Array(body.length);
          for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
          return out;
        }
      } catch (e) {}
      return null;
    }
  
    if (!XMLHttpRequest.prototype.__hcNetWrapped) {
      XMLHttpRequest.prototype.__hcNetWrapped = true;
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
  
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__hcIsProto = (typeof url === 'string' && url.indexOf('/proto.html') >= 0);
        this.__hcUrl = url;
        this.__hcMethod = method;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        if (this.__hcIsProto) {
          // Force binary so we can read the opcode bytes
          try { if (!this.responseType) this.responseType = 'arraybuffer'; } catch (e) {}
          const reqAt = Date.now();
          const reqBytes = bodyToBytes(body);
          const reqUrl = this.__hcUrl;
          this.addEventListener('load', () => {
            totalSeen++;
            lastResponseAt = Date.now();
            let ok = false;
            let respBytes = null;
            try {
              if (this.response instanceof ArrayBuffer) {
                respBytes = Array.from(new Uint8Array(this.response));
                // 0x50 0x00 ('P\0') is the click-acknowledged envelope
                // (action produced game state change). 0x30 0x00 ('0\0')
                // is the background-tick envelope (no action). We want
                // only the former as the success oracle.
                if (respBytes.length >= 2 && respBytes[0] === 0x50 && respBytes[1] === 0x00) {
                  ok = true;
                }
              }
            } catch (e) {}
            if (ok) { totalOk++; lastOkAt = lastResponseAt; }
            else    { totalErr++; lastErrAt = lastResponseAt; }
            pushRing({
              url: reqUrl,
              reqAt, respAt: lastResponseAt,
              ok,
              reqLen: reqBytes ? reqBytes.length : 0,
              respLen: respBytes ? respBytes.length : 0,
              req: reqBytes,
              resp: respBytes,
            });
          });
        }
        return origSend.apply(this, arguments);
      };
      console.log('[HC-Net] XHR observer installed.');
    }
  
    // Wait up to timeoutMs for a /proto.html response to arrive.
    // Returns 'ok' | 'err' | 'none'. Caller should baseline counters before
    // dispatching the click — this fn does it internally for convenience.
    function awaitNextResponse(timeoutMs) {
      const startOk = totalOk;
      const startErr = totalErr;
      const t0 = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          if (totalOk > startOk) return resolve('ok');
          if (totalErr > startErr) return resolve('err');
          if (Date.now() - t0 >= timeoutMs) return resolve('none');
          setTimeout(tick, 30);
        };
        tick();
      });
    }
  
    // Return last N entries. opts: { withBytes: bool, n: number, minRespLen: number, sinceMs: number }
    // When withBytes=false (default) returns metadata only — keeps payloads
    // small. When true, includes req/resp byte arrays for offline decoding.
    function dump(opts) {
      opts = opts || {};
      const n = opts.n || 8;
      const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
      const min = opts.minRespLen || 0;
      let out = ring.filter(e => e.respAt >= since && e.respLen >= min);
      out = out.slice(-n);
      if (!opts.withBytes) {
        return out.map(e => ({
          seq: e.seq, url: e.url, reqAt: e.reqAt, respAt: e.respAt,
          ok: e.ok, reqLen: e.reqLen, respLen: e.respLen,
        }));
      }
      return out;
    }
  
    function clearRing() { ring.length = 0; }
  
    return {
      awaitNextResponse,
      getStats() {
        return { totalSeen, totalOk, totalErr, lastOkAt, lastErrAt, lastResponseAt, ringLen: ring.length };
      },
      dump,
      clearRing,
      // Cheap "did anything succeed in the last N ms?" — useful for a passive
      // sanity check after a known game action.
      wasRecentSuccess(sinceMs) { return Date.now() - lastOkAt < sinceMs; },
      wasRecentError(sinceMs)   { return Date.now() - lastErrAt < sinceMs; },
    };
  })();
  }
  

  // ═══ dbgclick.js (eager) ═══
  // ── HC_DbgClick: trusted clicks via chrome.debugger ──
  // PIXI's interaction manager ignores synthetic events (isTrusted: false),
  // so we route clicks through the extension's chrome.debugger channel
  // which produces real OS-level events.
  //
  // MAIN-world side: post {type:'HC_DBG_CLICK_REQ', id, x, y} on this window.
  // ISOLATED-world bridge (iframe-isolated.js) forwards to the background
  // service worker (background.js) which calls Input.dispatchMouseEvent.
  //
  // Coordinates are in the iframe's CSS viewport, which on this game is
  // 1:1 with canvas pixels (canvas at (0,0), no scaling).
  
  if (window.HC_DbgClick) {
    console.log('[HC] DbgClick already installed — reusing.');
  } else {
  window.HC_DbgClick = (function() {
    const pending = new Map();
    let nextId = 1;
    let available = null; // null = unknown, true/false set after first ping
  
    window.addEventListener('message', function(ev) {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'HC_DBG_CLICK_RES' || m.type === 'HC_DBG_PING_RES' || m.type === 'HC_DBG_TARGETS_RES') {
        const cb = pending.get(m.id);
        if (cb) { pending.delete(m.id); cb(m); }
      }
    });
  
    function send(type, payload, timeoutMs) {
      return new Promise(function(resolve) {
        const id = nextId++;
        pending.set(id, resolve);
        window.postMessage(Object.assign({ type, id }, payload), '*');
        setTimeout(function() {
          if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); }
        }, timeoutMs || 2000);
      });
    }
  
    // Fire a click; returns Promise<{ok, error?}>. The caller usually
    // doesn't await (visit.js spaces clicks by clickGap), but await-able
    // for debugging.
    function click(x, y) {
      return send('HC_DBG_CLICK_REQ', { x, y }, 3000);
    }
  
    // One-shot probe: asks the bridge to ensure the debugger is attached.
    // Returns the result; also memoizes `available`.
    async function probe() {
      const r = await send('HC_DBG_PING_REQ', {}, 3000);
      available = !!(r && r.resp && r.resp.ok);
      return r;
    }
  
    function isAvailable() { return available; }
  
    function listTargets() { return send('HC_DBG_TARGETS_REQ', {}, 3000); }
  
    return { click, probe, isAvailable, listTargets };
  })();
  }
  

  // ═══ capture.js (eager) ═══
  // ── Canvas locator (was: WebGL frame capture) ──
  // Pivoted away from pixel capture — see doc/01-pixel-capture-attempt.md.
  // This stub only locates the game canvas and exposes a tiny ready API so
  // downstream modules (clicker, visit, ui) keep their existing imports.
  // No prototype hooks, no GL context creation, no draw-method wrapping.
  
  if (window.HC_Capture) {
    console.log('[HC] Capture stub already installed — reusing.');
  } else {
  window.HC_Capture = (function() {
    let canvas = null;
    const readyCallbacks = [];
  
    function tryFind() {
      if (canvas) return canvas;
      const candidates = document.querySelectorAll('canvas');
      for (const c of candidates) {
        // Game canvas is the non-default-size one (1000x700).
        if (c.width !== 300 || c.height !== 150) {
          canvas = c;
          while (readyCallbacks.length) {
            try { readyCallbacks.shift()(); } catch (e) { console.error(e); }
          }
          console.log('[HC] Canvas located:', canvas.width + 'x' + canvas.height);
          return canvas;
        }
      }
      return null;
    }
  
    // Try immediately, then poll until canvas appears.
    if (!tryFind()) {
      const poll = setInterval(() => { if (tryFind()) clearInterval(poll); }, 200);
      setTimeout(() => clearInterval(poll), 60000); // give up after 60s
    }
  
    return {
      get canvas() { return canvas; },
      isReady() { return !!canvas; },
      whenReady(cb) { canvas ? cb() : readyCallbacks.push(cb); },
    };
  })();
  }
  

  // ═══ scenegraph.js (eager) ═══
  // ── PIXI scene-graph access ──
  // Discovers the PIXI Application in the iframe and provides a tree walker
  // for finding sprites by texture name, parent name, or custom predicate.
  // See doc/02-pixi-scenegraph-pivot.md.
  
  if (window.HC_Scene) {
    console.log('[HC] Scene already installed — reusing.');
  } else {
  
  // ── Eager probe (option 3): catch the moment PIXI is assigned, wrap key
  // constructors so we capture renderer/stage instances at birth. Runs at
  // document_start, before game scripts.
  (function installPixiTrap() {
    if (window.__hcPixiTrap) return;
    window.__hcPixiTrap = { renderers: [], stages: [], events: [] };
    const T = window.__hcPixiTrap;
  
    function wrapPixi(P) {
      if (!P || P.__hcWrapped) return;
      P.__hcWrapped = true;
      T.events.push({ t: Date.now(), e: 'pixi-detected', keys: Object.keys(P).length });
  
      const wrapCtor = (name) => {
        const Orig = P[name];
        if (typeof Orig !== 'function') return;
        function Wrapped(...args) {
          const inst = new Orig(...args);
          try {
            if (name === 'WebGLRenderer' || name === 'CanvasRenderer') T.renderers.push(inst);
            if (name === 'Stage') T.stages.push(inst);
            T.events.push({ t: Date.now(), e: 'ctor:' + name });
          } catch (e) {}
          return inst;
        }
        Wrapped.prototype = Orig.prototype;
        Object.setPrototypeOf(Wrapped, Orig);
        try { P[name] = Wrapped; } catch (e) {}
      };
      ['WebGLRenderer', 'CanvasRenderer', 'Stage'].forEach(wrapCtor);
    }
  
    if (window.PIXI) {
      wrapPixi(window.PIXI);
    } else {
      let _pixi;
      try {
        Object.defineProperty(window, 'PIXI', {
          configurable: true,
          get() { return _pixi; },
          set(v) { _pixi = v; try { wrapPixi(v); } catch (e) {} },
        });
      } catch (e) { T.events.push({ t: Date.now(), e: 'defineProperty-failed', err: String(e) }); }
    }
  })();
  
  window.HC_Scene = (function() {
    let pixiApp = null;
    let stage = null;
    let renderer = null;
  
    // --- Discovery strategies (try in order) ---
  
    function discover() {
      if (pixiApp) return pixiApp;
  
      // 1. PIXI Devtools convention: __PIXI_APP__ or __PIXI_DEVTOOLS_GLOBAL_HOOK__
      const knownGlobals = [
        '__PIXI_APP__', '__PIXI_RENDERER__', '__PIXI_STAGE__',
        'app', 'game', 'pixiApp', '_app', 'stage',
      ];
      for (const k of knownGlobals) {
        let v; try { v = window[k]; } catch (e) { continue; }
        if (v && (v.stage || v.scene)) { pixiApp = v; return capture(); }
        if (v && v.children && v.transform) { pixiApp = { stage: v, renderer: null }; return capture(); }
      }
  
      // 2. PIXI Devtools hook: __PIXI_DEVTOOLS_GLOBAL_HOOK__ collects registered apps.
      try {
        const h = window.__PIXI_DEVTOOLS_GLOBAL_HOOK__;
        if (h) {
          const apps = h.apps || (h.app ? [h.app] : null);
          if (apps && apps.length) { pixiApp = apps[0]; return capture(); }
          if (h.renderers && h.renderers.length && h.stages && h.stages.length) {
            pixiApp = { renderer: h.renderers[0], stage: h.stages[0] };
            return capture();
          }
        }
      } catch (e) {}
  
      // 3. Walk window properties for any object with .stage and .renderer
      try {
        for (const k of Object.keys(window)) {
          if (k.startsWith('__hc') || k.startsWith('HC_')) continue;
          let v; try { v = window[k]; } catch (e) { continue; }
          if (v && typeof v === 'object' && v.stage && v.renderer) {
            pixiApp = v; return capture();
          }
        }
      } catch (e) {}
  
      // 4. Canvas back-references — some PIXI apps store on the canvas element.
      try {
        const c = window.HC_Capture && window.HC_Capture.canvas;
        if (c) {
          for (const k of ['__pixi_app', '__pixiApp', '_pixiApp', 'pixiApp']) {
            if (c[k]) { pixiApp = c[k]; return capture(); }
          }
          // WebGL context back-ref?
          const gl = c._gl || (c.getContext && c.getContext('webgl'));
          if (gl) {
            for (const k of ['__pixi_renderer', 'renderer', '_renderer']) {
              if (gl[k]) { pixiApp = { renderer: gl[k], stage: gl[k].lastObjectRendered || null }; return capture(); }
            }
          }
        }
      } catch (e) {}
  
      // 5. PIXI namespace exposed?
      if (window.PIXI) {
        const PIXI = window.PIXI;
        if (PIXI._app || PIXI.app) {
          pixiApp = PIXI._app || PIXI.app; return capture();
        }
      }
  
      return null;
    }
  
    // Walk a known stage root from outside (used by eval probe).
    function attachStage(s) {
      if (!s) return false;
      pixiApp = pixiApp || { stage: s, renderer: null };
      stage = s;
      return true;
    }
  
    function capture() {
      if (!pixiApp) return null;
      stage = pixiApp.stage || pixiApp.scene || null;
      renderer = pixiApp.renderer || null;
      return pixiApp;
    }
  
    // --- Tree walking ---
  
    function* walk(node, depth = 0, maxDepth = 50) {
      if (!node || depth > maxDepth) return;
      yield { node, depth };
      const children = node.children;
      if (Array.isArray(children)) {
        for (const c of children) yield* walk(c, depth + 1, maxDepth);
      }
    }
  
    function describeNode(n) {
      const tex = n.texture;
      let texIds = null;
      if (tex && tex.textureCacheIds) texIds = tex.textureCacheIds.slice(0, 3);
      else if (tex && tex.baseTexture && tex.baseTexture.cacheId) texIds = [tex.baseTexture.cacheId];
      let worldPos = null;
      try {
        if (n.worldTransform) worldPos = [Math.round(n.worldTransform.tx), Math.round(n.worldTransform.ty)];
        else if (n.x !== undefined) worldPos = [Math.round(n.x), Math.round(n.y)];
      } catch (e) {}
      return {
        type: n.constructor && n.constructor.name,
        name: n.name || null,
        visible: n.visible !== false,
        worldVisible: n.worldVisible !== false,
        interactive: !!n.interactive,
        worldPos,
        texIds,
        childCount: (n.children && n.children.length) || 0,
        width: n.width !== undefined ? Math.round(n.width) : null,
        height: n.height !== undefined ? Math.round(n.height) : null,
      };
    }
  
    function summarize(maxNodes = 200) {
      discover();
      if (!stage) return { error: 'no PIXI stage found', tried: 'globals + .stage walk + PIXI namespace' };
      const nodes = [];
      let n = 0;
      for (const { node, depth } of walk(stage)) {
        if (n++ >= maxNodes) break;
        nodes.push({ depth, ...describeNode(node) });
      }
      return { nodeCount: n, sample: nodes };
    }
  
    // Find nodes whose texture id contains any of the given substrings.
    function findByTexture(...substrings) {
      discover();
      if (!stage) return [];
      const matches = [];
      for (const { node, depth } of walk(stage)) {
        const tex = node.texture;
        let ids = [];
        if (tex && tex.textureCacheIds) ids = tex.textureCacheIds;
        else if (tex && tex.baseTexture && tex.baseTexture.cacheId) ids = [tex.baseTexture.cacheId];
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          if (substrings.some(s => id.toLowerCase().includes(s.toLowerCase()))) {
            matches.push({ depth, ...describeNode(node) });
            break;
          }
        }
      }
      return matches;
    }
  
    // Find unique texture ids across the tree (helps identify sprite assets).
    function listTextures(limit = 100) {
      discover();
      if (!stage) return [];
      const seen = new Set();
      for (const { node } of walk(stage)) {
        const tex = node.texture;
        if (tex && tex.textureCacheIds) tex.textureCacheIds.forEach(id => seen.add(id));
        else if (tex && tex.baseTexture && tex.baseTexture.cacheId) seen.add(tex.baseTexture.cacheId);
        if (seen.size > limit) break;
      }
      return Array.from(seen);
    }
  
    return {
      discover,
      isReady() { return !!stage; },
      getApp() { return pixiApp; },
      getStage() { return stage; },
      getRenderer() { return renderer; },
      summarize,
      findByTexture,
      listTextures,
      describeNode,
      attachStage,
      walk,
    };
  })();
  }
  

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
          case 'getCfg':       value = HC_CFG; break;
          case 'setCfg':       Object.assign(HC_CFG, args[0]); value = HC_CFG; break;
          // ── PIXI scene-graph probes ──
          case 'eval': {
            // Debug-only: evaluate arbitrary JS in iframe context. Returns serializable result.
            // The arg is a string that will be wrapped in (function(){ return ... })().
            const fn = new Function('HC_Scene', 'HC_Capture', 'HC_Vision', 'HC_Clicker', 'HC_Visit', 'HC_CFG', args[0]);
            value = await Promise.resolve(fn(window.HC_Scene, window.HC_Capture, window.HC_Vision, window.HC_Clicker, window.HC_Visit, window.HC_CFG));
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
          case 'visitSweep':   value = HC_Visit ? await HC_Visit.sweepOnce() : 'no HC_Visit'; break;
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
