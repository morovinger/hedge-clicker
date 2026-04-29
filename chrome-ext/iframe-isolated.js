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
  }
});

console.log('[HC-Iso] debugger bridge ready');

// ── Capture our own URL when it's the "proper" vkjs/ form ──
// Two URL families exist on valley.redspell.ru:
//   /play/vkjs/index.html?... — proper, no VK widgets, our target
//   /play/vk/index.html?...   — VK-iframe form, has widgets that interfere
// Only the vkjs/ form gets persisted; the toolbar action then re-uses it
// directly without going through the VK launcher.
(function captureSelfUrl() {
  try {
    const url = location.href;
    const isVkjs = /\/play\/vkjs\//.test(url);
    const isVk   = /\/play\/vk\//.test(url);
    if (!isVkjs && !isVk) return;
    // Need the auth params to be useful for re-launch
    if (!/[?&]viewer_id=/.test(url) || !/[?&]sid=/.test(url)) return;
    // Don't overwrite a good URL with a bad one
    if (isVk) {
      console.log('[HC-Iso] on /play/vk/ form — ignoring (VK widgets interfere). Use /play/vkjs/.');
      return;
    }
    // Check expire if present
    const m = /[?&]expire=(\d+)/.exec(url);
    if (m && parseInt(m[1], 10) * 1000 < Date.now()) return;
    chrome.storage.local.set({
      lastGameUrl: { url, capturedAt: Date.now(), pageUrl: url, source: 'self' }
    }, function () {
      console.log('[HC-Iso] captured live vkjs URL → chrome.storage.local.lastGameUrl');
    });
  } catch (e) { /* ignore */ }
})();
