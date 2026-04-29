// Runs on https://vk.com/ezhiky_game (and /app*) pages while the user is
// signed into VK. Watches for the game iframe to mount and stores its
// resolved src — which contains a fresh VK OAuth signature — in
// chrome.storage.local under `lastGameUrl`. The toolbar action
// (background.js) can then re-open the game directly without you needing
// to paste the long URL again.
//
// Best-effort auto-click: VK lazy-mounts the iframe on user gesture, so
// we look for an obvious "play / launch" button and try clicking it once.
// If that's blocked or the button selector changes, the user can click
// it manually — the watcher will still capture the URL.

(function() {
  'use strict';
  const TAG = '[HC-VK]';
  // Two URL forms exist:
  //   /play/vkjs/  — "proper" — VK ID/OAuth scheme, no widgets, the one
  //                  we want. Game runs cleanly.
  //   /play/vk/    — "improper" — legacy iframe scheme with VK widgets
  //                  that interfere with the game. We see these but
  //                  don't persist them.
  const ANY_VALLEY_RX = /valley\.redspell\.ru\/play\/(vkjs|vk)\//;
  const VKJS_RX       = /valley\.redspell\.ru\/play\/vkjs\//;
  const VK_LEGACY_RX  = /valley\.redspell\.ru\/play\/vk\//;

  // Heuristic match for the "play" button across VK's apps UI dialects.
  const PLAY_TXT_RX = /^(Запустить|Играть|Открыть|Play|Launch|Open)$/i;
  // Запустить = Запустить
  // Играть = Играть
  // Открыть = Открыть

  let captured = false;
  let sawLegacy = false;

  function persist(url) {
    if (captured) return;
    if (!ANY_VALLEY_RX.test(url)) return;
    if (VK_LEGACY_RX.test(url)) {
      if (!sawLegacy) {
        sawLegacy = true;
        console.log(TAG, 'observed /play/vk/ (legacy with widgets) — NOT persisting. Open the vkjs/ entry instead; the game runs cleanly there.');
      }
      return;
    }
    if (!VKJS_RX.test(url)) return;
    captured = true;
    const entry = { url, capturedAt: Date.now(), pageUrl: location.href, source: 'vk-launcher' };
    try {
      chrome.storage.local.set({ lastGameUrl: entry }, () => {
        console.log(TAG, 'captured fresh vkjs/ URL → chrome.storage.local.lastGameUrl');
      });
    } catch (e) { console.warn(TAG, 'storage.set failed', e); }
  }

  function scanForIframe(root) {
    // Look at every valley iframe so we can flag legacy ones too.
    const all = (root || document).querySelectorAll('iframe[src*="valley.redspell.ru"]');
    for (const ifr of all) if (ifr.src) persist(ifr.src);
    return all.length > 0 && captured;
  }

  function tryAutoClick() {
    // Don't auto-click on every keypress — once is enough.
    if (window.__hcVkClicked) return;
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"], .button, .flat_button'));
    for (const b of buttons) {
      const t = (b.textContent || '').trim();
      if (PLAY_TXT_RX.test(t)) {
        try {
          b.click();
          window.__hcVkClicked = true;
          console.log(TAG, 'auto-clicked launch button:', t);
          return;
        } catch (e) {}
      }
    }
  }

  function init() {
    if (window.__hcVkLauncherInit) return;
    window.__hcVkLauncherInit = true;

    if (scanForIframe()) return; // already mounted

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n && n.nodeType === 1) {
            if (n.tagName === 'IFRAME' && n.src && ANY_VALLEY_RX.test(n.src)) { persist(n.src); }
            if (n.querySelector) {
              const ifr = n.querySelector('iframe[src*="valley.redspell.ru"]');
              if (ifr && ifr.src) persist(ifr.src);
            }
          }
        }
        if (m.type === 'attributes' && m.target.tagName === 'IFRAME' && m.target.src && ANY_VALLEY_RX.test(m.target.src)) {
          persist(m.target.src);
        }
        if (captured) { obs.disconnect(); return; }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

    // Best-effort auto-click after the page settles. Browsers may block
    // synthetic clicks that try to open cross-origin iframes without a
    // real user gesture, in which case the user clicks themselves and
    // the observer still captures the URL.
    setTimeout(tryAutoClick, 1500);
    setTimeout(tryAutoClick, 4000);

    console.log(TAG, 'launcher watcher armed on', location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
