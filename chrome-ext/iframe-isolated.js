// Lives in the ISOLATED world inside the valley.redspell.ru iframe.
// Sole purpose: bridge postMessage from the MAIN-world script to the
// extension service worker (which owns chrome.debugger).

window.addEventListener('message', function (ev) {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'HC_DBG_CLICK_REQ') {
    chrome.runtime.sendMessage({ type: 'HC_DBG_CLICK', x: m.x, y: m.y }, function (resp) {
      const err = chrome.runtime.lastError;
      window.postMessage({
        type: 'HC_DBG_CLICK_RES',
        id: m.id,
        ok: !!(resp && resp.ok),
        error: (err && err.message) || (resp && resp.error) || null,
      }, '*');
    });
    return;
  }
  if (m.type === 'HC_DBG_PING_REQ') {
    chrome.runtime.sendMessage({ type: 'HC_DBG_PING' }, function (resp) {
      window.postMessage({ type: 'HC_DBG_PING_RES', id: m.id, resp }, '*');
    });
    return;
  }
  if (m.type === 'HC_DBG_TARGETS_REQ') {
    chrome.runtime.sendMessage({ type: 'HC_DBG_TARGETS' }, function (resp) {
      window.postMessage({ type: 'HC_DBG_TARGETS_RES', id: m.id, resp }, '*');
    });
    return;
  }
  if (m.type === 'HC_DBG_DETACH_REQ') {
    chrome.runtime.sendMessage({ type: 'HC_DBG_DETACH' }, function (resp) {
      window.postMessage({ type: 'HC_DBG_DETACH_RES', id: m.id, resp }, '*');
    });
  }
});

console.log('[HC-Iso] debugger bridge ready');
