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
