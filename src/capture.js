// ── WebGL Frame Capture ──
// Hooks gl.drawElements to capture pixel data mid-render.
// This is necessary because the game's WebGL context has
// preserveDrawingBuffer: false, so readPixels returns black outside draw calls.

window.HC_Capture = (function() {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
  if (!gl) { console.error('[HC] No WebGL context!'); return null; }

  const origDrawElements = gl.drawElements.bind(gl);
  let frameData = null;
  let captureRequested = true;
  let drawCallCount = 0;

  gl.drawElements = function() {
    origDrawElements.apply(gl, arguments);
    drawCallCount++;
    if (captureRequested) {
      try {
        // Check if the center pixel is non-black (scene is being drawn)
        const px = new Uint8Array(4);
        gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (px[0] > 0 || px[1] > 0 || px[2] > 0) {
          const w = canvas.width, h = canvas.height;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          frameData = { data: pixels, width: w, height: h, time: Date.now() };
          captureRequested = false;
        }
      } catch(e) {}
    }
  };

  return {
    canvas,
    gl,
    requestFrame() { captureRequested = true; },
    getFrame() { return frameData; },
    getDrawCallCount() { return drawCallCount; },
  };
})();
