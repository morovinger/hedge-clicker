# Approach #2 — PIXI scene-graph access (current direction)

After the pixel-capture path (see `01-pixel-capture-attempt.md`) hit a wall around frame timing and renderer freezes, we are pivoting to reading the PIXI scene graph directly.

## Why this should be much simpler

PIXI maintains a tree of `DisplayObject`s rooted at `Application.stage`. Every visible badge in the game is a `Sprite` with:

- A texture (`sprite.texture`) whose `textureCacheIds` often include the asset path or atlas frame name.
- A world transform (`sprite.worldTransform.tx, ty`) giving its exact position on the canvas.
- A parent chain we can use to identify what kind of object it is (badge under house container, vs. badge in the UI bar).
- An `interactive` flag and bounding box, so we know whether a click would land.

Walking that tree is O(N) over visible nodes, not O(W*H) over pixels. No `readPixels`, no GPU stalls, no draw-call timing, no color heuristics.

## The hard part

The game minifies / obfuscates its bundle, so it almost certainly does **not** expose the PIXI app on a stable global. We have to find it ourselves.

### Discovery options (try in this order)

1. **Hook PIXI before it constructs the app.** At `document_start` in MAIN world, wrap `PIXI.Application` (or whatever the renderer constructor is) so that every instance gets stashed on `window.__hcPixiApp`:
   ```js
   const trap = (proto, name) => {
     const orig = proto[name];
     proto[name] = function(...args) {
       const r = orig.apply(this, args);
       window.__hcPixiApps = window.__hcPixiApps || [];
       window.__hcPixiApps.push(this);
       return r;
     };
   };
   // Once PIXI is loaded:
   const wait = setInterval(() => {
     if (window.PIXI?.Application?.prototype?.init) {
       trap(window.PIXI.Application.prototype, 'init');
       clearInterval(wait);
     }
   }, 50);
   ```
   PIXI may not be exposed under `window.PIXI` — it could be bundled as a private module. In that case, trap at the renderer level instead (`PIXI.Renderer`, `PIXI.WebGLRenderer`).

2. **Hook the canvas → renderer link.** Some PIXI versions assign back-references on the canvas:
   - `canvas._pixiId`
   - The renderer keeps `renderer.view === canvas`
   So if we walk every `WeakRef`-able global, we may find an object whose `.view` matches the game canvas.

3. **Walk `window` looking for objects with a `.stage` and `.renderer`.** Slow and noisy but works for unmodified PIXI installations:
   ```js
   for (const k of Object.keys(window)) {
     const v = window[k];
     if (v && typeof v === 'object' && v.stage && v.renderer?.gl) {
       return v;
     }
   }
   ```

4. **Use PIXI Devtools as the reference implementation.** The extension ([source](https://github.com/bfanger/pixi-devtools)) already solves this discovery problem. Read how it locates the PIXI instance and copy that mechanism. It also gives us a free interactive inspector to learn the badge sprites' texture names and parent containers before we write any walker code.

### Recommended first step

Install **PIXI Devtools** in Chrome, open the game, navigate to a friend farm, and click on a badge in the inspector. Note:

- The texture cache id (e.g. `"badge_purple_12.png"`).
- The parent chain (`stage → world → buildings → house_42 → badge`).
- Whether badges share a class / type field we can filter on.

Once we know what to look for, the walker is ~20 lines of code.

## What stays from approach #1

- **`HC_Clicker.click(cx, cy)`** — synthetic `pointerdown → mousedown → pointerup → mouseup → click` sequence on the canvas. Works regardless of how we found the coordinates.
- **`HC_Visit` FSM** — visit-loop logic (badges → "Домой" → next farm → stop on bars-full). Only the source of badge coordinates changes.
- **`HC_UI` panel** — start/stop, calibration buttons, status display.
- **Chrome extension shell** — content script auto-inject + `postMessage` bridge for programmatic control.

## What gets retired

- `HC_Capture` (WebGL hook + frame buffer). Becomes optional/dead code; can be deleted once scene-graph approach is verified working.
- `HC_Vision.scanFrame` and HSL targets in `HC_CFG.targets`. Replaced by sprite-tree filters.
- `HC_Vision.samplePixel` calibration UI. Replaced by "click an inspector tree node".
- `setHomeBtn` / `setVoyageBtn` calibration coordinates. Probably still useful if PIXI doesn't expose those buttons by name, but we should first check whether the buttons are also sprites in the same scene graph (likely yes).

## Open questions to resolve before coding

1. Does the game expose `window.PIXI` at all? If not, how does PIXI Devtools find it for this specific game?
2. What are the badge texture names / class names? Is there a stable selector (texture id, parent name, custom property)?
3. Are buttons like "Домой" and "В путь!" also PIXI sprites with discoverable identifiers, or are they HTML overlays?
4. Does the scene graph contain off-screen / hidden badges (e.g., for friends not currently visible)? If so, we need to filter by `worldVisible` and bounding-box-on-screen.
5. Click delivery: dispatching pointer events on the canvas at world-transform coordinates should still hit PIXI's `InteractionManager`. Verify there's no offset issue when clicking via world coords vs. canvas-local coords (they should be identical for a fullscreen stage).

## Folder layout going forward

```
src/
  config.js     — kept (badge selectors will live here instead of HSL ranges)
  scenegraph.js — NEW: PIXI app discovery + tree walker (replaces capture+vision)
  clicker.js    — kept (click() reused)
  visit.js      — kept (FSM unchanged; just calls scenegraph instead of vision)
  ui.js         — trimmed (calibration buttons replaced)

doc/
  01-pixel-capture-attempt.md   — why approach #1 was abandoned + reference code
  02-pixi-scenegraph-pivot.md   — this file
  03-...                         — discovery findings and walker design (TBD)
```

## Status

- Not started. Next concrete action: install PIXI Devtools, open the game on a friend farm, document the badge sprite shape in `doc/03-pixi-discovery.md`.
