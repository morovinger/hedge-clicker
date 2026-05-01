// Hedgehog Clicker — Chrome extension content script (auto-injected into game iframe)
// Built: 2026-05-01
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
    let totalOk = 0, totalErr = 0, totalSeen = 0, totalTick = 0, total200 = 0;
    let totalLoad = 0; // server-push / state-load envelope ('\x05\x00')
    let lastOkAt = 0, lastErrAt = 0, lastResponseAt = 0, lastLoadAt = 0;
  
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
          const reqMethod = this.__hcMethod || 'POST';
          this.addEventListener('load', () => {
            totalSeen++;
            lastResponseAt = Date.now();
            let ok = false, tick = false, load = false, http200 = false;
            let envelope = null;
            let respBytes = null;
            try { http200 = this.status === 200; } catch (e) {}
            try {
              if (this.response instanceof ArrayBuffer) {
                respBytes = Array.from(new Uint8Array(this.response));
                // Envelope discrimination (3 known kinds, all HTTP 200):
                //   0x50 0x00 ('P\0')  click-acknowledged (collect action) →  ok
                //   0x30 0x00 ('0\0')  background heartbeat / idle tick    →  tick
                //   0x05 0x00 (\x05\0) server state push (initial session
                //                       load AND friend-farm load XHR — hub
                //                       probes returning a 594KB body land here)
                //                                                           →  load
                if (respBytes.length >= 2 && respBytes[1] === 0x00) {
                  if (respBytes[0] === 0x50)      { ok = true;   envelope = 'P'; }
                  else if (respBytes[0] === 0x30) { tick = true; envelope = '0'; }
                  else if (respBytes[0] === 0x05) { load = true; envelope = '\\x05'; }
                  else                            { envelope = String.fromCharCode(respBytes[0]); }
                }
              }
            } catch (e) {}
            if (http200) total200++;
            if (ok)        { totalOk++;   lastOkAt   = lastResponseAt; }
            else if (tick) { totalTick++; }
            else if (load) { totalLoad++; lastLoadAt = lastResponseAt; }
            else           { totalErr++;  lastErrAt  = lastResponseAt; }
            pushRing({
              url: reqUrl,
              method: reqMethod,
              reqAt, respAt: lastResponseAt,
              ok, tick, load, http200, envelope,
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
  
    // Cheap "is there a friend-farm load in the ring, and what's its seq?" —
    // no packet parsing. opts: { minRespLen, maxRespLen }. Returns null if none.
    //
    // Envelope: friend-farm-load is the server-push envelope (`\x05\x00`,
    // classified as `load`). Older builds keyed on `e.ok` and missed every
    // farm-load — accept `load || ok`.
    //
    // Size: a fresh page load drops a HUGE (~1.77 MB) state-init payload that
    // is ALSO an `\x05\x00` envelope. It's not a friend-farm; it's the user's
    // session/hub bundle. If we counted it, the visit loop would skip its
    // hub-bootstrap and try to sweep the hub view. Cap at maxRespLen (default
    // 1.5 MB — friend farms observed at ~594 KB) to filter the init out.
    function lastFarmLoadSeq(opts) {
      opts = opts || {};
      const minLen = opts.minRespLen || 8000;
      const maxLen = opts.maxRespLen || 1500000;
      for (let i = ring.length - 1; i >= 0; i--) {
        const e = ring[i];
        if (!(e.load || e.ok)) continue;
        if (e.respLen < minLen || e.respLen > maxLen) continue;
        if (!e.resp) continue;
        return e.seq;
      }
      return null;
    }
  
    // Wait up to opts.timeoutMs (default 1500) for a farm-load XHR with seq
    // strictly greater than opts.afterSeq. Returns the new seq or null on
    // timeout. If afterSeq is omitted, uses the current lastFarmLoadSeq().
    async function awaitNextFarmLoad(opts) {
      opts = opts || {};
      const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 1500;
      const afterSeq = opts.afterSeq != null ? opts.afterSeq : lastFarmLoadSeq();
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const s = lastFarmLoadSeq();
        if (s != null && s !== afterSeq) return s;
        await new Promise(r => setTimeout(r, 120));
      }
      return null;
    }
  
    // Find the most recent large /proto.html response (the farm-load) and
    // parse it. Returns { found, count, objects, source: {seq, respLen} }.
    // opts: { collectiblesOnly: bool, prefixes: string[], minRespLen: number }
    function lastFarmObjects(opts) {
      opts = opts || {};
      const minLen = opts.minRespLen || 8000;     // farm-load is ~67–594KB; tick polls ~3KB
      const maxLen = opts.maxRespLen || 1500000;  // exclude the 1.77 MB init payload (see lastFarmLoadSeq)
      let pick = null;
      for (let i = ring.length - 1; i >= 0; i--) {
        const e = ring[i];
        // Farm-load is the server-push envelope (load=true). Older builds also
        // saw it via the action-ack path on some calls, so accept ok=true too.
        if (!(e.load || e.ok)) continue;
        if (e.respLen < minLen || e.respLen > maxLen) continue;
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
  
    // ── Click-response (collect-action) parser ──
    // Every P\0 (action-ok) response carries the *server-side delta* for that
    // click. Format observed (n=32, 2026-05-01 session, ra_leaf / ra_bark /
    // ra_maple_syrup samples — all ~56–71 bytes):
    //   50 00                 envelope
    //   04 3d 00              fixed sub-header
    //   <uint32 LE inner-len> bytes that follow excluding the leading 9
    //   <uint16 LE recCount>
    //   recCount × {
    //     <uint16 LE name-len>
    //     <name-len ASCII bytes>      e.g. "Exp" "Coins" "Energy" "ra_leaf"
    //     <uint32 LE value>           positive integer; counter delta
    //   }
    // Resource records are the `ra_*` (or non-Exp/Coins/Energy) names — those
    // are the tangible loot. Exp/Coins/Energy show up on every collect.
    // When the backpack fills up (or the cell is empty) the server may still
    // return P\0 but with NO ra_* record — that's the signal we want.
    const META_NAMES = new Set(['Exp', 'Coins', 'Energy']);
  
    function parseCollectResp(bytes) {
      if (!bytes || bytes.length < 11) return null;
      if (bytes[0] !== 0x50 || bytes[1] !== 0x00) return null; // not a P\0 ack
      let i = 2;
      // Skip 3-byte sub-header (04 3d 00) — tolerated, not validated, in case
      // the server tweaks middle bytes.
      i += 3;
      // inner-len (uint32 LE) — for sanity only
      if (i + 4 > bytes.length) return null;
      const innerLen = bytes[i] | (bytes[i+1]<<8) | (bytes[i+2]<<16) | (bytes[i+3]<<24);
      i += 4;
      if (i + 2 > bytes.length) return null;
      const recCount = bytes[i] | (bytes[i+1]<<8);
      i += 2;
      const records = [];
      for (let r = 0; r < recCount; r++) {
        if (i + 2 > bytes.length) break;
        const nameLen = bytes[i] | (bytes[i+1]<<8);
        i += 2;
        if (i + nameLen + 4 > bytes.length) break;
        let name = '';
        for (let j = 0; j < nameLen; j++) name += String.fromCharCode(bytes[i + j]);
        i += nameLen;
        const value = bytes[i] | (bytes[i+1]<<8) | (bytes[i+2]<<16) | (bytes[i+3]<<24);
        i += 4;
        records.push({ name, value });
      }
      const resources = records.filter(r => !META_NAMES.has(r.name));
      return { recCount, records, resources, innerLen };
    }
  
    // Aggregate parseCollectResp across the recent click responses. Useful
    // signal for the visit loop: "did this sweep collect any ra_* items?"
    // opts: { sinceMs?: number, sinceSeq?: number }
    function lastCollectStats(opts) {
      opts = opts || {};
      const sinceTs = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
      const sinceSeq = opts.sinceSeq != null ? opts.sinceSeq : 0;
      let acks = 0, withResources = 0, withoutResources = 0;
      const totals = {}; // name → summed value
      let last = null;
      for (const e of ring) {
        if (!e.ok) continue;
        if (e.respAt < sinceTs) continue;
        if (e.seq <= sinceSeq) continue;
        if (!e.resp) continue;
        const p = parseCollectResp(e.resp);
        if (!p) continue;
        acks++;
        if (p.resources.length) withResources++; else withoutResources++;
        for (const r of p.records) totals[r.name] = (totals[r.name] || 0) + r.value;
        last = { seq: e.seq, respAt: e.respAt, records: p.records };
      }
      const resourceItems = Object.entries(totals)
        .filter(([n]) => !META_NAMES.has(n))
        .reduce((s, [, v]) => s + v, 0);
      return {
        acks, withResources, withoutResources,
        totals, resourceItems,
        last,
      };
    }
  
    // ── Endpoint-debugging helpers ──
    // The replay path (resend a captured Далее /proto.html POST) keeps failing
    // with `00 00 00 3d 00 13`. To diagnose we need to see the URL query
    // params, the body opcode, and what differs between two consecutive
    // successful Далее requests. These helpers are pure inspection + a
    // controlled replay tool.
  
    function _entryBySeq(s) {
      for (let i = ring.length - 1; i >= 0; i--) if (ring[i].seq === s) return ring[i];
      return null;
    }
  
    function _hex(bytes, n) {
      if (!bytes) return '';
      const lim = Math.min(bytes.length, n != null ? n : bytes.length);
      let s = '';
      for (let i = 0; i < lim; i++) {
        s += (bytes[i] < 0x10 ? '0' : '') + bytes[i].toString(16);
        if (i % 2 === 1) s += ' ';
      }
      return s.trim();
    }
  
    function _ascii(bytes, n) {
      if (!bytes) return '';
      const lim = Math.min(bytes.length, n != null ? n : bytes.length);
      let s = '';
      for (let i = 0; i < lim; i++) {
        const c = bytes[i];
        s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
      }
      return s;
    }
  
    function _parseUrl(url) {
      if (!url) return { path: null, params: {} };
      const q = url.indexOf('?');
      const path = q < 0 ? url : url.slice(0, q);
      const params = {};
      if (q >= 0) {
        const tail = url.slice(q + 1);
        for (const part of tail.split('&')) {
          const eq = part.indexOf('=');
          if (eq < 0) params[decodeURIComponent(part)] = '';
          else params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
        }
      }
      return { path, params };
    }
  
    // Pretty-dump one entry. Pass a seq, an entry, or omit for newest.
    function describe(arg) {
      let e = null;
      if (arg == null) e = ring[ring.length - 1];
      else if (typeof arg === 'number') e = _entryBySeq(arg);
      else e = arg;
      if (!e) return null;
      const u = _parseUrl(e.url);
      return {
        seq: e.seq,
        url: { path: u.path, params: u.params, raw: e.url },
        env: e.envelope, ok: e.ok, tick: e.tick, load: e.load, http200: e.http200,
        reqLen: e.reqLen, respLen: e.respLen,
        reqHex:   _hex(e.req,  Math.min(e.reqLen, 64)),
        reqAscii: _ascii(e.req, Math.min(e.reqLen, 64)),
        respHex:  _hex(e.resp, Math.min(e.respLen, 64)),
        respAscii:_ascii(e.resp, Math.min(e.respLen, 64)),
        reqAt: e.reqAt, respAt: e.respAt,
      };
    }
  
    // Filter the ring. opts:
    //   sinceMs        — only entries within last N ms
    //   urlContains    — substring match on full URL
    //   envelope       — 'P' | '0' | '\\x05' | etc
    //   ok / tick / load / err — booleans (combine via OR)
    //   reqLenMin / reqLenMax
    //   respLenMin / respLenMax
    //   reqStartsWith  — array of bytes the request body must start with
    // Returns descriptors (no raw bytes) by default; pass withBytes:true for full.
    function findRequests(opts) {
      opts = opts || {};
      const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
      const out = [];
      for (const e of ring) {
        if (e.respAt < since) continue;
        if (opts.urlContains && (!e.url || e.url.indexOf(opts.urlContains) < 0)) continue;
        if (opts.envelope && e.envelope !== opts.envelope) continue;
        if (opts.reqLenMin != null && e.reqLen < opts.reqLenMin) continue;
        if (opts.reqLenMax != null && e.reqLen > opts.reqLenMax) continue;
        if (opts.respLenMin != null && e.respLen < opts.respLenMin) continue;
        if (opts.respLenMax != null && e.respLen > opts.respLenMax) continue;
        // boolean OR set
        const wantOk = opts.ok, wantTick = opts.tick, wantLoad = opts.load, wantErr = opts.err;
        if (wantOk != null || wantTick != null || wantLoad != null || wantErr != null) {
          let any = false;
          if (wantOk && e.ok) any = true;
          if (wantTick && e.tick) any = true;
          if (wantLoad && e.load) any = true;
          if (wantErr && !e.ok && !e.tick && !e.load) any = true;
          if (!any) continue;
        }
        if (opts.reqStartsWith && e.req) {
          let match = true;
          for (let i = 0; i < opts.reqStartsWith.length; i++) {
            if (e.req[i] !== opts.reqStartsWith[i]) { match = false; break; }
          }
          if (!match) continue;
        }
        out.push(opts.withBytes ? e : describe(e));
      }
      return out;
    }
  
    // Group recent requests by their (envelope, first 4 req bytes) — a quick
    // way to find rare opcodes (Далее should appear once per farm advance,
    // collect actions appear constantly, ticks dominate everything else).
    function summarize(opts) {
      opts = opts || {};
      const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
      const buckets = {};
      for (const e of ring) {
        if (e.respAt < since) continue;
        const prefix = e.req && e.req.length >= 4
          ? _hex(e.req.slice(0, 4))
          : '(no-body)';
        const key = (e.envelope || '?') + ' | reqPrefix=' + prefix + ' | reqLen=' + e.reqLen;
        const b = buckets[key] || (buckets[key] = { count: 0, env: e.envelope, reqLen: e.reqLen, prefix, lastSeq: 0, lastRespLen: 0 });
        b.count++;
        if (e.seq > b.lastSeq) { b.lastSeq = e.seq; b.lastRespLen = e.respLen; }
      }
      return Object.entries(buckets)
        .map(([k, v]) => Object.assign({ key: k }, v))
        .sort((a, b) => a.count - b.count); // rare opcodes first — Далее candidate
    }
  
    // Byte-level diff of two requests' bodies + URL params. Useful to spot
    // request_id format, monotonic counters, embedded sequence numbers.
    function diff(seqA, seqB) {
      const a = _entryBySeq(seqA), b = _entryBySeq(seqB);
      if (!a || !b) return { error: 'one or both seqs not in ring' };
      const ua = _parseUrl(a.url), ub = _parseUrl(b.url);
      const urlDiff = { path: ua.path === ub.path ? null : [ua.path, ub.path], params: {} };
      const allKeys = new Set([...Object.keys(ua.params), ...Object.keys(ub.params)]);
      for (const k of allKeys) {
        if (ua.params[k] !== ub.params[k]) urlDiff.params[k] = [ua.params[k], ub.params[k]];
      }
      const bodyDiff = [];
      const aBody = a.req || [], bBody = b.req || [];
      const max = Math.max(aBody.length, bBody.length);
      for (let i = 0; i < max; i++) {
        if (aBody[i] !== bBody[i]) bodyDiff.push({ off: i, a: aBody[i], b: bBody[i] });
      }
      return {
        seqs: [seqA, seqB],
        urlDiff,
        reqLen: [aBody.length, bBody.length],
        bodyDiff: bodyDiff.slice(0, 64),
        bodyDiffCount: bodyDiff.length,
        respLen: [a.respLen, b.respLen],
        respEnv: [a.envelope, b.envelope],
      };
    }
  
    // Replay a captured request. opts:
    //   urlMutate(urlObj) → urlObj  // mutate {path, params, raw}
    //   bodyMutate(bytes) → bytes   // mutate request body bytes
    //   responseType: default 'arraybuffer'
    // Returns a Promise<{status, respLen, respHex, respAscii, envelope, ok, tick, load}>
    function replay(seq, opts) {
      opts = opts || {};
      const e = _entryBySeq(seq);
      if (!e) return Promise.resolve({ error: 'seq not in ring: ' + seq });
      if (!e.req) return Promise.resolve({ error: 'no captured req body' });
      let url = e.url;
      if (typeof opts.urlMutate === 'function') {
        const u = _parseUrl(e.url);
        const mutated = opts.urlMutate({ path: u.path, params: Object.assign({}, u.params), raw: e.url });
        if (typeof mutated === 'string') {
          url = mutated;
        } else if (mutated && mutated.path) {
          const qs = Object.entries(mutated.params || {}).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
          url = mutated.path + (qs ? '?' + qs : '');
        }
      }
      let body = e.req.slice();
      if (typeof opts.bodyMutate === 'function') {
        const m = opts.bodyMutate(body);
        if (Array.isArray(m) || (m && m.length != null)) body = Array.from(m);
      }
      const buf = new Uint8Array(body).buffer;
      return new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open(e.method || 'POST', url, true);
        x.responseType = opts.responseType || 'arraybuffer';
        x.onload = function() {
          let respBytes = null;
          try { respBytes = x.response instanceof ArrayBuffer ? Array.from(new Uint8Array(x.response)) : null; } catch(_) {}
          let envelope = null, ok = false, tick = false, load = false;
          if (respBytes && respBytes.length >= 2 && respBytes[1] === 0x00) {
            if (respBytes[0] === 0x50)      { ok = true;   envelope = 'P'; }
            else if (respBytes[0] === 0x30) { tick = true; envelope = '0'; }
            else if (respBytes[0] === 0x05) { load = true; envelope = '\\x05'; }
            else                            { envelope = String.fromCharCode(respBytes[0]); }
          }
          resolve({
            status: x.status,
            respLen: respBytes ? respBytes.length : 0,
            respHex:  respBytes ? _hex(respBytes, Math.min(respBytes.length, 64)) : '',
            respAscii: respBytes ? _ascii(respBytes, Math.min(respBytes.length, 64)) : '',
            envelope, ok, tick, load,
            urlSent: url,
            bodyLenSent: body.length,
          });
        };
        x.onerror = function() { resolve({ error: 'xhr error', status: x.status }); };
        x.send(buf);
      });
    }
  
    return {
      awaitNextResponse,
      getStats() {
        return { totalSeen, totalOk, totalErr, totalTick, totalLoad, total200, lastOkAt, lastErrAt, lastLoadAt, lastResponseAt, ringLen: ring.length };
      },
      dump,
      clearRing,
      parseFarmLoad,
      parseCollectResp,
      lastCollectStats,
      lastFarmObjects,
      lastFarmLoadSeq,
      awaitNextFarmLoad,
      isCollectible,
      // Endpoint-debugging surface
      describe,
      findRequests,
      summarize,
      diff,
      replay,
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
  // Callers pass coordinates in the iframe's own CSS viewport (canvas-pixel
  // coords, since the canvas fills the iframe at 1:1). When the iframe is
  // SAME-ORIGIN with the top page (the case for the direct
  // https://valley.redspell.ru/ entry — see memory: game_direct_url.md),
  // chrome.debugger.getTargets returns one shared page target. background.js
  // attaches to it and dispatches Input.dispatchMouseEvent in TOP-frame
  // viewport space, so we add the iframe element's getBoundingClientRect()
  // offset before sending. When the iframe is CROSS-ORIGIN (VK wrapper path)
  // the iframe gets its own debugger target, no offset is needed; we detect
  // that case by parent.document throwing.
  
  if (window.HC_DbgClick) {
    console.log('[HC] DbgClick already installed — reusing.');
  } else {
  window.HC_DbgClick = (function() {
    const pending = new Map();
    let nextId = 1;
    let available = null; // null = unknown, true/false set after first ping
  
    // Same-origin iframe → debugger target is shared with parent → coords
    // need iframe offset added. Cross-origin parent throws; that's the OOPIF
    // case where the iframe has its own debugger target and offset = 0.
    // Memoized lightly because getBoundingClientRect changes when the page
    // re-layouts (HC panel expand/collapse, window resize).
    function parentIframeOffset() {
      try {
        if (window.parent === window) return null; // top frame, no parent
        const list = window.parent.document.querySelectorAll('iframe');
        for (const f of list) {
          if (f.contentWindow === window) {
            const r = f.getBoundingClientRect();
            return { x: r.left, y: r.top };
          }
        }
      } catch (e) { /* cross-origin parent: fall through */ }
      return null;
    }
  
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
    // for debugging. x/y are iframe-CSS coords; we translate to top-frame
    // coords on the same-origin path because the debugger session is
    // attached to the shared parent target.
    function click(x, y) {
      const off = parentIframeOffset();
      if (off) { x += off.x; y += off.y; }
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
    // ═══ overlay.js (deferred) ═══
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
    

    // ═══ visit.js (deferred) ═══
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
        popupNext:{ x: 476, y: 369 }, // "Далее" inside the centered "nothing more to do" popup
                                      // (re-calibrated 2026-05-01 via the panel picker;
                                      // the old (500, 310) was a guess and missed by ~60 px,
                                      // which left the popup up and silently blocked
                                      // BTN.next clicks too. See doc 07.)
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
        maxHubAttempts:   32,    // bound probes per enterFromHub call (HUB_PROBES = 4 confirmed + 25 grid = 29)
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
      // The friends-hub renders friend-farm icons inside a central panel, not
      // across the full playfield. The original 24-point wide grid (x 200–850
      // step 130, y 220–520 step 100) missed every icon in the user's actual
      // layout — calibrated 2026-05-01 via the panel picker.
      // Strategy: try four user-confirmed icon coords first (almost certainly
      // hits one), then a tight 5×5 grid around the cluster as a fallback.
      const HUB_PROBES = [
        // Confirmed friend-icon positions (panel-picker calibration, 2026-05-01)
        { x: 408, y: 233 },
        { x: 529, y: 305 },
        { x: 544, y: 414 },
        { x: 512, y: 445 },
      ];
      for (let y = 220; y <= 460; y += 60) {
        for (let x = 380; x <= 580; x += 50) HUB_PROBES.push({ x, y });
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
    
          // Items in the response = resources DROPPED INTO PLAYER STORAGE
          // (shared across farms, capped by inventory free-space). NOT a
          // signal that the current farm has more loot.
          // If r.ackCount > 0 but r.withResources === 0, every click was a
          // "you got nothing" ack — the inventory cap is hit (or, less likely,
          // we somehow sweeped only terrain). Backpack-full is the dominant
          // cause; stop after 2 such sweeps in a row.
          if (r.ackCount > 0 && r.withResources === 0) {
            zeroCollectSweeps++;
            log('zero-resource sweep #' + zeroCollectSweeps + ' (acks=' + r.ackCount + ', items=0) — likely backpack full');
            if (zeroCollectSweeps >= 2) {
              log('STOP: 2 consecutive sweeps with no ra_* collected — backpack full');
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
      // after each. Returns true on the first that produces one.
      //
      // The Далее popup ("Здесь нам делать больше нечего, отправляемся дальше!")
      // is rendered AT THE PLAYER CHARACTER'S WORLD POSITION, which changes per
      // farm. So a fixed coord misses on most farms. Strategy:
      //   1. Try BTN.popupNext (cached from last picker / successful advance).
      //   2. Try BTN.next (bottom-left button — exists on some layouts).
      //   3. Probe-scan a small grid covering the canvas's central ~half where
      //      the popup almost always lands. First click that produces a
      //      farm-load XHR wins.
      // The scan adds ~2–10s in the worst case, vs failing the advance entirely.
      async function tryAdvance(seqBefore) {
        const candidates = [
          { name: 'popup-Далее (cached)', x: BTN.popupNext.x, y: BTN.popupNext.y },
          { name: 'btn-Далее',            x: BTN.next.x,      y: BTN.next.y      },
        ];
        for (const c of candidates) {
          if (!running) return false;
          log('trying advance: ' + c.name + ' @ (' + c.x + ',' + c.y + ')');
          click(c.x, c.y);
          const newSeq = await net.awaitNextFarmLoad({ afterSeq: seqBefore, timeoutMs: VCFG.advanceWait });
          if (newSeq != null && newSeq !== seqBefore) {
            log('advance OK via ' + c.name + ' → seq=' + newSeq);
            await sleep(600);
            return true;
          }
          log('  ' + c.name + ' produced no farm-load');
        }
    
        // Fallback popup-hunt: dense probe in the central canvas area where the
        // popup is rendered. On a hit, cache the coord so the next farm gets the
        // fast path.
        log('popup-hunt: scanning central canvas for Далее button…');
        for (let y = 200; y <= 470; y += 35) {
          for (let x = 280; x <= 720; x += 35) {
            if (!running) return false;
            click(x, y);
            const newSeq = await net.awaitNextFarmLoad({ afterSeq: seqBefore, timeoutMs: 350 });
            if (newSeq != null && newSeq !== seqBefore) {
              BTN.popupNext.x = x;
              BTN.popupNext.y = y;
              log('popup-hunt HIT @ (' + x + ',' + y + ') → seq=' + newSeq + ' — cached as BTN.popupNext');
              await sleep(600);
              return true;
            }
          }
        }
        log('popup-hunt exhausted — no advance found');
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
    

    // ═══ headless.js (deferred) ═══
    // ── HC_Headless: pure-XHR friend-farm cycle, no canvas clicks ──
    //
    // Drives the entire travel cycle (own-farm → travel-prep → friends-hub →
    // farm[0..N] → own-farm) by fabricating /proto.html POSTs directly. No
    // dependency on HC_DbgClick, no need for the game tab to be foregrounded.
    //
    // Server endpoints used (see doc/08-network-replay-and-protocol.md):
    //   5000 073d  — В путь (start travel cycle, fetch friend list)
    //   0500 013d  — enter friend farm
    //   5000 033d  — collect single object (eid + type known from farm-load)
    //   5000 093d  — Далее (advance to next friend)
    //
    // Per-click hash is server-side IGNORED → we forge a random hex string.
    // request_id second-part must be monotonically increasing per-session →
    // we use Date.now() suffix.
    //
    // Trade-off vs the click-based loop: the game's PIXI client can't tell
    // these requests happened, so the canvas UI desyncs from server state.
    // That's fine for headless operation; if you want a synced UI, reload.
    
    if (window.HC_Headless) {
      console.log('[HC] Headless already installed — reusing.');
    } else {
    window.HC_Headless = (function() {
      const N = window.HC_Net;
      if (!N) { console.error('[HC_Headless] HC_Net missing — cannot install.'); return null; }
    
      // ── log buffer (shared with HC_Visit-style UI) ──
      const logBuf = [];
      function log(msg) {
        const ts = new Date().toISOString().slice(11, 19);
        const line = '[' + ts + '] ' + msg;
        logBuf.push(line);
        if (logBuf.length > 200) logBuf.shift();
        console.log('[HC_Headless]', msg);
        try { window.parent.postMessage({ type: 'HC_LOG', line: '[HC_Headless] ' + msg }, '*'); } catch (e) {}
      }
    
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    
      // ── request_id generator: monotonic per-session ──
      // Format <7d random>.<integer>. The second part must be ≥ the highest
      // the server has seen this session, so we anchor to Date.now() ms.
      function freshReqId() {
        return Math.floor(Math.random() * 9e6 + 1e6) + '.' + (Date.now() % 100000000);
      }
    
      // ── pick the most recent /proto.html template to copy URL skeleton ──
      // We need a real recent /proto.html capture for: sid, host, path, base
      // params. Without one we can't fabricate URLs.
      function latestProtoTemplate() {
        const all = N.findRequests({ sinceMs: 3600000, withBytes: true });
        return all.length ? all[all.length - 1] : null;
      }
    
      // ── Direct send: build URL from a template + body bytes, return parsed response ──
      function send(opcodeBytes, bodyBytes, opts) {
        opts = opts || {};
        const tmpl = latestProtoTemplate();
        if (!tmpl) return Promise.resolve({ error: 'no /proto.html template in ring — fire any in-game action once first' });
        return N.replay(tmpl.seq, {
          urlMutate(u) {
            u.params.proto = opts.proto || u.params.proto;
            u.params.request_id = freshReqId();
            return u;
          },
          bodyMutate() { return bodyBytes; },
        });
      }
    
      // ── Body builders ──
      function buildVoyage(friendIdHex32) {
        // 50 00 07 3d  00 00 00 00 00  <32 ASCII hex>
        const out = [0x50, 0x00, 0x07, 0x3d, 0x00, 0x00, 0x00, 0x00, 0x00];
        for (let i = 0; i < 32; i++) out.push(friendIdHex32.charCodeAt(i));
        return out;
      }
    
      // Enter-farm body — when possible, copy bytes from a captured template
      // and only swap the trailing 32-char friend ID. Avoids any byte-ordering
      // drift between game versions. Falls back to a synthesized body that
      // matches the format observed in this session's captures:
      //   05 00 01 3d  00 03 00 00 00  01 00 00  <32 ASCII hex>
      function buildEnterFarm(friendIdHex32) {
        const tpl = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: [0x05, 0x00, 0x01, 0x3d] }).slice(-1)[0];
        if (tpl && tpl.req && tpl.req.length === 44) {
          const out = tpl.req.slice();
          for (let i = 0; i < 32; i++) out[12 + i] = friendIdHex32.charCodeAt(i);
          return out;
        }
        // synthesized fallback — header is 12 bytes, friend id is 32 bytes
        const out = [0x05, 0x00, 0x01, 0x3d, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00];
        for (let i = 0; i < 32; i++) out.push(friendIdHex32.charCodeAt(i));
        return out;
      }
    
      function buildDalee(friendIdHex32) {
        // Prefer copying captured Далее template (same trick as buildEnterFarm).
        const tpl = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: [0x50, 0x00, 0x09, 0x3d] }).slice(-1)[0];
        if (tpl && tpl.req && tpl.req.length === 41) {
          const out = tpl.req.slice();
          for (let i = 0; i < 32; i++) out[9 + i] = friendIdHex32.charCodeAt(i);
          return out;
        }
        const out = [0x50, 0x00, 0x09, 0x3d, 0x00, 0x00, 0x00, 0x00, 0x00];
        for (let i = 0; i < 32; i++) out.push(friendIdHex32.charCodeAt(i));
        return out;
      }
    
      // 50 00 03 3d  00 <contentLen-uint8> 00 00 00
      // 24 00 <36-char UUID with dashes>
      // <typeCode-uint8> <eid-uint32-LE> <typeNameLen-uint16-LE> <ASCII type>
      // 01 00 00 00 <32-char ASCII hex (random — server-ignored)>
      function buildCollect(friendUuidWithDashes, typeCode, eid, typeName) {
        const out = [0x50, 0x00, 0x03, 0x3d, 0x00];
        // content-len placeholder at out[5] — patched at end
        out.push(0x00); // placeholder
        out.push(0x00, 0x00, 0x00);
        out.push(0x24, 0x00);
        if (friendUuidWithDashes.length !== 36) throw new Error('uuid must be 36 chars: ' + friendUuidWithDashes);
        for (let i = 0; i < 36; i++) out.push(friendUuidWithDashes.charCodeAt(i));
        out.push(typeCode & 0xff);
        out.push(eid & 0xff, (eid >>> 8) & 0xff, (eid >>> 16) & 0xff, (eid >>> 24) & 0xff);
        out.push(typeName.length & 0xff, (typeName.length >>> 8) & 0xff);
        for (let i = 0; i < typeName.length; i++) out.push(typeName.charCodeAt(i));
        out.push(0x01, 0x00, 0x00, 0x00);
        // random 32-char ASCII hex hash (server ignores)
        const hex = '0123456789abcdef';
        for (let i = 0; i < 32; i++) out.push(hex.charCodeAt((Math.random() * 16) | 0));
        // Patch content-len: total - 41 (header bytes)
        out[5] = (out.length - 41) & 0xff;
        return out;
      }
    
      // ── Type-prefix → typeCode mapping (collect request byte 47) ──
      // Observed: 01=sb_, 02=ga_, 03=te_. Others TBD; extend as needed.
      function typeCodeFor(typeName) {
        const pfx = typeName.slice(0, 3);
        return TYPE_PREFIX_CODE[pfx] || 0x00;
      }
    
      // ── Parsers ──
    
      // Parse the friend list from a captured В путь (5000 073d) response.
      // Each friend record begins with `24 00` followed by a 36-char ASCII UUID.
      function parseVoyageResp(bytes) {
        if (!bytes) return [];
        const friends = [];
        for (let i = 0; i + 38 <= bytes.length; i++) {
          if (bytes[i] !== 0x24 || bytes[i + 1] !== 0x00) continue;
          let ok = true, s = '';
          for (let j = 0; j < 36; j++) {
            const c = bytes[i + 2 + j];
            if (j === 8 || j === 13 || j === 18 || j === 23) { if (c !== 0x2d) { ok = false; break; } }
            else if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) { ok = false; break; }
            s += String.fromCharCode(c);
          }
          if (ok) {
            friends.push({ uuid: s, hex32: s.replace(/-/g, '') });
            i += 37;
          }
        }
        return friends;
      }
    
      // Parse a friend-farm load. Records are anchored on type-name strings
      // that start with a known prefix (ga_/te_/sb_/fl_/pl_/ra_/dc_/tl_/bl_).
      // For each match we walk back 14 bytes to read:
      //   [uint32 LE eid][uint32 LE field1][uint32 LE field2][uint16 LE typeLen]
      // This works across both farm-load formats observed (with delimiter
      // `06 7d da 41 00` AND without it). Reading backward is cheap because
      // type prefixes are rare.
      // Prefixes that PARSE — used by parseFarmLoadV2 to anchor records.
      // (Includes scenery so the whole record list is parsed for diagnostics.)
      const KNOWN_PREFIXES = ['ga_', 'te_', 'sb_', 'fl_', 'pl_', 'ra_', 'dc_', 'tl_', 'bl_', 'fe_', 'pi_'];
      // Prefixes that are actually COLLECTIBLE on a friend's farm.
      // Per doc 06: te_/sb_/pl_/pi_/fl_. Subset of ga_ subtypes (wild_onion, tree)
      // were observed collectible too — we keep ga_ only when it matches a known
      // collectible-subtype regex; otherwise scenery (ga_grass3, ga_birch3, ...)
      // produces the "FriendAction: does not have available actions" error.
      const COLLECTIBLE_PREFIXES = ['te_', 'sb_', 'pl_', 'pi_', 'fl_'];
      const COLLECTIBLE_GA_RE = /^ga_(wild_|tree$|wild_onion)/;
      function isCollectibleType(typeName) {
        const pfx = typeName.slice(0, 3);
        if (COLLECTIBLE_PREFIXES.indexOf(pfx) >= 0) return true;
        if (pfx === 'ga_' && COLLECTIBLE_GA_RE.test(typeName)) return true;
        return false;
      }
      // Type-prefix code for collect requests (byte 47 of 5000 033d body).
      // Verified: 01=sb_, 02=ga_, 03=te_. Others empirically guessed.
      const TYPE_PREFIX_CODE = { sb_: 0x01, ga_: 0x02, te_: 0x03, pl_: 0x04, fl_: 0x05, pi_: 0x06 };
    
      function parseFarmLoadV2(bytes) {
        if (!bytes) return [];
        const out = [];
        const seen = new Set();
        const N_ = bytes.length;
        for (let i = 14; i < N_ - 4; i++) {
          // Look for length-prefixed type-name: <uint16 typeLen> <prefix>
          if (bytes[i] === 0 || bytes[i] > 32) continue; // typeLen 1..32
          if (bytes[i + 1] !== 0) continue;
          const typeLen = bytes[i];
          if (i + 2 + typeLen > N_) continue;
          // Check prefix: byte[i+2..i+4] is "xx_"
          if (bytes[i + 4] !== 0x5f) continue;
          const c0 = bytes[i + 2], c1 = bytes[i + 3];
          if (c0 < 0x61 || c0 > 0x7a || c1 < 0x61 || c1 > 0x7a) continue;
          const prefix = String.fromCharCode(c0) + String.fromCharCode(c1) + '_';
          if (KNOWN_PREFIXES.indexOf(prefix) < 0) continue;
          // Read full type-name and ensure all printable
          let type = '', okType = true;
          for (let j = 0; j < typeLen; j++) {
            const c = bytes[i + 2 + j];
            if (c < 0x20 || c > 0x7e) { okType = false; break; }
            type += String.fromCharCode(c);
          }
          if (!okType) continue;
          // Walk back 14 bytes to read eid + field1 + field2 (+ typeLen at i)
          const p = i - 14;
          if (p < 0) continue;
          const eid    = bytes[p] | (bytes[p+1] << 8) | (bytes[p+2] << 16) | (bytes[p+3] << 24);
          const field1 = bytes[p+4] | (bytes[p+5] << 8) | (bytes[p+6] << 16) | (bytes[p+7] << 24);
          const field2 = bytes[p+8] | (bytes[p+9] << 8) | (bytes[p+10] << 16) | (bytes[p+11] << 24);
          // Sanity: eid must be a non-zero positive uint32 < ~10M
          if (eid === 0 || eid > 10_000_000) continue;
          if (seen.has(eid)) continue;
          seen.add(eid);
          out.push({ eid: eid >>> 0, field1: field1 | 0, field2: field2 | 0, type, prefix, off: i });
          i = i + 2 + typeLen - 1;
        }
        return out;
      }
    
      // ── High-level operations ──
    
      async function fetchFriendList() {
        // Look for a cached В путь response in the ring; if none, fire one.
        let voyage = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: [0x50, 0x00, 0x07, 0x3d] }).slice(-1)[0];
        if (!voyage || !voyage.resp) {
          log('no В путь in ring — fabricating one');
          // Need ANY 32-char hex friend ID for the body — try latest 0500 013d or use placeholder
          const enterTpl = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: [0x05, 0x00, 0x01, 0x3d] }).slice(-1)[0];
          let placeholderId = '00000000000000000000000000000000';
          if (enterTpl) {
            const tail = enterTpl.req.slice(enterTpl.req.length - 32);
            placeholderId = String.fromCharCode.apply(null, tail);
          }
          const r = await send([0x50, 0x00, 0x07, 0x3d], buildVoyage(placeholderId), { proto: '50x7' });
          log('В путь fired: env=' + r.envelope + ' respLen=' + r.respLen);
          // Wait briefly for the captured XHR to land in ring then re-fetch
          await sleep(300);
          voyage = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: [0x50, 0x00, 0x07, 0x3d] }).slice(-1)[0];
          if (!voyage) return { error: 'В путь fired but response not captured' };
        }
        const friends = parseVoyageResp(voyage.resp);
        log('parsed ' + friends.length + ' friends from В путь response');
        return { friends, voyageSeq: voyage.seq };
      }
    
      // Pull the captured response bytes out of the ring (replay() only returns
      // a summary, the bytes are stored on the ring entry by the XHR observer).
      function lastRingResp(envelope, sinceMs) {
        const recent = N.findRequests({ sinceMs: sinceMs || 3000, withBytes: true });
        for (let i = recent.length - 1; i >= 0; i--) {
          const e = recent[i];
          if (envelope && e.env !== envelope) continue;
          if (e.resp) return e;
        }
        return null;
      }
    
      async function enterFriendFarm(friendHex32) {
        log('entering friend ' + friendHex32.slice(0, 8) + '…');
        const r = await send([0x05, 0x00, 0x01, 0x3d], buildEnterFarm(friendHex32), { proto: '5x1' });
        log('  enter result: env=' + r.envelope + ' ok=' + r.ok + ' load=' + r.load + ' respLen=' + r.respLen);
        await sleep(300);
        // The replay's response landed in the ring as the most recent entry.
        // We want either a \x05 farm-load, OR the larger of the two acks
        // (sometimes the farm bytes come back in the P\0 ack).
        const recent = N.findRequests({ sinceMs: 5000, withBytes: true });
        let farmLoad = null;
        for (let i = recent.length - 1; i >= 0; i--) {
          const e = recent[i];
          if (e.respLen >= 5000) { farmLoad = e; break; }
        }
        return { result: r, farmLoad };
      }
    
      async function collectAll(friendUuidWithDashes, farmLoadBytes, opts) {
        opts = opts || {};
        const interMs = opts.interMs != null ? opts.interMs : 80;
        const stopOnConsecErrors = opts.stopOnConsecErrors != null ? opts.stopOnConsecErrors : 5;
        const objs = parseFarmLoadV2(farmLoadBytes);
        const collectibles = objs.filter(o => isCollectibleType(o.type));
        // Type histogram for diagnostics
        const typeHist = {};
        for (const o of collectibles) typeHist[o.type] = (typeHist[o.type] || 0) + 1;
        log('  parsed ' + objs.length + ' total / ' + collectibles.length + ' collectibles: ' +
            Object.entries(typeHist).map(([k, v]) => k + ':' + v).join(' '));
        let tried = 0, acks = 0, errs = 0, consecErr = 0, quotaHit = false;
        for (const o of collectibles) {
          if (!running) break;
          const tc = typeCodeFor(o.type);
          if (tc === 0x00) continue;
          const r = await send([0x50, 0x00, 0x03, 0x3d], buildCollect(friendUuidWithDashes, tc, o.eid, o.type), { proto: '50x3' });
          tried++;
          if (r.ok) { acks++; consecErr = 0; }
          else {
            errs++;
            consecErr++;
            // The response ASCII often includes the error reason; read it from the ring.
            if (errs <= 2 || consecErr === stopOnConsecErrors) {
              const last = N.findRequests({ sinceMs: 5000, withBytes: true }).slice(-1)[0];
              const reason = last && last.resp ? Array.from(last.resp).slice(0, 80).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('') : '';
              log('    err #' + errs + ': ' + reason);
              if (reason.indexOf('does not have availible actions') >= 0 ||
                  reason.indexOf('does not have available actions') >= 0) {
                quotaHit = true;
              }
            }
            if (consecErr >= stopOnConsecErrors) {
              log('  stopping collect: ' + consecErr + ' consecutive errors' + (quotaHit ? ' (friend quota hit)' : ''));
              break;
            }
          }
          await sleep(interMs);
        }
        log('  collect pass: tried=' + tried + ' ok=' + acks + ' err=' + errs + (quotaHit ? ' QUOTA' : ''));
        return { tried, acks, errs, quotaHit };
      }
    
      async function dalee(nextFriendHex32) {
        log('Далее → ' + nextFriendHex32.slice(0, 8) + '…');
        const r = await send([0x50, 0x00, 0x09, 0x3d], buildDalee(nextFriendHex32), { proto: '50x9' });
        log('  Далее result: env=' + r.envelope + ' ok=' + r.ok + ' respLen=' + r.respLen);
        await sleep(300);
        const recent = N.findRequests({ sinceMs: 5000, withBytes: true });
        let farmLoad = null;
        for (let i = recent.length - 1; i >= 0; i--) {
          const e = recent[i];
          if (e.respLen >= 5000) { farmLoad = e; break; }
        }
        return { result: r, farmLoad };
      }
    
      // ── Full cycle ──
      let running = false;
    
      async function runCycle(opts) {
        opts = opts || {};
        if (running) { log('runCycle ignored — already running'); return; }
        running = true;
        try {
          log('=== headless cycle START ===');
          const fl = await fetchFriendList();
          if (!fl.friends || fl.friends.length === 0) { log('STOP — no friends'); return; }
          const max = opts.maxFriends || Math.min(fl.friends.length, 5);
          log('cycle plan: ' + max + ' friends');
          for (let i = 0; i < max; i++) {
            if (!running) { log('aborted'); break; }
            const f = fl.friends[i];
            log('— friend ' + (i + 1) + '/' + max + ' uuid=' + f.uuid);
            const enter = await enterFriendFarm(f.hex32);
            if (!enter.farmLoad) { log('  no farm-load captured; skipping collect'); }
            else { await collectAll(f.uuid, enter.farmLoad.resp, opts); }
            if (i + 1 < max) {
              await dalee(fl.friends[i + 1].hex32);
            }
          }
          log('=== headless cycle END ===');
        } catch (e) {
          log('CRASH: ' + (e && e.stack || e));
        } finally {
          running = false;
        }
      }
    
      function stop() { running = false; log('stop requested'); }
      function isRunning() { return running; }
    
      return {
        runCycle, stop, isRunning,
        // helpers exposed for debugging / panel use
        fetchFriendList,
        enterFriendFarm,
        dalee,
        collectAll,
        parseVoyageResp,
        parseFarmLoadV2,
        buildVoyage, buildEnterFarm, buildDalee, buildCollect,
        typeCodeFor,
        freshReqId,
        getLog() { return logBuf.slice(); },
        clearLog() { logBuf.length = 0; },
      };
    })();
    }
    

    // ═══ ui.js (deferred) ═══
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
        visit.enterFarmFromHub({ requireRunning: false }).then(ok => console.log('[HC_UI] hub entry result:', ok));
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
          // Endpoint-debugging surface (see doc 08)
          case 'netDescribe':   value = HC_Net ? HC_Net.describe(args[0]) : 'no HC_Net'; break;
          case 'netFind':       value = HC_Net ? HC_Net.findRequests(args[0] || {}) : 'no HC_Net'; break;
          case 'netSummarize':  value = HC_Net ? HC_Net.summarize(args[0] || {}) : 'no HC_Net'; break;
          case 'netDiff':       value = HC_Net ? HC_Net.diff(args[0], args[1]) : 'no HC_Net'; break;
          case 'netReplay':     value = HC_Net ? await HC_Net.replay(args[0], args[1] || {}) : 'no HC_Net'; break;
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
          // ── Headless replay loop (doc 08) ──
          case 'headlessRun':       value = HC_Headless ? await HC_Headless.runCycle(args[0] || {}) : 'no HC_Headless'; break;
          case 'headlessStop':      HC_Headless && HC_Headless.stop(); value = { stopped: true }; break;
          case 'headlessFriends':   value = HC_Headless ? await HC_Headless.fetchFriendList() : 'no HC_Headless'; break;
          case 'headlessParseLast': {
            if (!HC_Headless || !HC_Net) { value = 'no HC_Headless'; break; }
            const all = HC_Net.findRequests({ sinceMs: 60000, withBytes: true });
            const farm = all.filter(e => e.respLen >= 8000).slice(-1)[0];
            if (!farm) { value = { error: 'no farm-load in ring' }; break; }
            const objs = HC_Headless.parseFarmLoadV2(farm.resp);
            const counts = {};
            for (const o of objs) counts[o.type] = (counts[o.type] || 0) + 1;
            value = { seq: farm.seq, respLen: farm.respLen, objectCount: objs.length, types: counts, sample: objs.slice(0, 8) };
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

    console.log('[HC-Ext] Hedgehog Vision ready. Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
  });  // end whenReady
})();
