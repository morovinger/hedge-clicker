# 04 — GLSpy + Pixel-Diff Click Detection

Status: **Working primitive, needs calibration.** Replaces both pixel-capture (doc/01) and PIXI scene-graph (doc/02–03) — neither could give us per-sprite info.

## What we landed on

Two cooperating mechanisms living inside the iframe:

1. **GLSpy** (`src/glspy.js`) — wraps `HTMLCanvasElement.prototype.getContext` at `document_start`, then monkey-patches the WebGL methods (`useProgram`, `bindTexture`, `drawElements`, `drawArrays`, `texImage2D`). Each draw call records: which program, which texture, what was uploaded. Aggregates per-frame (frame boundary = 8ms idle after last draw).
2. **Pixel snapshotter** (installed dynamically on top of GLSpy's `drawElements` wrapper) — when armed with a region `(x, y, w, h)`, reads back that region's pixels via `gl.readPixels()` *during* the next draw call. Has to happen inside a draw because the game uses `preserveDrawingBuffer: false`, so the back-buffer is invalidated by the compositor between RAFs.

We use **synthetic pointer events** (`pointerdown → mousedown → pointerup → mouseup → click`) dispatched on the canvas to drive the game. Confirmed working when (80, 660) opened the exit popup — so the game does NOT reject `isTrusted: false` events, contrary to my first guess.

## How a click is verified

```
arm pixel snapshot (80×80 region around target)
sample BEFORE  → { meanR, meanG, meanB, hash }
dispatch click
wait 400–500 ms
sample AFTER   → { meanR, meanG, meanB, hash }
disarm
diff:
  hash:    too noisy — ambient sprite atlases swap even when nothing happens
  RGB mean: stable when nothing happens; shifts noticeably when a popup
            opens, a cell highlights, or an animation overlays the area
```

So the working signal is **RGB-mean delta**, not hash. Threshold needs calibration against ground-truth interactive cells.

## Plumbing

```
parent page (vk.com)                     iframe (valley.redspell.ru)
─────────────────────                    ─────────────────────────────
__hcBridge(cmd, args) ──postMessage──▶   {type:'HC_CMD', id, cmd, args}
                                              │
                                              ▼
                                         iframe-script.js handler
                                              │
                                              ▼  case 'eval': new Function(args[0])
                                                          'glSnap': HC_GLSpy.snapshot()
                                                          'glWindow': HC_GLSpy.captureWindow()
                                                          'clickAt': dispatch events
                                                          ...
                                              │
       {type:'HC_RES', id, ok, value} ◀────────┘
```

The bridge in `iframe-script.js` exposes a fixed command vocabulary AND an `eval` escape hatch (`new Function(body)` — body must `return` a value or a Promise). I used `eval` to install ad-hoc helpers (`window.__hcArmPix`, `window.__hcGetPix`, `window.__hcClickDetect`) without rebuilding the extension every iteration.

## Gotchas hit (all confirmed real)

1. **GLSpy binds to wrong canvas at first.** The game creates a canvas and calls `getContext('webgl')` *before* resizing it from the default 300×150. GLSpy's prototype hook stores that ctx and never updates. Workaround: re-call `canvas.getContext('webgl')` on the visible 1000×700 canvas — the prototype hook fires again and updates `glRef`. Permanent fix: GLSpy should re-evaluate `glRef` whenever a wrapped context's canvas dimensions cross the threshold.
2. **Game render loop pauses when tab is unfocused.** `framesSeen` stops incrementing → all `glWindow`/`captureWindow` calls return empty. Bring tab to front before measuring.
3. **Bridge `eval` body needs explicit `return`** — it's wrapped in `new Function(body)`, not evaluated as an expression. Bare `(()=>{...})()` returns `undefined`.
4. **Bridge timeout is 5 s** — too short for multi-cell sweeps. Use a longer-timeout variant for sweeps or batch in one eval.
5. **`drawsLastFrame` count is too coarse for popup detection.** Opening the exit popup at (80, 660) added only ~1 draw to a 50-draw frame. Diffs of single-frame draw counts miss small UI overlays.
6. **Texture-set diffs are too noisy.** Even idle, blob-URL textures rotate through the renderer (atlas reuse), so "new texture appeared" is mostly false-positive. Named PNG URLs (`st-valley.redspell.ru/images/...`) are stable but rarely change during a click — most game UI uses procedural blob atlases.

## What this gives us

Per-region click validation: "did this click land on something interactive?" Answer in ~600 ms (120 ms baseline + click + 500 ms post). Resolution = however small a region we're willing to sample (currently 80×80 around the click point).

## What it does NOT give us

- Per-sprite identity (still no scene-graph access).
- Resource-type discrimination (tree vs stone vs hut) — the RGB mean tells us *something changed*, not *what*.
- Screen-state classification beyond what GLSpy fingerprints already provide (named PNGs + draws/frame buckets).

## Open work

1. **Calibrate RGB-delta threshold** against known-interactive cells (need user-supplied tree/stone coordinates from `Screenshot_5.png`).
2. **Auto-rebind GLSpy `glRef`** when canvas dimensions change so the wrong-canvas trap doesn't keep recurring.
3. **State classifier** — `HC_GLSpy.matchScreen() → 'main' | 'travel' | 'arrow' | 'friend' | 'unknown'` using stored fingerprints (named PNG sets + draws/frame ranges).
4. **Visit FSM rewrite** (`src/visit.js`) — replace HSL scan with: classify-screen → click-coord-from-table → verify via pixel-diff → advance state.
5. **Persist baselines** — currently every session re-records the friend-farm RGB sample. Cache them keyed by screen-class.

## Bridge command reference (current)

| cmd | purpose |
|---|---|
| `ping` | sanity check — returns `{ok, canvas:[w,h], ready}` |
| `glSpy` | full GLSpy stats |
| `glSpyFp` | last-frame fingerprint (textures + programs + draw counts) |
| `glSpyTextures` | every texture ID GLSpy has seen, with source info |
| `glSnap(name)` | save a snapshot under `name` into `window.__hcSnaps` |
| `glDiff(prevName, currName)` | diff two saved snapshots |
| `glWindow(durationMs)` | accumulate transient textures over a window |
| `clickAt(x, y)` | dispatch full pointer/mouse sequence at canvas (x, y) |
| `eval(body)` | escape hatch — body is wrapped in `new Function`, must `return` |
