# Attempt #1 — Pixel-capture via WebGL hook (abandoned)

This document records the first approach we built and why we are pivoting away from it. Code in this document is **historical reference**; the live code is moving to a PIXI scene-graph approach (see `02-pixi-scenegraph-pivot.md` once written).

## Goal

Auto-collect resources in the VK game *Ёжики*, including the "Путешествия" (Travels) flow that walks the hedgehog across multiple friend farms. The bot needs to:

1. Detect resource-ready badges (purple "12" markers on houses).
2. Click them via synthetic pointer events on the canvas.
3. When no badges remain on a farm, click "Домой" to advance to the next friend.
4. Stop when the daily-help bars fill up and the game returns to the travel hub.

## Architecture we built

The game runs inside a cross-origin iframe (`valley.redspell.ru/play/vk/index.html`) embedded on `vk.com`. PIXI.js renders to a single 1000×700 WebGL canvas with `preserveDrawingBuffer: false`.

We split the code into modules concatenated by `build.js`:

```
src/
  config.js    — HSL color targets and scan parameters (HC_CFG)
  capture.js   — WebGL frame capture (HC_Capture)
  vision.js    — RGB→HSL conversion, scan, clustering (HC_Vision)
  clicker.js   — Click simulation, smart/grid/single loops (HC_Clicker)
  visit.js     — Multi-farm travel FSM (HC_Visit)
  ui.js        — Draggable control panel (HC_UI)
```

Two delivery channels:

- **`clicker.js`** — single IIFE bundle, pasted manually into the iframe's DevTools console.
- **Chrome extension** (`chrome-ext/`) — content script auto-injected into the iframe at `document_start`, plus a `postMessage` bridge so external code (e.g. an MCP-driven test runner) can drive the bot without manual paste.

## The problem we hit

The whole approach depends on `gl.readPixels()` returning the rendered frame so we can color-match badges. But:

1. With `preserveDrawingBuffer: false`, `readPixels()` outside a draw call returns **all black**.
2. PIXI does its rendering across many `drawElements`/`drawArrays`/`drawElementsInstanced` calls per frame: background → sprites → UI badges → overlay. A `readPixels` call after the *first* drawcall captures only the background.
3. To get the full composite, capture must happen on the **last** drawcall of the frame. We cannot know which call is the last while it's happening — we have to predict it from the previous frame's drawcall count.
4. Frame-boundary detection via `requestAnimationFrame` wrap fails because PIXI caches its `requestAnimationFrame` reference at startup, before our content script has a chance to wrap the prototype. Our wrap is bypassed and `drawsLastFrame` never updates.
5. We replaced the RAF wrap with a `setTimeout(1ms)` idle-detector, which works for measuring frame size but doesn't solve the "predict the last drawcall" problem when the count varies between frames — we miss frames whose drawcall count is below the previous frame's.
6. Capturing on multiple drawcalls per frame (to avoid the prediction problem) is expensive: a 1000×700 RGBA `readPixels` is a synchronous GPU pipeline stall (~5–15ms). 30+ captures per frame at 60 fps **froze the renderer**.
7. Earliest version of `capture.js` called `canvas.getContext('webgl2')` preemptively, which **broke PIXI** with a `Cannot read properties of null (reading 'imageSmoothingEnabled')` crash. Once a WebGL2 context is allocated, subsequent `getContext('webgl')` calls return null. Fixed by hooking `HTMLCanvasElement.prototype.getContext` at `document_start` instead, but this introduced its own re-injection / freeze issues.

Even with all the above worked around, the bot still has fundamental brittleness:

- "Purple" matches not just badges but also wooden buildings, banners, parts of the UI, and similar scenery hues. We had to disable the gold target entirely for this reason.
- Cluster sizes vary with badge animation state, occlusion by trees, and zoom level.
- Coordinates from clustering are approximate — we have to add a `+10` Y-offset to land on the house body rather than the badge itself.
- No way to know if a click "took" without re-scanning and inferring from the badge disappearing.

## Why we're pivoting

PIXI maintains a scene graph (`PIXI.Application.stage`) that we can walk directly. Each badge is a real `Sprite` with a known texture name, world transform, visibility flag, and parent container. Reading the scene graph instead of pixels gives us:

- Exact world coordinates from `worldTransform.tx, ty` — no clustering required.
- Stable identification by `texture.textureCacheIds` or by walking from a known parent container — no color heuristics.
- Visibility / interactivity state without re-scanning.
- Zero `readPixels` calls — no GPU stall, no freeze.

The rest of this folder (`02-` onward) will document the new approach.

## Reference: capture.js (final pixel-capture version)

