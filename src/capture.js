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
