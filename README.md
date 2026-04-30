# Hedgehog Clicker

Autonomous friend-farm collector for the VK game **Ёжики** (Hedgehogs).

Hooks into the game's binary `/proto.html` XHR traffic to track collect outcomes, dispatches trusted clicks via `chrome.debugger`, and loops farm-to-farm until the backpack fills up.

## Quick Start

Two ways to use it:

### Option A — Chrome extension (recommended)

1. `node build.js`
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `chrome-ext/`.
3. Open `https://valley.redspell.ru/` (or `https://vk.com/ezhiky_game`) — the HC panel appears automatically. See `chrome-ext/README.md` for the postMessage bridge.

### Option B — Manual paste

1. Open `https://vk.com/ezhiky_game`
2. Press **F12** → Console tab
3. Switch context from `top` to the `valley.redspell.ru` iframe
4. Paste the contents of `clicker.js` and press Enter

The **Hedgehog Vision** panel appears in the top-right corner.

> Manual paste does **not** get debugger-trusted clicks — synthetic events are silently dropped by PIXI on this game. The paste path is useful for poking at `HC_Net` / `HC_Scene` / `HC_Overlay` from DevTools, but the autonomous visit loop only works through the extension.

## Controls

| Control | Action |
|---------|--------|
| **F2** | Toggle the visit loop on/off |
| **START / STOP** | Same toggle, via panel |
| **Sweep Once** | Run one grid sweep without advancing (debug) |
| **Enter Hub Farm** | Walk hub probes to enter a friend farm without starting the loop |
| **Probe DbgClick** | Sanity-check that the debugger-click path is alive |
| **Pickers** | Click the canvas to set the canvas coords for `Далее` / `Выйти` / popup `Далее` / `Путешествия` etc. |

## What the loop does

1. Reads `HC_Net.lastFarmLoadSeq()`. If null (we're at the friends-village hub, not inside a farm), runs `enterFarmFromHub()` — a 24-point grid over the hub playfield, awaits a farm-load XHR after each click.
2. Inside a farm, fires one grid sweep (14×9 = 126 cells, 300 ms apart, ~38 s total). Every click is non-awaited; success is measured as the delta of `HC_Net.totalOk` after a 1.8 s settle.
3. Tries the centered popup `Далее` (only present once the farm is fully harvested), then the bottom-left `Далее` button. The first that produces a new farm-load wins.
4. After 2 consecutive failed advances, stops — that's the backpack-full proxy.

## Project Structure

```
src/
  glspy.js       — WebGL state-fingerprint hooks (offline reverse-engineering)
  network.js     — HC_Net: XHR observer + farm-load packet parser
  dbgclick.js    — HC_DbgClick: trusted-click bridge to chrome.debugger
  capture.js     — HC_Capture: canvas locator + getContext hook
  scenegraph.js  — HC_Scene: PIXI discovery (diagnostic-only)
  overlay.js     — HC_Overlay: world→canvas projection, calibratable
  visit.js       — HC_Visit: autonomous farm-to-farm loop
  ui.js          — HC_UI: draggable control panel
chrome-ext/
  manifest.json
  iframe-script.js     — built MAIN-world content script
  iframe-isolated.js   — ISOLATED-world bridge to background
  background.js        — service worker; owns chrome.debugger
  README.md            — install + postMessage bridge docs
build.js          — Concatenates src/ → both clicker.js and chrome-ext/iframe-script.js
clicker.js        — Built paste-into-console bundle
doc/
  01..04           — historical pixel/scene-graph attempts (abandoned)
  05               — XHR envelope discovery
  06               — farm-load packet decoding
  07               — current visit-loop architecture
```

## Build

```bash
node build.js
```

Concatenates all `src/` modules into `clicker.js` and `chrome-ext/iframe-script.js`. No transpilation, no minification.

## How It Works

The game's `/proto.html` POST endpoint speaks a custom binary protocol. Each response starts with a 2-byte envelope:

- `50 00` (`"P\0"`) — action ok (the click landed on something interactable)
- `30 00` (`"0\0"`) — idle tick, no action
- `00 00` — error

`HC_Net` wraps `XMLHttpRequest` to observe these envelopes, count outcomes, and ring-buffer the last 32 (req, resp) byte pairs. Large responses (≥ 8 KB) are farm-loads — `HC_Net.lastFarmLoadSeq()` returns the sequence number of the most recent one, which is the loop's "are we in a farm?" oracle.

Trusted clicks are dispatched by the extension's background service worker via `chrome.debugger Input.dispatchMouseEvent` — synthetic `MouseEvent` / `PointerEvent` dispatches don't reach PIXI's `InteractionManager` on this game.

See `CLAUDE.md` for module-level details and `doc/05` / `doc/06` / `doc/07` for the protocol & loop work.

## License

MIT
