# 03 — PIXI Scene-Graph Discovery: Findings

Status: **Blocked**. The PIXI scene-graph pivot (see `02-pixi-scenegraph-pivot.md`) cannot proceed against this build of the game.

## What we found

`window.PIXI` is exposed in the iframe and contains a full set of classes:

```
AbstractRenderer, AbstractLoader, BLEND_MODES, BinaryBuffer, Bounds,
CanvasRenderer, Circle, Container, DisplayObject, DisplayPlugin,
EventEmitter, Filter, FilterGroup, FilterManager, GLBuffer, GLShader,
Graphics, GraphicsData, Matrix, Mesh, MeshShaderFactory, NineSlicePlane,
ObservablePoint, ParticleContainer, Plane, Point, Polygon, Quad,
Rectangle, RenderTarget, Resources, RoundedRectangle, SHAPES, Sprite,
Stage, Text, TextMetrics, TextStyle, Texture, TexturePack,
TextureRenderTarget, TextureSource, VertexArrayObject, WebGLRenderer,
ZipLoader, ZipTextureSource, createRenderer, defaultVert, utils
```

Notable: there is **no `PIXI.Application`** class — this is a custom/forked build (likely PIXI v3-era custom). The root scene class is `Stage` (not `Container`).

`utils` only contains `hex2rgb / hex2string / rgb2hex / premultiplyRgba / nextPow2` — there is no `TextureCache` to walk.

## What does NOT work

We attempted every well-known recovery path. None of them worked:

| Approach | Result |
|---|---|
| Known globals (`__PIXI_APP__`, `app`, `game`, etc.) | Not present |
| Walk `window` for any object with `.stage + .renderer` | Zero hits |
| `PIXI.utils.TextureCache` walk | `TextureCache` missing |
| PIXI Devtools hook (`__PIXI_DEVTOOLS_GLOBAL_HOOK__`) | Not registered |
| Canvas back-refs (`__pixi_app`, etc.) | None |
| WebGL context back-refs (`__pixi_renderer`, etc.) | None |
| Hook `WebGLRenderer.prototype.render` | **Never fires** |
| Hook `WebGLRenderer.prototype.clear/flush/bindRenderTarget` | **Never fires** |
| Hook `Stage.prototype.processHit/containsPoint` | Never fires (not even on click) |
| Hook `Container.prototype.addChild` | Never fires |
| Hook `requestAnimationFrame` | Game uses cached pre-hook reference |
| Inspect static fields on `WebGLRenderer`, `AbstractRenderer`, `Stage` | All empty |
| Symbol keys on canvas / gl context | None |
| Listener inventory on canvas | None |

## Conclusion

The game's bundled code carries its **own private copy** of the PIXI classes inside its module closure. The `window.PIXI` namespace is exposed (likely for plugin compatibility) but **nothing actually uses it**. Our hooks on the public prototypes therefore have zero effect on the live renderer / stage / scene graph instances.

There is no exit point from the game's closure: no global registry, no canvas/gl back-reference, no DOM listener leak, no exposed instance.

## What this leaves us with

1. **Return to pixel capture**, but use `canvas.toDataURL()` from inside a single late-frame `gl.drawElements` hook. We already proved one drawcall-time read is reliable; switching from `readPixels` to `toDataURL` removes the Y-flip/coordinate headaches and lets us run real image processing instead of HSL bucketing.
2. **Bypass detection entirely**: drive the game by fixed canvas coordinates. The "В путь!" arrow is always in the same screen position, friend farms always appear under the arrow, "Домой" is always bottom-left. Visit FSM becomes pure timed clicks with no vision at all. Risk: brittle against any UI shift; no idle-detection.
3. **Hybrid coordinate-driven loop with pixel sanity checks**: run option (2) but use a tiny `toDataURL` sample at known pixels (e.g. center of "В путь!" button) to confirm screen-state transitions before/after each click. Cheap, robust, and avoids both the scene-graph dead end and the full-frame HSL pipeline.

Recommended: option **3**.

## Reference: probe code used

Lives in `build.js` bridge handlers — `pixiDeep`, `pixiGlobals`, `enumCanvases`, plus the temporary `eval` command added during this investigation. The `eval` command should be removed before any non-debug build.
