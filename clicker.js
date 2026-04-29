// Hedgehog Smart Collector (Ёжики) - Vision-based Auto-Clicker
// Built: 2026-04-29
//
// HOW TO USE:
// 1. Open the game at https://vk.com/ezhiky_game
// 2. Press F12 → Console tab
// 3. Switch context from "top" to "valley.redspell.ru" iframe
// 4. Paste this script and press Enter
//
// CONTROLS: F2 = toggle on/off

(function() {
  "use strict";

  // Cleanup
  const old = document.getElementById("hc-panel");
  if (old) old.remove();
  if (window.__hcTimer) clearTimeout(window.__hcTimer);

  const canvas = document.querySelector("canvas");
  if (!canvas) { console.error("[HC] No canvas!"); return; }

  // ═══ glspy.js ═══
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
  

  // ═══ network.js ═══
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
    let totalOk = 0, totalErr = 0, totalSeen = 0, totalTick = 0, total200 = 0;
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
            let ok = false, tick = false, http200 = false;
            let envelope = null;
            let respBytes = null;
            try { http200 = this.status === 200; } catch (e) {}
            try {
              if (this.response instanceof ArrayBuffer) {
                respBytes = Array.from(new Uint8Array(this.response));
                // Envelope discrimination: 0x50 0x00 ('P\0') = click-acknowledged
                // (action produced state change — friend-farm collects). 0x30 0x00
                // ('0\0') = background tick (no action). Both are HTTP 200.
                if (respBytes.length >= 2 && respBytes[1] === 0x00) {
                  if (respBytes[0] === 0x50)      { ok = true;   envelope = 'P'; }
                  else if (respBytes[0] === 0x30) { tick = true; envelope = '0'; }
                  else                            { envelope = String.fromCharCode(respBytes[0]); }
                }
              }
            } catch (e) {}
            if (http200) total200++;
            if (ok)        { totalOk++;   lastOkAt  = lastResponseAt; }
            else if (tick) { totalTick++; }
            else           { totalErr++;  lastErrAt = lastResponseAt; }
            pushRing({
              url: reqUrl,
              reqAt, respAt: lastResponseAt,
              ok, tick, http200, envelope,
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
  
    // ── Farm-load packet parser ──
    // Per doc 06: each object record is laid out as
    //   [int32 z=-13][int32 ?][uint16 N][N ASCII type][0x00][0x06 0x01]
    //   [4 entity_id][4 fingerprint=0x41DA7BCA][0x00][world_x][world_y][?][?]
    // Total stride = 26 + N bytes. The trailing 4-byte field reads cleanly as
    // (uint8 x, uint8 y) in world tile coords (X 6–250, Y 0–~100).
    //
    // Strategy: scan for length-prefixed printable strings whose surrounding
    // bytes match the flag/fingerprint pattern. Robust against header drift,
    // intermediate stray bytes, and variant record types we haven't seen.
    const FINGERPRINT = [0xCA, 0x7B, 0xDA, 0x41]; // little-endian 0x41DA7BCA
    const TYPE_RE = /^[a-z]{2,3}_[a-z][a-z0-9_]+$/;
  
    function parseFarmLoad(bytes) {
      if (!bytes || bytes.length < 64) return [];
      const out = [];
      const seenIds = new Set();
      // Records start with a uint16 length prefix at offset 8 in the record;
      // we scan the buffer for that prefix + ASCII string + flag bytes.
      const N = bytes.length;
      for (let i = 8; i < N - 30; i++) {
        const len = bytes[i] | (bytes[i + 1] << 8);
        if (len < 4 || len > 32) continue;
        const strStart = i + 2;
        const strEnd = strStart + len;
        if (strEnd + 16 > N) continue;
  
        // Cheap structural check before reading the string: flag bytes must
        // match. This filters out the vast majority of false positives.
        if (bytes[strEnd] !== 0x00) continue;
        if (bytes[strEnd + 1] !== 0x06 || bytes[strEnd + 2] !== 0x01) continue;
        // Fingerprint at strEnd + 7..10
        if (bytes[strEnd + 7]  !== FINGERPRINT[0]) continue;
        if (bytes[strEnd + 8]  !== FINGERPRINT[1]) continue;
        if (bytes[strEnd + 9]  !== FINGERPRINT[2]) continue;
        if (bytes[strEnd + 10] !== FINGERPRINT[3]) continue;
  
        // Now check ASCII string
        let ok = true, s = '';
        for (let j = 0; j < len; j++) {
          const c = bytes[strStart + j];
          if (c < 0x20 || c > 0x7e) { ok = false; break; }
          s += String.fromCharCode(c);
        }
        if (!ok || !TYPE_RE.test(s)) continue;
  
        // Entity id at strEnd + 3..6 (4 bytes — treat as opaque tuple)
        const idBytes = (bytes[strEnd + 3] << 24) | (bytes[strEnd + 4] << 16) |
                        (bytes[strEnd + 5] << 8)  |  bytes[strEnd + 6];
        const eid = idBytes >>> 0;
        if (seenIds.has(eid)) { i = strEnd + 15; continue; }
        seenIds.add(eid);
  
        // Position bytes at strEnd + 12 (x), strEnd + 13 (y)
        const wx = bytes[strEnd + 12];
        const wy = bytes[strEnd + 13];
        const wx2 = bytes[strEnd + 14]; // high byte of x for big maps (usually 0)
        const wy2 = bytes[strEnd + 15];
  
        out.push({ type: s, x: wx | (wx2 << 8), y: wy | (wy2 << 8), eid, off: i });
        i = strEnd + 15; // skip past this record
      }
      return out;
    }
  
    // Collectible type prefixes (per doc 06). tl_/dc_/ga_ are decoration.
    const COLLECTIBLE_PREFIXES = ['te_', 'sb_', 'pl_', 'pi_', 'fl_'];
    function isCollectible(type, prefixes) {
      const p = prefixes || COLLECTIBLE_PREFIXES;
      for (let i = 0; i < p.length; i++) if (type.indexOf(p[i]) === 0) return true;
      return false;
    }
  
    // Find the most recent large /proto.html response (the farm-load) and
    // parse it. Returns { found, count, objects, source: {seq, respLen} }.
    // opts: { collectiblesOnly: bool, prefixes: string[], minRespLen: number }
    function lastFarmObjects(opts) {
      opts = opts || {};
      const minLen = opts.minRespLen || 8000; // farm-load is ~67KB; tick polls ~3KB
      let pick = null;
      for (let i = ring.length - 1; i >= 0; i--) {
        const e = ring[i];
        if (!e.ok) continue;
        if (e.respLen < minLen) continue;
        if (!e.resp) continue;
        pick = e; break;
      }
      if (!pick) return { found: false, count: 0, objects: [], source: null };
      const all = parseFarmLoad(pick.resp);
      const filtered = (opts.collectiblesOnly === false)
        ? all
        : all.filter(o => isCollectible(o.type, opts.prefixes));
      return {
        found: true,
        count: filtered.length,
        totalRecords: all.length,
        objects: filtered,
        source: { seq: pick.seq, respLen: pick.respLen, respAt: pick.respAt },
      };
    }
  
    return {
      awaitNextResponse,
      getStats() {
        return { totalSeen, totalOk, totalErr, totalTick, total200, lastOkAt, lastErrAt, lastResponseAt, ringLen: ring.length };
      },
      dump,
      clearRing,
      parseFarmLoad,
      lastFarmObjects,
      isCollectible,
      // Cheap "did anything succeed in the last N ms?" — useful for a passive
      // sanity check after a known game action.
      wasRecentSuccess(sinceMs) { return Date.now() - lastOkAt < sinceMs; },
      wasRecentError(sinceMs)   { return Date.now() - lastErrAt < sinceMs; },
    };
  })();
  }
  

  // ═══ dbgclick.js ═══
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
  

  // ═══ capture.js ═══
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
  

  // ═══ scenegraph.js ═══
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
  

  // ═══ overlay.js ═══
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
  

  // ═══ visit.js ═══
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
                               // Background tiles also return 0x80 OK so the
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
      sweepMode:        'auto',
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
      stats.hits += gained;
      stats.lastResult = 'parsed' + list.length + '+' + gained;
      return gained;
    }
  
    async function runSweep(forStop) {
      if (VCFG.sweepMode === 'grid') return farmPass(forStop);
      if (VCFG.sweepMode === 'parsed') {
        const g = await parsedPass(forStop);
        return g == null ? 0 : g;
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
  
    // We're "in a farm" if HC_Net has parsed a farm-load XHR more recent than
    // `sinceSeq`. Returns the new seq (or null if no farm-load yet).
    function lastFarmSeq() {
      const r = net.lastFarmObjects({ collectiblesOnly: false });
      return r.found && r.source ? r.source.seq : null;
    }
  
    async function awaitFarmLoad(timeoutMs, sinceSeq) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const s = lastFarmSeq();
        if (s != null && s !== sinceSeq) return s;
        await sleep(120);
      }
      return null;
    }
  
    async function enterFarmFromHub() {
      const startSeq = lastFarmSeq();
      log('enterFarmFromHub: startSeq=' + startSeq + ' probeCount=' + HUB_PROBES.length);
      let attempts = 0;
      for (const p of HUB_PROBES) {
        if (!running) { log('enterFarmFromHub aborted: running=false'); break; }
        if (attempts >= VCFG.maxHubAttempts) { log('enterFarmFromHub: hit maxHubAttempts'); break; }
        attempts++;
        log('hub probe #' + attempts + ' @ canvas (' + p.x + ',' + p.y + ')');
        click(p.x, p.y);
        const newSeq = await awaitFarmLoad(VCFG.hubProbeTimeout, startSeq);
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
      log('loop start: lastFarmSeq=' + lastFarmSeq() + ' BTN.next=(' + BTN.next.x + ',' + BTN.next.y + ')');
  
      if (lastFarmSeq() == null) {
        log('Not inside a farm — bootstrapping via hub probe');
        if (!(await enterFarmFromHub())) {
          log('STOP: bootstrap failed');
          running = false;
          return;
        }
      } else {
        log('Already in a farm — skipping hub bootstrap');
      }
  
      while (running) {
        const seqBeforeSweep = lastFarmSeq();
        log('--- pass ' + (stats.passes + 1) + ' starting (seq=' + seqBeforeSweep + ') ---');
        const gained = await runSweep(true);
        stats.passes++;
        log('sweep done: gained=' + gained + ' totalAttempts=' + stats.attempts + ' clickFails=' + clickFails);
  
        // Try multiple advance candidates: the popup-center Далее (only present
        // when the farm is fully exhausted) AND the bottom-left Далее (always
        // present once any collection happened). Whichever one actually exists
        // will produce the farm-load XHR; the other is a no-op.
        const advanced = await tryAdvance(seqBeforeSweep);
        stats.farms++;
  
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
        const newSeq = await awaitFarmLoad(VCFG.advanceWait, seqBefore);
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
  

  // ═══ ui.js ═══
  // ── UI Panel ──
  // Visit-loop control surface. Smart-mode pixel detection was removed when
  // HC_Capture stopped being a frame-capture hook (see doc/01-pixel-capture-attempt.md);
  // HC_Visit now drives the game via grid sweeps + chrome.debugger trusted clicks.
  
  window.HC_UI = (function() {
    const cap = window.HC_Capture;
    const visit = window.HC_Visit;
    const canvas = cap.canvas;
  
    const old = document.getElementById('hc-panel');
    if (old) old.remove();
  
    const panel = document.createElement('div');
    panel.id = 'hc-panel';
    panel.innerHTML = `
      <style>
        #hc-panel{position:fixed;top:10px;right:10px;width:340px;background:rgba(18,18,18,.96);color:#eee;border-radius:12px;font-family:Arial,sans-serif;font-size:13px;z-index:999999;box-shadow:0 4px 24px rgba(0,0,0,.7);user-select:none;border:1px solid rgba(255,255,255,.08)}
        #hc-hdr{background:linear-gradient(135deg,#6a3093,#4a1068);padding:8px 12px;border-radius:12px 12px 0 0;cursor:move;display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-size:14px}
        #hc-body{padding:10px 12px}
        #hc-st{text-align:center;padding:6px;margin-bottom:8px;border-radius:6px;font-weight:bold}
        .hb{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;color:#fff;flex:1;text-align:center}.hb:hover{opacity:.85}
        .hbs{display:flex;gap:5px;margin-top:5px}
        .g{background:#2d7a3a}.r{background:#c0392b}.b{background:#2980b9}.p{background:#6a3093}.o{background:#e67e22}
        .sep{border-top:1px solid rgba(255,255,255,.06);margin:7px 0}
        #hc-stats{font-size:11px;color:#b388ff;margin-top:4px;line-height:1.4}
        #hc-diag{font-size:10px;color:#aaa;margin-top:4px;line-height:1.3}
        #hc-log{font-family:Consolas,monospace;font-size:10px;color:#9fd4ff;background:rgba(0,0,0,.4);border-radius:4px;padding:6px;margin-top:5px;height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
      </style>
      <div id="hc-hdr"><span>Hedgehog Vision</span><span id="hc-min" style="cursor:pointer;font-size:18px">-</span></div>
      <div id="hc-body">
        <div id="hc-st">STOPPED</div>
        <div class="hbs">
          <button class="hb g" id="hc-tog">START Visit (F2)</button>
        </div>
        <div class="hbs">
          <button class="hb o" id="hc-sweep" style="font-size:11px">Sweep Once</button>
          <button class="hb p" id="hc-hub" style="font-size:11px">Enter Hub Farm</button>
        </div>
        <div class="hbs">
          <button class="hb b" id="hc-pick-next" style="font-size:11px">Set Далее Btn</button>
          <button class="hb b" id="hc-pick-home" style="font-size:11px">Set Выйти Btn</button>
          <button class="hb b" id="hc-pick-popup" style="font-size:11px">Set Popup Далее</button>
        </div>
        <div class="hbs">
          <button class="hb b" id="hc-probe" style="font-size:11px">Probe DbgClick</button>
          <button class="hb b" id="hc-clear-log" style="font-size:11px">Clear Log</button>
        </div>
        <div class="sep"></div>
        <div id="hc-stats">Idle.</div>
        <div id="hc-diag">—</div>
        <div id="hc-log">no log yet — click START to begin</div>
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
  
    // ── Buttons ──
    document.getElementById('hc-tog').addEventListener('click', () => {
      console.log('[HC_UI] START button clicked, visit.isRunning=' + visit.isRunning());
      visit.toggle();
      updateUI();
    });
    document.getElementById('hc-sweep').addEventListener('click', () => {
      console.log('[HC_UI] Sweep Once clicked');
      visit.sweepOnce(false).then(updateUI);
    });
    document.getElementById('hc-hub').addEventListener('click', () => {
      console.log('[HC_UI] Enter Hub Farm clicked');
      visit.enterFarmFromHub().then(ok => console.log('[HC_UI] hub entry result:', ok));
    });
    document.getElementById('hc-probe').addEventListener('click', () => {
      if (!window.HC_DbgClick) { console.warn('no HC_DbgClick'); return; }
      window.HC_DbgClick.probe().then(r => {
        console.log('[HC_UI] DbgClick probe:', r);
        const diag = document.getElementById('hc-diag');
        diag.textContent = 'Probe: ' + (r && r.resp ? ('ok=' + r.resp.ok + (r.resp.error ? ' err=' + r.resp.error : '')) : (r && r.timeout ? 'TIMEOUT' : JSON.stringify(r)));
      });
    });
    document.getElementById('hc-clear-log').addEventListener('click', () => {
      visit.clearLog();
      document.getElementById('hc-log').textContent = '';
    });
  
    // ── Calibrators: click-to-pick canvas coords for advance buttons ──
    function pickCoord(setter, label, btnId) {
      let armed = false;
      const btn = document.getElementById(btnId);
      btn.addEventListener('click', () => {
        armed = true;
        btn.textContent = 'Click ' + label + '...';
        btn.className = 'hb o';
      });
      canvas.addEventListener('click', e => {
        if (!armed) return;
        const rect = canvas.getBoundingClientRect();
        const tx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
        const ty = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
        setter(tx, ty);
        armed = false;
        btn.textContent = label + '(' + tx + ',' + ty + ')';
        btn.className = 'hb b';
      }, true);
    }
    pickCoord((x, y) => visit.setNextBtn(x, y), 'Далее', 'hc-pick-next');
    pickCoord((x, y) => visit.setHomeBtn(x, y), 'Выйти', 'hc-pick-home');
    pickCoord((x, y) => visit.setPopupNextBtn(x, y), 'Popup', 'hc-pick-popup');
  
    // ── F2 hotkey ──
    document.addEventListener('keydown', e => {
      if (e.key === 'F2') { e.preventDefault(); visit.toggle(); updateUI(); }
    });
  
    function updateUI() {
      const st = document.getElementById('hc-st'), btn = document.getElementById('hc-tog');
      const r = visit.isRunning();
      const s = visit.getStats();
      const cc = visit.getClickCounters();
      if (r) {
        st.textContent = 'RUNNING'; st.style.background = 'rgba(106,48,147,.5)'; st.style.color = '#b388ff';
        btn.textContent = 'STOP Visit (F2)'; btn.className = 'hb r';
      } else {
        st.textContent = 'STOPPED'; st.style.background = 'rgba(192,57,43,.3)'; st.style.color = '#ff6b6b';
        btn.textContent = 'START Visit (F2)'; btn.className = 'hb g';
      }
      document.getElementById('hc-stats').textContent =
        'Passes: ' + s.passes + ' | Hits: ' + s.hits + ' | Attempts: ' + s.attempts +
        ' | Farms: ' + s.farms + (s.lastResult ? ' | Last: ' + s.lastResult : '');
      const dbg = window.HC_DbgClick;
      const net = window.HC_Net && window.HC_Net.getStats();
      document.getElementById('hc-diag').textContent =
        'DbgClick: ' + (dbg ? ('avail=' + dbg.isAvailable() + ' clicks=' + cc.clicks + ' fails=' + cc.fails) : 'MISSING') +
        ' | Net: ' + (net ? ('seen=' + net.totalSeen + ' ok=' + net.totalOk + ' err=' + net.totalErr) : 'MISSING');
      const logEl = document.getElementById('hc-log');
      const lines = visit.getLog();
      if (lines.length) {
        const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 5;
        logEl.textContent = lines.join('\n');
        if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
      }
    }
  
    setInterval(updateUI, 500);
    updateUI();
    return { updateUI };
  })();
  

  // ── Init ──
    console.log('[HC] Hedgehog Vision loaded! Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
    console.log('[HC] Press F2 or START to begin.');
})();
