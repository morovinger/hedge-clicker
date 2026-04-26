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
