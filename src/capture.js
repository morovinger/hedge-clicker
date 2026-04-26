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