The version reproduced below is the last one we shipped before pivoting. It hooks `HTMLCanvasElement.prototype.getContext` at `document_start`, attaches to whatever WebGL context PIXI requests, wraps every draw method, and captures one frame per `requestFrame()` call using a setTimeout-based idle detector for frame-end.

```js
// src/capture.js — pixel-capture approach (abandoned)
//
// Hooks HTMLCanvasElement.prototype.getContext at document_start so we can
// piggy-back on whatever WebGL context PIXI creates (no preemptive creation
// — that would steal the context type and break PIXI with a null-ctx crash).

if (window.HC_Capture) {
  console.log('[HC] Capture already installed — reusing.');
} else {
window.HC_Capture = (function() {
  let canvas = null;
  let gl = null;
  let frameData = null;
  let captureRequested = true;
  let totalDrawCalls = 0;
  let drawsThisFrame = 0;
  let drawsLastFrame = 0;
  let drawsLastFrameValid = false;
  let frameEndTimer = null;
  let missedFrames = 0;
  const wrappedNames = [];
  const readyCallbacks = [];

  function maybeCapture() {
    totalDrawCalls++;
    drawsThisFrame++;

    if (frameEndTimer) clearTimeout(frameEndTimer);
    frameEndTimer = setTimeout(() => {
      if (drawsThisFrame > 0) {
        if (captureRequested) {
          missedFrames++;
          if (missedFrames >= 2) drawsLastFrame = drawsThisFrame;
        } else {
          drawsLastFrame = drawsThisFrame;
        }
        drawsLastFrameValid = true;
      }
      drawsThisFrame = 0;
      frameEndTimer = null;
    }, 1);

    if (captureRequested && drawsLastFrameValid && drawsThisFrame >= drawsLastFrame) {
      try {
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        frameData = { data: pixels, width: w, height: h, time: Date.now() };
        captureRequested = false;
        missedFrames = 0;
      } catch(e) {}
    }
  }

  function wrap(obj, name) {
    const orig = obj[name];
    if (typeof orig !== 'function') return false;
    obj[name] = function() {
      orig.apply(obj, arguments);
      maybeCapture();
    };
    return true;
  }

  function attachToContext(c, ctx) {
    if (gl) return;
    canvas = c;
    gl = ctx;
    for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced',
                     'drawArraysInstanced', 'drawRangeElements']) {
      if (wrap(gl, n)) wrappedNames.push(n);
    }
    try {
      const ext = gl.getExtension && gl.getExtension('ANGLE_instanced_arrays');
      if (ext) {
        for (const n of ['drawElementsInstancedANGLE', 'drawArraysInstancedANGLE']) {
          if (wrap(ext, n)) wrappedNames.push('ext.' + n);
        }
      }
    } catch (e) {}
    while (readyCallbacks.length) {
      try { readyCallbacks.shift()(); } catch (e) { console.error(e); }
    }
  }

  // Hook getContext on the prototype (document_start ensures we beat PIXI).
  const proto = HTMLCanvasElement.prototype;
  const origGetContext = proto.getContext;
  proto.getContext = function(type, ...rest) {
    const ctx = origGetContext.call(this, type, ...rest);
    if (!gl && ctx &&
        (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      attachToContext(this, ctx);
    }
    return ctx;
  };

  // Paste-mode fallback: probe non-default-size canvases for an existing context.
  for (const c of document.querySelectorAll('canvas')) {
    if (c.width === 300 && c.height === 150) continue;
    let ctx = origGetContext.call(c, 'webgl2');
    if (!ctx) ctx = origGetContext.call(c, 'webgl');
    if (ctx) { attachToContext(c, ctx); break; }
  }

  return {
    get canvas() { return canvas; },
    get gl() { return gl; },
    requestFrame() { captureRequested = true; },
    getFrame() { return frameData; },
    isReady() { return !!gl; },
    whenReady(cb) { gl ? cb() : readyCallbacks.push(cb); },
    // ...debug helpers omitted
  };
})();
}
```

## Reference: vision.js (HSL detection + clustering)

