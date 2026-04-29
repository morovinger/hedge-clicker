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

Source code lives in `../src/`. The main project README is `../README.md`.

## Two URL forms — `/play/vkjs/` (proper) vs `/play/vk/` (improper)

The game is reachable at two different paths on `valley.redspell.ru`:

| Path | Auth scheme | UI | Status |
|------|-------------|-----|--------|
| `/play/vkjs/index.html` | VK ID / OAuth (`secret=oauth&sid=&sig=`) | clean, no widgets | **proper — what we want** |
| `/play/vk/index.html` | Legacy VK Apps (`auth_key=&sign=&access_token=&...`) | VK widgets overlay the canvas and intercept clicks | **improper — interferes with automation** |

The two schemes use different signatures and aren't interchangeable —
you can't lift `sid+sig` from one and paste it into the other.

The extension's URL-capture policy:

- **`vk-launcher.js`** persists only `/play/vkjs/` URLs to
  `chrome.storage.local.lastGameUrl`. If it sees `/play/vk/` instead
  (which is what `vk.com/ezhiky_game` typically embeds), it logs a
  hint and ignores the URL.
- **`iframe-isolated.js`** captures `/play/vkjs/` URLs the moment you
  load one in any tab — including a manual paste. Once you've
  loaded a working vkjs/ URL once, the toolbar icon will re-open
  it directly thereafter.
- **`background.js`** (toolbar action) checks `expire=` before
  reusing a stored URL; routes back to the VK launcher to refresh
  if expired.

If `vk.com/ezhiky_game` only ever yields the legacy `/play/vk/`
form, you'll have to load the vkjs/ form once manually to seed the
capture. Subsequent opens come from the toolbar.

## Game URL & authentication

The standalone game URL has the shape:

```
https://valley.redspell.ru/play/vkjs/index.html?viewer_id=<VK_ID>&expire=<UNIX_TS>&secret=oauth&sid=<VK_SESSION>&sig=<HMAC>&is_app_user=1
```

Three of the params are **time-bounded credentials** issued by VK SSO:

- `expire` — Unix epoch seconds. Once past, the server returns **HTTP 500**.
- `sid` — VK session id (`vk1.a.…`).
- `sig` — HMAC over the rest, computed by VK with the app secret.

There is no shorter URL that authenticates: the game has no first-party
login of its own — it trusts the VK signature on every request. Once the
token expires (a few days), the URL is dead and a fresh one must be
issued by VK.

### Getting a fresh URL

The non-interactive way to obtain a fresh URL is to load the VK launcher
(`https://vk.com/ezhiky_game`) **while signed into VK** in the same
profile, click the launch button, and copy the iframe's resolved
`src=` from DevTools. That `src` is the same shape as above with fresh
`expire/sid/sig`.

This is tested next session — VK's launcher requires a user gesture to
mount the iframe, so a one-click flow is the floor here unless we wire
the extension to capture the iframe URL automatically (an option, see
below).

### Why "no VK identification" isn't possible

The game server keys all save data on `viewer_id`. Without a VK id +
signature, the server has nothing to look up and no proof of who's
asking. Stripping `viewer_id` doesn't make the game "anonymous" — it
makes it 500.

### Workflow with the extension (shipped in v0.3.0)

The extension now captures fresh URLs for you:

1. Click the **Hedgehog Vision** toolbar icon. If no URL is stored yet
   (or the stored one's `expire=` is past), it opens
   `https://vk.com/ezhiky_game` for you.
2. Sign into VK if prompted. The launcher's auto-click fires for
   "Запустить / Играть / Открыть" buttons; if VK blocks the synthetic
   click, click the launch button yourself.
3. As soon as VK mounts the game iframe, `vk-launcher.js` reads the
   resolved `iframe.src` (which has fresh `expire/sid/sig`) and writes
   it to `chrome.storage.local.lastGameUrl`.
4. Next time you click the toolbar icon, it opens that captured URL
   directly in a new tab — no copy-pasting tokens.

The captured URL is good until its `expire=` lapses (a few days). The
toolbar handler checks expiry and re-opens the VK launcher
automatically when the stored token is dead.

### Untested shortening option

**Cookie persistence** — verify whether `valley.redspell.ru` issues
a session cookie on first successful auth. If yes, after one valid load
the URL could be trimmed to just `?viewer_id=…`. Currently untested
(blocked on a non-expired token); the captured-URL flow above
sidesteps it.
