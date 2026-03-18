# Hedgehog Clicker — Technical Reference

## Architecture

Single-page injectable script targeting a PIXI.js WebGL game running inside a cross-origin iframe on VK (`valley.redspell.ru/play/vk/index.html`). The code is split into 5 modules that communicate via `window.HC_*` globals and are concatenated into one IIFE by `build.js`.

### Module load order (strict dependency chain)

```
config.js → capture.js → vision.js → clicker.js → ui.js
```

Changing this order will break initialization since later modules reference earlier ones via `window.HC_*`.

### Module responsibilities

- **config.js** — `HC_CFG` object. All tunable parameters live here. Color targets are HSL ranges (`hMin/hMax/sMin/sMax/lMin/lMax`). Gold target is commented out by default because it matches warm scenery tones (sunflowers, wooden buildings).
- **capture.js** — `HC_Capture`. Hooks `gl.drawElements()` to capture full-frame pixel data. The game's WebGL context has `preserveDrawingBuffer: false`, so `readPixels()` outside draw calls returns all-black. The hook reads pixels right after each draw call completes, checking the center pixel is non-black before doing a full-frame read (to avoid capturing intermediate passes like shadows).
- **vision.js** — `HC_Vision`. Stateless functions: `rgbToHsl()`, `scanFrame()`, `samplePixel()`. Scan iterates pixels at `scanStep` intervals, converts to HSL, matches against targets, then clusters nearby hits using a simple O(n^2) distance-based algorithm with `clusterRadius`. Clusters below `minCluster` are discarded.
- **clicker.js** — `HC_Clicker`. Manages run state and three click modes. Click simulation dispatches `pointerdown → mousedown → pointerup → mouseup → click` events on the canvas with computed client coordinates (accounts for CSS scaling via `getBoundingClientRect`).
- **ui.js** — `HC_UI`. Creates the fixed-position draggable panel. Reads/writes `HC_CFG` directly for slider values. Calls `HC_Clicker` methods for actions.

## Key Technical Details

### WebGL Frame Capture

```
gl.drawElements() → origDrawElements() → readPixels(center) → if non-black → readPixels(full frame)
```

- Frame data is stored as `Uint8Array(width * height * 4)` in RGBA order
- WebGL coordinate system has Y=0 at bottom, so screen Y must be flipped: `fy = height - 1 - screenY`
- Capture is one-shot per request (`captureRequested` flag) to avoid performance impact
- The hook chains: if the script is re-injected, it hooks the already-hooked function (works fine, just adds a layer)

### HSL Color Detection

RGB → HSL conversion follows the standard algorithm. Detection targets are defined as HSL bounding boxes. Current targets:

| Target | H range | S range | L range | Status |
|--------|---------|---------|---------|--------|
| purple | 260–320 | 30–100 | 25–70 | Active |
| gold | 40–50 | 80–100 | 50–70 | Disabled (too broad) |

The purple range covers violet/magenta resource-ready indicators. Gold was disabled because hue 35-55 at moderate saturation matches wooden buildings, sunflowers, hay, and other warm-toned scenery across the entire farm (produced 84 false-positive clusters in testing).

### Clustering Algorithm

Simple single-pass greedy clustering:
1. For each unvisited hit, start a new cluster
2. Add all unvisited hits within `clusterRadius` pixels (Euclidean distance)
3. Cluster center = average of all member positions
4. Discard clusters with fewer than `minCluster` members

This is O(n^2) but fast enough for ~10k hits at step=3 on a 1000x700 canvas.

### Click Simulation

The game uses PIXI's `InteractionManager` which listens for pointer/mouse events on the canvas. Dispatching synthetic events requires:
- Correct `clientX`/`clientY` (CSS coordinates, not canvas coordinates)
- Scaling factor: `canvas.width / getBoundingClientRect().width`
- Full event sequence: `pointerdown → mousedown → pointerup → mouseup → click`

Smart mode adds a +10px Y offset to clicks (`detected.y + 10`) to hit the building body rather than the badge itself.

### Game Environment

- Game engine: PIXI.js v4/5 with WebGL renderer
- Canvas size: 1000x700 (CSS-scaled to fit viewport)
- Global objects: `TF` (text formatting), `T` (social sharing), `sender` (network), `getGameContext()` (returns user/session info), `gameFacade` (function, returns null)
- Game scripts are UUID-named bundles (obfuscated)
- Cross-origin iframe blocks parent page JS access; script must be injected in the iframe's console context

## Build System

`build.js` is a simple Node.js concatenator:
1. Reads modules from `src/` in dependency order
2. Wraps in outer IIFE with canvas check and cleanup
3. Indents module content
4. Appends init logging
5. Writes to `clicker.js`

No transpilation, bundling, or minification. The output is directly paste-able into a browser console.

## Tuning Guide

If detection produces false positives:
- Increase `minCluster` (default 15) — larger clusters are more likely to be real badges
- Narrow HSL ranges in config — use Calibrate to sample actual badge pixels
- Increase `scanStep` for faster but coarser scans

If detection misses badges:
- Decrease `minCluster`
- Widen HSL ranges or add new targets
- Decrease `scanStep` for finer pixel coverage

Grid mode bypasses detection entirely and clicks a 12x9 grid pattern every 80ms, pausing 2s between sweeps. Use this as a fallback when color calibration isn't practical.