```js
// src/vision.js — color-based detection (kept as fallback)

window.HC_Vision = (function() {
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  function scanFrame(frameData, cfg) {
    if (!frameData) return [];
    const { data, width: w, height: h } = frameData;
    const step = cfg.scanStep;
    const hits = [];

    for (let y = cfg.skipTop; y < h - cfg.skipBottom; y += step) {
      for (let x = 10; x < w - 10; x += step) {
        const fy = h - 1 - y; // WebGL Y-flip
        const i = (fy * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r === 0 && g === 0 && b === 0) continue;
        const [hue, sat, lit] = rgbToHsl(r, g, b);
        for (const t of cfg.targets) {
          if (hue >= t.hMin && hue <= t.hMax &&
              sat >= t.sMin && sat <= t.sMax &&
              lit >= t.lMin && lit <= t.lMax) {
            hits.push({ x, y, name: t.name });
            break;
          }
        }
      }
    }

    // Single-pass greedy clustering.
    const clusters = [];
    const used = new Set();
    const r2 = cfg.clusterRadius * cfg.clusterRadius;
    for (let i = 0; i < hits.length; i++) {
      if (used.has(i)) continue;
      let sx = hits[i].x, sy = hits[i].y, cnt = 1;
      used.add(i);
      for (let j = i + 1; j < hits.length; j++) {
        if (used.has(j)) continue;
        const dx = hits[j].x - hits[i].x, dy = hits[j].y - hits[i].y;
        if (dx * dx + dy * dy < r2) {
          sx += hits[j].x; sy += hits[j].y; cnt++;
          used.add(j);
        }
      }
      if (cnt >= cfg.minCluster) {
        clusters.push({
          x: Math.round(sx / cnt),
          y: Math.round(sy / cnt),
          count: cnt,
          name: hits[i].name,
        });
      }
    }
    return clusters;
  }

  function samplePixel(frameData, cx, cy) {
    if (!frameData) return null;
    const { data, width: w, height: h } = frameData;
    const fy = h - 1 - cy;
    const i = (fy * w + cx) * 4;
    return { r: data[i], g: data[i+1], b: data[i+2],
             h: rgbToHsl(data[i], data[i+1], data[i+2])[0],
             s: rgbToHsl(data[i], data[i+1], data[i+2])[1],
             l: rgbToHsl(data[i], data[i+1], data[i+2])[2] };
  }

  return { rgbToHsl, scanFrame, samplePixel };
})();
```

## Reference: clicker.js (click simulation)

The synthetic event sequence to drive PIXI's `InteractionManager`:

```js
function click(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const clientX = rect.left + cx / sx;
  const clientY = rect.top + cy / sy;
  const o = { clientX, clientY, bubbles: true, cancelable: true, view: window };
  canvas.dispatchEvent(new PointerEvent('pointerdown', o));
  canvas.dispatchEvent(new MouseEvent('mousedown', o));
  canvas.dispatchEvent(new PointerEvent('pointerup', o));
  canvas.dispatchEvent(new MouseEvent('mouseup', o));
  canvas.dispatchEvent(new MouseEvent('click', o));
}
```

This part **stays valid for the new approach** — once we have world coordinates from the scene graph, we still dispatch the same event sequence to the canvas at the corresponding client coordinates.

## Reference: visit.js (Travels FSM)

The multi-farm walker. Logic stays the same in the new approach; only the "find badges" call changes from `vision.scanFrame(frameData, cfg)` to a scene-graph walker.

```js
// FSM:
//   FRIEND_FARM ─ click purple badges ─► (no badges for ~5s) ─ click "Домой" ─►
//   FRIEND_FARM (next friend, auto-advanced by game) ─► loop
//   stop when "Домой" produces no state change for N retries (= bars full).

const BTN = {
  home:   { x: 80,  y: 660 }, // "Домой" — bottom-left blue button
  voyage: { x: 765, y: 260 }, // "В путь!" — only on TRAVELS_HUB
};

// Loop each scanInterval:
//   1. Capture frame, scan for badges.
//   2. If badges > 0: click them all, reset miss counter.
//   3. If 3 consecutive empty scans: click BTN.home, increment retry counter.
//   4. If maxHomeRetries reached without finding more badges: stop.
```

## Lessons learned

1. **Don't fight the renderer.** If a game has a structured representation (PIXI scene graph, DOM, accessibility tree), use it instead of pixel-reading.
2. **Hook timing matters.** Anything that has to be installed before the page's own scripts must use a `document_start` MAIN-world content script and prototype-level patching. RAF and other wrapped methods can be cached by the page before our wrap, defeating it.
3. **Idempotent installation is mandatory.** Every hook must check `if (window.__alreadyInstalled)` and bail. Extension reload re-injects content scripts into the same MAIN world without clearing prior state, so re-wrapping stacks layers of overhead and freezes the renderer.
4. **`gl.readPixels` is a sync GPU stall.** Treat it as an expensive, once-per-N-frames operation, not something you can call dozens of times per frame.
5. **Color matching needs domain knowledge of the game's palette.** "Purple" caught violet flowers and wooden roof shadows; "gold" caught sunflowers, hay, and wood. HSL bounding boxes alone aren't enough without spatial filtering or masks tied to UI regions.
