# Hedgehog Clicker — Design Notes

This folder is the project's design log. Numbered files are written in order; later files build on earlier ones.

| # | Topic | Status |
|---|-------|--------|
| [01](01-pixel-capture-attempt.md) | Pixel-capture via WebGL hook | Abandoned — kept as reference |
| [02](02-pixi-scenegraph-pivot.md) | PIXI scene-graph access | Abandoned — PIXI is exposed but not used by the game |
| [03](03-pixi-discovery.md) | PIXI discovery findings | Done — pivot blocked, options listed |
| [04](04-glspy-pixel-diff.md) | GLSpy + pixel-diff click detection | Working primitive — needs calibration |
| [05](05-network-api-discovery.md) | Game API discovery (binary RPC over `/proto.html`) | Live capture — path to fully headless |
| [06](06-farm-state-decoding.md) | Decode farm-load XHR for resource positions | Planning — replace blind sweep |

Source code lives in `../src/`. The main project README is `../README.md`.
