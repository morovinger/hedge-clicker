# Hedgehog Clicker — Design Notes

This folder is the project's design log. Numbered files are written in order; later files build on earlier ones.

| # | Topic | Status |
|---|-------|--------|
| [01](01-pixel-capture-attempt.md) | Pixel-capture via WebGL hook | Abandoned — kept as reference |
| [02](02-pixi-scenegraph-pivot.md) | PIXI scene-graph access | Abandoned — PIXI is exposed but not used by the game |
| [03](03-pixi-discovery.md) | PIXI discovery findings | Done — pivot blocked, options listed |
| [04](04-glspy-pixel-diff.md) | GLSpy + pixel-diff click detection | Working primitive — needs calibration |
| [05](05-network-api-discovery.md) | Game API discovery (binary RPC over `/proto.html`) | Live capture — path to fully headless |
| [06](06-farm-state-decoding.md) | Decode farm-load XHR for resource positions | Parser shipped — live calibration pending |
| [07](07-autonomous-visit-loop.md) | Autonomous farm-to-farm Visit loop | Working primitive — popup advance + hub bootstrap need live tuning |

Source code lives in `../src/`. The main project README is `../README.md`.

## Game URL

The canonical entry point is the **bare** vendor URL:

```
https://valley.redspell.ru/
```

Provided you're signed into VK in the same Chrome profile, the page
pulls the session from cookies automatically — no `viewer_id`, no
`sid`, no `sig`, no token juggling. The Chrome extension's toolbar icon
opens this URL directly.

The two query-string-heavy URL forms we previously chased
(`/play/vkjs/...?viewer_id=&expire=&sid=&sig=` and the legacy
`/play/vk/...?...&sign=&sign_keys=`) are still issued by VK app launchers
when the game is embedded inside `vk.com`, but going through them is
unnecessary when the bare URL works. `/play/vk/` in particular hosts VK
widgets that overlay the canvas and interfere with click automation.

## Why this matters for automation

- **No iframe.** The game is the top-level document, so injecting and
  using DevTools is straightforward.
- **No VK-side captchas / popups** — the launcher's interstitials never
  appear.
- **No token expiry** — the cookie auto-refreshes server-side; no need
  to capture, store, or rewrite URLs.
- **chrome.debugger doesn't conflict** with Claude-in-Chrome MCP, which
  attaches to its own tab.

This makes `https://valley.redspell.ru/` the supported environment for
all `HC_Visit` / `HC_DbgClick` development and runtime.
