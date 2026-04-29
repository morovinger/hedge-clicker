// Owns a chrome.debugger session targeted at the valley.redspell.ru
// iframe, so we can dispatch trusted (isTrusted: true) mouse events.
// Synthetic events from the page context are filtered by PIXI's
// interaction manager — these aren't.
//
// The toolbar action just opens https://valley.redspell.ru/ — that page
// pulls the user's VK session from cookies automatically, no
// token-juggling needed.

const HC_BG_VERSION = '0.4.0';
const GAME_URL = 'https://valley.redspell.ru/';
console.log('[HC-BG] service worker started, version', HC_BG_VERSION);

let attached = null;   // { targetId } once attached
let attaching = null;  // in-flight attach promise

async function findTarget() {
  const targets = await chrome.debugger.getTargets();
  return targets.find(t => t.url && t.url.indexOf('valley.redspell.ru') >= 0);
}

async function listTargets() {
  const targets = await chrome.debugger.getTargets();
  return targets.map(t => ({ id: t.id, type: t.type, url: t.url, attached: t.attached }));
}

async function ensureAttached() {
  if (attached) return attached;
  if (attaching) return attaching;
  attaching = (async () => {
    const t = await findTarget();
    if (!t) throw new Error('no valley.redspell.ru target');
    await chrome.debugger.attach({ targetId: t.id }, '1.3');
    attached = { targetId: t.id };
    console.log('[HC-BG] debugger attached', t.id, t.url);
    return attached;
  })();
  try { return await attaching; }
  finally { attaching = null; }
}

async function dispatchClick(x, y) {
  const tgt = await ensureAttached();
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1 };
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

async function detach() {
  if (!attached) return;
  try { await chrome.debugger.detach(attached); }
  catch (e) { console.warn('[HC-BG] detach failed', e); }
  attached = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'HC_DBG_CLICK') {
    dispatchClick(msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === 'HC_DBG_PING') {
    ensureAttached()
      .then(t => sendResponse({ ok: true, targetId: t.targetId }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === 'HC_DBG_DETACH') {
    detach().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'HC_DBG_TARGETS') {
    listTargets()
      .then(list => sendResponse({ ok: true, targets: list }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[HC-BG] debugger detached', reason);
  attached = null;
});

// ── Toolbar action ──
// Single click → open the game in a new tab. valley.redspell.ru pulls
// the VK session from cookies automatically; no token URL needed.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: GAME_URL });
});

// Set version badge so users can see at a glance which build is loaded.
async function onBoot() {
  try {
    await chrome.action.setBadgeText({ text: HC_BG_VERSION.slice(2) }); // "4.0"
    await chrome.action.setBadgeBackgroundColor({ color: '#3a7' });
    await chrome.action.setTitle({ title: 'Hedgehog Vision v' + HC_BG_VERSION + ' — open Ёжики' });
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(onBoot);
chrome.runtime.onStartup.addListener(onBoot);
onBoot();
