# Hedgehog Clicker — Technical Reference

## Architecture

Injectable / extension-bundled script targeting a PIXI.js WebGL game running inside a cross-origin iframe on VK (`valley.redspell.ru/play/vk/index.html`). The current build is **not** a vision pipeline — earlier HSL-based smart-mode (`config.js` / `vision.js` / `clicker.js`) was removed in #07 once the network-decoding path landed.

The active pipeline drives friend-farm collection by:
1. Observing `/proto.html` XHRs to know when collect actions succeed.
2. Dispatching trusted clicks via a `chrome.debugger` session owned by the extension's background service worker.
3. Sweeping a static grid (or, eventually, parsed object coords from the farm-load packet) over the canvas, then advancing to the next friend farm.

The code is split into 8 modules concatenated into one IIFE by `build.js`, which writes two outputs:
- `clicker.js` — paste-into-DevTools bundle (manual fallback).
- `chrome-ext/iframe-script.js` — extension content script, injected into the game iframe at `document_start`.

### Module load order (strict dependency chain)

```
glspy.js → network.js → dbgclick.js → capture.js → scenegraph.js → overlay.js → visit.js → ui.js
```

The extension build splits these into two phases: `glspy` / `network` / `dbgclick` / `capture` / `scenegraph` load eagerly at `document_start` (so the WebGL `getContext` hook beats PIXI), and `overlay` / `visit` / `ui` are deferred until `HC_Capture.whenReady()` fires.

### Module responsibilities

- **glspy.js** — `HC_GLSpy`. Hooks WebGL state changes to fingerprint draw calls and snapshot texture usage. Used for offline scene-graph reverse engineering, not by the live loop.
- **network.js** — `HC_Net`. Wraps `XMLHttpRequest` to observe `/proto.html` responses. Classifies each response by its 2-byte envelope (`0x50 0x00` = `"P\0"` = action ok, `0x30 0x00` = `"0\0"` = idle tick, anything else = error). Keeps a 32-entry ring of recent (req, resp) byte pairs and exposes `lastFarmObjects()` / `lastFarmLoadSeq()` / `awaitNextFarmLoad()` for callers that need to know "did the game just load a new farm?"
- **dbgclick.js** — `HC_DbgClick`. Front-end of the debugger-click path. Forwards click coords to the extension's isolated-world script via `postMessage`, which forwards to the background service worker, which dispatches `Input.dispatchMouseEvent` through its `chrome.debugger` session. Synthetic events on the canvas don't work — PIXI's `InteractionManager` ignores untrusted clicks — so the debugger path is the only reliable way to drive the game.
- **capture.js** — `HC_Capture`. Thin canvas locator. Hooks `HTMLCanvasElement.getContext` so any future module can grab the real WebGL context, but the live loop only uses `HC_Capture.canvas` for `getBoundingClientRect`.
- **scenegraph.js** — `HC_Scene`. Best-effort PIXI scene graph discovery (`__PIXI_DEVTOOLS_GLOBAL_HOOK__`, canvas back-refs, window globals). Diagnostic-only; no live-loop dependency.
- **overlay.js** — `HC_Overlay`. Renders parsed farm-load objects onto a transparent canvas overlay, with a tunable world→screen transform (`tw`, `th`, `cx`, `cy`). The default transform is a guess; `HC_Overlay.calibrateFromPairs` lets you fit it from known (world, canvas) coord pairs. **Until calibration runs, projected coords are not trustworthy** — `HC_Visit.sweepMode` defaults to `'grid'` for that reason.
- **visit.js** — `HC_Visit`. The autonomous loop. Bootstraps into a friend farm via hub probes if needed, runs one full grid pass per farm, then tries the popup `Далее` and bottom-left `Далее` buttons in sequence to advance. Stops after 2 consecutive empty advances (backpack-full proxy).
- **ui.js** — `HC_UI`. Draggable panel with START/STOP, Sweep Once, Enter Hub Farm, Probe DbgClick, three coord pickers, a live diagnostic line, and a 160px scrollable log box mirroring `HC_Visit.log` lines via `postMessage` to the parent frame.

## Key Technical Details

### XHR envelope (HC_Net)

The game communicates with the server via length-prefixed binary `POST /proto.html` calls. The first two bytes of the response classify the outcome:

| Bytes (hex) | ASCII | Meaning |
|-------------|-------|---------|
| `50 00`     | `P\0` | Action acknowledged — a click hit a real interactable, state changed. Counts as `totalOk`. |
| `30 00`     | `0\0` | Background tick / idle poll — no state change. Counts as `totalTick`. |
| `00 00`     | —     | Error envelope (e.g. "expired request"). Counts as `totalErr`. |
| anything else | —   | Unknown — logged as `envelope=<char>` for debugging. |

**Caveat**: background terrain tiles also produce `P\0` responses on click. The success oracle therefore can't tell "I collected a resource" from "I clicked grass and the server acknowledged the click" — only "the click reached the game." This is why `maxSweepsPerFarm = 1`: there is no reliable per-cell signal to stop early.

Farm-load responses are large (~67 KB vs ~3 KB for ticks). `HC_Net.lastFarmLoadSeq()` and `awaitNextFarmLoad({ afterSeq })` use `respLen >= 8000` as the discriminator. These functions are the canonical "are we in a farm yet?" / "did clicking Далее actually advance?" oracle.

### Click dispatch (HC_DbgClick)

```
HC_Visit.click(cx, cy)
  → HC_DbgClick.click(viewportX, viewportY)            [MAIN world]
  → postMessage to iframe-isolated.js                  [ISOLATED world]
  → chrome.runtime.sendMessage to background.js        [service worker]
  → chrome.debugger Input.dispatchMouseEvent           [Devtools Protocol]
  → game receives a trusted click
```

Coordinate spaces:

| Space | Range | Where |
|---|---|---|
| Canvas pixels | 0..1000 × 0..700 | `HC_Visit`, `HC_Overlay` internal coords |
| Iframe-viewport pixels | varies | What `Input.dispatchMouseEvent` accepts (debugger is attached to the iframe target) |
| Top-frame viewport pixels | varies | `iframe.getBoundingClientRect().left/top` shift in this space |

`HC_Visit.click` does the canvas → iframe-viewport translation per click, never caching the rect (the iframe's position shifts when the HC panel expands/collapses).

### Build System

`build.js` is a Node concatenator producing two outputs:

1. **Paste bundle (`clicker.js`)** — wraps all 8 modules in one IIFE with a canvas check and a cleanup preamble (removes any prior `#hc-panel`, clears `__hcTimer`).
2. **Extension content script (`chrome-ext/iframe-script.js`)** — same modules, but eager (`glspy`, `network`, `dbgclick`, `capture`, `scenegraph`) load at `document_start` and the rest are wrapped in `HC_Capture.whenReady(...)`. Also appends a `postMessage` bridge (the `HC_CMD` / `HC_RES` switch) so the parent page or external automation can drive the loop programmatically.

No transpilation, bundling, or minification. The output is directly paste-able / loadable.

### Re-injection

Every module is guarded by `if (window.HC_X) { console.log('reusing'); return; }` so re-running the script (during development hot-reload) doesn't re-hook XHR / canvas / `getContext` — it just re-uses the existing instances. The UI panel is removed and recreated.

## Tuning Guide

If the loop fires clicks but `HC_Net.totalOk` stays at 0:
- Probe the debugger path: `HC_DbgClick.probe()`. If it reports ok but clicks aren't landing, another `chrome.debugger` session likely stole the attach (e.g. claude-in-chrome MCP). Detach the other session.
- Confirm you're not in an empty hub view — `HC_Net.lastFarmLoadSeq()` should be non-null.

If `enterFarmFromHub` never finds a farm:
- The hub-probe grid (`HUB_PROBES` in visit.js, x=200–850 step 130, y=220–520 step 100, 24 points) only covers the typical hub layout. A farm icon outside that bounding box won't get hit; widen the grid.

If you want parsed-object sweeps instead of grid:
- Calibrate `HC_Overlay` first via `overlayCalibrate` with two or more known (world, canvas) point pairs.
- Then `HC_Visit.setSweepMode('auto')` or `'parsed'`.

## See Also

- `doc/05-network-api-discovery.md` — XHR envelope discovery, including the 0x80 → 0x50 hex/decimal fix.
- `doc/06-farm-state-decoding.md` — the farm-load packet parser (`parseFarmLoad`, type prefixes, position layout).
- `doc/07-autonomous-visit-loop.md` — the visit loop's working primitive, calibrated coordinates, known issues.
