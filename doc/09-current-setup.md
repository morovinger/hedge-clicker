# 09 — Current Setup & How It Works

A reader-friendly map of what's live on the `headless-replay-loop` branch as of 2026-05-03. Earlier docs are still authoritative for protocol details (#05, #06, #08) and historical pivots (#01–#04, #07); this one is the fast on-ramp for "what does this thing do, how do I run it, what should I expect."

## What the project is, in one paragraph

Hedgehog Clicker drives the friend-visit loop in the VK browser game *Ёжики* (`valley.redspell.ru`). The game is a PIXI/WebGL canvas served inside an iframe. Each friend's farm has collectible resources (`ra_leaf`, `ra_dry_grass`, …) that go into the player's inventory. Visiting all candidate friends, sweeping each one for resources, and advancing through the cycle is repetitive busywork — automating it is the goal.

## The two paths we built, and which one is current

Earlier rounds (docs #04, #07) built a **click-driven loop**: synthetic mouse events dispatched onto the canvas via `chrome.debugger`, with feedback from `/proto.html` XHR responses. It works, but it's flaky — the popup *Далее* button moves with the player sprite, hidden tabs hang clicks, and the WebGL canvas doesn't expose object coordinates until calibration.

Doc #08 found a cleaner path: the game's binary RPC over `/proto.html` is small, decodable, and accepts replayed requests. **Every UI button has a corresponding XHR; the canvas is just a renderer**. The current branch (`headless-replay-loop`) drives the entire travel cycle by fabricating those XHRs directly. No clicks, no canvas reads, no calibration. The PIXI canvas desyncs from server state during a run (you'll see the previous farm rendered while the server is two friends ahead) — that doesn't matter because we never read from it.

The click-driven modules (`HC_Visit`, `HC_DbgClick`, `HC_Overlay`, `HC_Capture`) still ship in the bundle for completeness and as a debugging escape hatch, but the active autonomous path is **`HC_Headless`**.

## The travel cycle, in five XHRs

A full friend-visit cycle is exactly five distinct requests. Once you know these, the rest of the system is plumbing.

| # | Request | Body shape | Server response | Effect |
|---|---|---|---|---|
| 1 | **В путь** `5000 073d` | 9-byte header + 32-char placeholder friend hex | `P\0` ack, ~3 KB, list of 10 candidate friend UUIDs | starts the travel cycle |
| 2 | **Enter friend farm** `0500 013d` | 12-byte header + 32-char target friend hex | `\x05\0` farm-load, ~1.77 MB, 1247 records | enters that friend's farm |
| 3 | **Collect** `5000 033d` | header + 36-char friend UUID + type-code + eid + type-name + 32-char random hex | `P\0` ack, ~70 B, with `ra_*` resource delta | collects one object |
| 4 | **Далее** `5000 093d` | 9-byte header + 32-char NEXT friend hex | `P\0` ack + `\x05\0` farm-load (combined) | advances to next friend |
| 5 | (cycle ends) | implicit | server returns user to home state | end of cycle |

Per friend, the loop fires #2 once, #3 up to 20 times, then #4 to move on. Body bytes are constructed by copying a captured template (so the URL skeleton, sid, and most of the bytes are real) and overwriting just the trailing 32 chars with the target friend's hex UUID. No per-game-version byte-order surprises this way.

Doc #08 has the full byte layouts, error codes, and `request_id` rules.

## Module map

The browser-side bundle is eight small modules concatenated into one IIFE by `build.js`. Load order matters because earlier modules install hooks the later ones depend on.

```
glspy → network → dbgclick → capture → scenegraph → overlay → visit → ui
                                                                ↑
                                                  headless lives here
```

What each one does:

| Module | Role | Used by current loop? |
|---|---|---|
| `glspy` | WebGL state hook for offline scene fingerprinting | no |
| `network` | XHR observer + `/proto.html` envelope classifier + replay engine | **yes** — the engine |
| `dbgclick` | `chrome.debugger` mouse-event dispatcher | no (kept for `HC_Visit`) |
| `capture` | canvas locator | no |
| `scenegraph` | PIXI graph discovery | no |
| `overlay` | object-position renderer over canvas | no |
| `visit` | click-driven autonomous visit loop | no (legacy) |
| `headless` | XHR-driven autonomous visit loop | **yes** — the loop |
| `ui` | draggable panel | no (we drive from console) |

The headless loop only depends on `HC_Net` (the XHR observer/classifier/replay engine in `network.js`). Everything else is dead weight for the current path — kept around as it's useful for prototyping new endpoints and as a reference.

## How a `runCycle()` call flows

```
HC_Headless.runCycle()
  │
  ├── fetchFriendList()
  │     ├── replay(latestProtoTemplate, urlMutate→proto=50x7, body=buildVoyage(placeholder))
  │     └── parseVoyageResp(resp)  →  10 friend UUIDs
  │
  ├── for friend in candidates:
  │     │
  │     ├── enterFriendFarm(friend.hex32)
  │     │     ├── replay(template, urlMutate→proto=5x1, body=buildEnterFarm(friend.hex32))
  │     │     └── farm-load (~1.77 MB) returned in r.resp
  │     │
  │     ├── parseFarmLoadV2(farmBytes)  →  1247 records
  │     │     filter by type prefix → ~50 collectibles
  │     │
  │     ├── for object in collectibles (cap ~20 attempts):
  │     │     ├── replay(template, urlMutate→proto=50x3, body=buildCollect(...))
  │     │     ├── if r.ok and parseCollectResp(r.resp) has ra_* → withRes++
  │     │     ├── if r.ok with no ra_* → consecEmpty++ (5 in a row → backpackFull, abort cycle)
  │     │     └── if !r.ok → check error reason; "does not have availible actions" → quotaHit, break
  │     │
  │     └── dalee(nextFriend.hex32)
  │           ├── replay(template, urlMutate→proto=50x9, body=buildDalee(nextFriend.hex32))
  │           └── farm-load returned in r.resp (or pulled from ring after 5s)
  │
  └── log "=== END (visited=N, loot: ra_leaf:X ra_dry_grass:Y) ==="
```

Per-friend you'll see `tried=20 ok=12 (loot:12 empty:0) err=8 QUOTA`. The 12-cap is a server-side daily limit per friend; the 8 errors are non-collectible objects (most are `0x32` "wrong type/state", harmless rejections that don't consume quota or corrupt anything). Doc #08's "Error response taxonomy" has the breakdown.

