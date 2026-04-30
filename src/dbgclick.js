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