## The two non-obvious bugs we hit and fixed

If you're picking this up, the diffs from `main` worth understanding:

1. **`replay` returned only 64 bytes of preview hex.** Callers had to fish the response back out of the 32-entry ring, but under load the game's own retry traffic evicts our entries. Symptom: log lines showed a `P\0 04 3d ...Exp...Coins...ra_leaf` payload (a sibling success ack) while the err counter still incremented. **Fix:** `HC_Net.replay` returns full `resp` bytes; `enterFriendFarm`, `dalee`, `collectAll` consume `r.resp` directly.

2. **Cross-realm `instanceof ArrayBuffer`.** Hot-patches injected via main-frame `eval` create ArrayBuffers in the page realm; the wrapper checks against the iframe's `ArrayBuffer`; cross-realm `instanceof` returns false; `bodyToBytes` returns null; ring records `req=null` for our XHR. Doesn't matter for normal extension use (everything's in the iframe realm naturally), but for any future MCP-based debugging via `javascript_tool`, inject patches via a `<script>` element appended to the iframe document, not via `eval`.

## Running it

The extension auto-injects on `https://valley.redspell.ru/` (and the VK wrapper URLs). Assuming you're signed into VK in the same Chrome profile and the game has loaded:

Open DevTools on the game tab. Console:

```js
// Bind once (game's iframe is same-origin on the bare URL)
HH = document.querySelector('iframe').contentWindow.HC_Headless

HH.help()                       // print usage
HH.runCycle()                   // full 10-friend cycle, default options
HH.runCycle({ maxFriends: 1 })  // debug a single friend
HH.runCycle({ interMs: 200 })   // slower per-collect spacing (default 80 ms)
HH.stop()                       // abort
HH.getLog().slice(-30)          // last 30 log lines
```

Expected for a clean run, all-fresh-quota:

```
=== headless cycle START ===
В путь fired: env=P respLen=3458
parsed 10 friends from В путь response
cycle plan: up to 10 friends (will stop on backpack-full)
— friend 1/10 uuid=...
  enter result: env=\x05 ok=false load=true respLen=1771820
  parsed 1247 total / 50 collectibles: pl_tomato:2 ...
  collect pass: tried=20 ok=12 (loot:12 empty:0) err=8 QUOTA
    loot: ra_leaf:12 ra_dry_grass:2
  Далее → ...   env=P ok=true respLen=39824
  ... (8 more friends) ...
=== headless cycle END (visited=10, quotaHits=10) loot: ra_leaf:120 ra_dry_grass:27 ===
```

Total time ≈ 3 minutes 30 seconds. Exact loot mix varies (`ra_dry_grass` is the bonus drop; counts shift by ±2-3 per friend).

### Cycle ends on the travel-prep screen

The canvas will visibly land on the **travel-prep** view (`screenshots/travel-prep.png`), not the player's own farm. That's because the headless path never sends a "back to home" signal — it just iterates the candidate list and stops. Cosmetic only: since the loop is XHR-only and reads nothing from the canvas, you can fire `HH.runCycle()` again immediately. Server state is consistent; the only practical limit on back-to-back runs is that all 10 candidate friends are now at quota until the next daily reset (timing unverified, see open question 7 in doc #08).

## When to reload what

The Chrome extension caches the bundled content script. After editing `src/*.js`:

1. `node build.js` — regenerates `chrome-ext/iframe-script.js` and `clicker.js`.
2. **Reload the extension** at `chrome://extensions` (↻ button on the entry).
3. **Reload the game tab.**

Skipping step 2 will keep the old code running even if you reload the page. Skipping step 3 will keep the previous module instances active (everything is `if (window.HC_X) reusing`-guarded, so re-injection is a no-op).

## When to reload the game tab

Server-side travel state can drift if a previous cycle was interrupted partway. Symptom: every collect immediately returns `0x02` 11-byte errors (no text, no quota message — just bare rejection). Cure: F5 the game tab. The server re-hydrates from the user's persistent state; the cycle starts clean.

## Files at a glance

```
src/
├── network.js     HC_Net  — XHR wrapper, ring, parsers, replay engine
├── headless.js    HC_Headless — runCycle, fetchFriendList, enterFriendFarm,
│                                 collectAll, dalee, body builders
├── visit.js       HC_Visit (legacy click-driven loop)
├── dbgclick.js    HC_DbgClick (legacy click dispatcher)
├── overlay.js     HC_Overlay (legacy)
├── capture.js     HC_Capture (legacy)
├── scenegraph.js  HC_Scene (diagnostic)
├── glspy.js       HC_GLSpy (offline)
└── ui.js          HC_UI (legacy panel)

chrome-ext/
├── manifest.json
├── background.js          — chrome.debugger session for HC_DbgClick
├── iframe-script.js       — generated bundle, document_start
├── iframe-isolated.js     — postMessage bridge for DbgClick
└── popup.html, popup.js   — toolbar icon UI

build.js                    Concatenates src/ into clicker.js + chrome-ext/iframe-script.js
clicker.js                  Generated paste-bundle (DevTools fallback)
```

## See also

- **doc/05** — the original `/proto.html` discovery (envelope kinds, totalOk/Err/Tick classification).
- **doc/06** — farm-load record format. Parser there is now obsolete; the v2 parser in `headless.js` works on both the old (delimiter) and current (no-delimiter) formats.
- **doc/07** — the click-driven loop. Useful as the contrast case: same goal, different (worse) path.
- **doc/08** — protocol & replay engine deep dive. Error code taxonomy, `request_id` rules, body byte layouts, the headless module's full status. Read this before changing anything in `network.js` or `headless.js`.
