# 06 — Farm-state decoding (resource positions from XHR)

## Why

Blind grid sweeps work but waste ~40s/farm and miss clustered resources. The
game already knows where every collectible is — it has to render them. That
data arrives over `/proto.html` when the friend-farm screen loads. If we
parse the response, we get exact `(x, y)` per object and drop the sweep
entirely.

Status from previous sessions:
- HC_Net captures every `/proto.html` response (raw `ArrayBuffer`).
- Success envelope is `0x50 0x00`; rest of the body is opaque binary.
- Body hash + URL builder live in the bundled blob; we can read but not
  fully replay (closure-bound `request_id`, `sender`).
- We can still **observe** all responses without replaying anything.

## Plan

### Step 1 — Capture a known farm-enter response

1. User navigates to a fresh friend farm.
2. Extension records the next 1–2 `/proto.html` responses verbatim
   (timestamp, request body, response bytes).
3. Save as a hex dump alongside a screenshot of the farm so we can match
   visible resources to byte patterns.

Add a buffered recorder to `HC_Net`:
- Ring buffer of last N (request, response) pairs.
- Bridge command `netDump` → returns last N as base64 (or decimal arrays
  to dodge MCP base64 filter).

### Step 2 — Find the load opcode

The session opens many requests; we need to identify which one is "load
friend farm" vs "tick", "click", "ping". Heuristics:
- Largest response in the burst right after farm transition (state >> ack).
- Repeats across farm enters but with different payloads.
- Probably keyed by the same opcode byte at a fixed offset in the request.

Compare 2–3 farm-enter captures to spot the pattern.

### Step 3 — Decode object list

Once we have the load response isolated, look for repeating record
structures. Likely shape per object:
- 1–2 byte type id (tree, stone, seedbed, etc.)
- 2 bytes x, 2 bytes y (or floats)
- state flags (ready/empty/cooldown)

Cross-reference with what's visually on screen:
- Count visible resources, count records.
- Check x/y ranges line up with canvas (1000×700-ish in game coords,
  possibly with an offset/scale).

### Step 4 — Live extractor

If the format holds, expose `HC_Net.lastFarmObjects()` returning
`[{type, x, y, state}, ...]`. `visit.js` then iterates that list instead
of the 14×9 grid. Click count drops from 126 to ~5–15 per farm.

### Step 5 — Coordinate mapping

Game coords ≠ canvas pixel coords (scenegraph has scale + camera). Two
options:
- Empirically: collect known clicks (we have `hitCoords` from past sweeps)
  + visible state; fit a transform.
- Read from PIXI: the stage transform exists in the engine. We poked at
  this in doc 02/03 — PIXI is private but `gl` calls expose viewport
  matrices. May be easier to just brute-fit.

## Open questions

- Is the response gzip/deflate compressed? (Check first 2 bytes after
  envelope for `0x78 0x9c` etc.)
- Is there an XOR/scramble layer? (Hash function suggests body integrity
  check, but payload may still be plain.)
- Are coordinates in pixels, tiles, or world units?

## Next concrete action

1. Add ring-buffer + `netDump` to `src/network.js`. ✅
2. Add `netDump` command to `chrome-ext/iframe-script.js` bridge. ✅
3. User enters one fresh friend farm; we dump the 2–3 responses around
   the transition. ✅
4. Hex-stare at the largest response, look for repeating record sizes. ✅

## Session results (first capture)

### Envelope correction

Two response families on `/proto.html`:
- Main farm / VK shell traffic: starts with `0x30 0x00` (ASCII `'0\0'`).
  Our previous "ok" check (`0x50 0x00`) classified all of these as
  errors. Manifests as `totalOk:0, totalErr:91` on a working main farm.
- Friend-farm traffic: starts with `0x50 0x00` (`'P\0'`) — the original
  assumption was correct here.

Fix: `HC_Net` should treat both as success envelopes (or just use
`xhr.status === 200`). The opcode discrimination is a nice-to-have, not
required for the success oracle.

### Farm-load packet

After entering a friend farm, one ~67 KB response shows up (vs 2.8 KB
state-poll responses). Same farm-state response is repeated by polling.

Header bytes: `50 00 02 3D 00 E7 0D 01 00 24 00` then ASCII
`<UUID>` (the farm-id).

### Object catalog

Top entries from the 67 KB response (uniqued by string, sorted by
count). Prefix taxonomy:
- `te_*` — trees (collectible fruit) — `te_apple:8 te_lemon:8 te_cocoa:7 te_linden ...`
- `sb_*` — seedbeds (collectible) — `sb_seedbed:40`
- `pl_*` — plants (collectible) — `pl_broccoli:17 pl_corn:11`
- `tl_*` — tiles (decoration / ground) — `tl_wood_1:428 tl_mud:124 ...`
- `dc_*` — decorations — `dc_lamp_3:21 dc_bush_1:16 ...`
- `ga_*` — garden / grass — `ga_grass2:37 ga_grass3:35 ...`

This catalog matches what the eye sees on a friend farm: ~8 apple trees,
40 seedbeds, etc. So the load packet definitely contains every object.

### Record format (partial)

Each object is encoded as a fixed-stride record (34 bytes for an 8-char
type string). Layout:

```
offset  bytes  meaning
0       4      int32 LE — constant -13 (0xFFFF_FFF3) — possibly Z-layer
4       4      int32 LE — varies, small range incl. negatives — UNKNOWN
8       2      uint16 LE — type-string length (e.g. 8 for "te_apple")
10      N      ASCII type string
10+N    1      0x00
11+N    2      flags 0x06 0x01
13+N    4      entity_id (4 random bytes — unique per record)
17+N    4      constant 0x41DA7BCA (`202,123,218,65`) — same across many
                records of the same type → likely class fingerprint /
                hash
21+N    1      0x00
22+N    4      int32 LE — monotonically growing across records (152 →
                12046+ for trees) — likely render-order / packed index
```

Total: 26 + N bytes per record.

### Coordinates: world coords found (split bytes, not packed int)

Re-reading the trailing 4 bytes as **(byte0, byte1)** (two `uint8`), not
as a single int32, gives clean isometric world coords for every record:

```
te_apple  (111, 2),  (112, 2)   ← pair, x adjacent on row 2
te_apple  (109, 3),  (110, 3)   ← pair on row 3
te_lemon  ( 78,10),  ( 79,10)   ← pair on row 10
te_lemon  ( 51, 5)
te_apple  (202,12), te_lemon (201,12)   ← adjacent across types
te_cocoa  (  6,39), te_linden (7,39), te_cocoa (8,39)  ← 3 in a row
te_cocoa  (249,24), (250,24)
```

X range observed: 6–250.  Y range: 0–~100.  Likely **world tile coords**
in an isometric projection. Pixel coords on the 1000×700 canvas need a
calibration step (one known click anchor → solve transform).

Bytes 2–3 of the trailing field were always 0 in this capture (small
farm). For larger maps they may carry high bits — keep parser tolerant.

### Click oracle validated end-to-end

Test: one MCP `computer.left_click` at screen `(820, 195)` (an
orange-fruit cluster on the visible friend farm).

Result:
- `HC_Net.totalOk` +16 within 1.5 s
- Backpack: wood 0/120 → 2/120, stones 0/115 → 1/115
- "+6" floating UI text visible
- The clicked orange cluster removed from screen

Confirms:
- The `0x50 0x00` envelope check IS the right success oracle for
  collects (0x30 0x00 is background tick, correctly excluded).
- One click can harvest a multi-fruit tree (game cascades the
  collection — ~16 POSTs per tap on a ripe cluster).
- Real OS-level pointer events register; only `isTrusted:false`
  synthetic events are filtered.

### Path A shipped — end-to-end working

Implemented `chrome.debugger` backend (commit ready):
- `chrome-ext/manifest.json` — added `"debugger"` permission, `background` service worker, second content script in ISOLATED world.
- `chrome-ext/background.js` — owns the debugger session, exposes `Input.dispatchMouseEvent` via `HC_DBG_CLICK` messages.
- `chrome-ext/iframe-isolated.js` — postMessage ↔ `chrome.runtime.sendMessage` bridge.
- `src/dbgclick.js` — MAIN-world `window.HC_DbgClick.{click,probe,listTargets}` API.
- `src/visit.js` — `click()` now prefers `HC_DbgClick`, falls back to synthetic events if the bridge isn't loaded.

Ran a live session on the **standalone URL** (see below):
- 3 sweeps, 373 attempts, 77 collects, 1 farm advanced cleanly.
- `totalOk:77 / totalSeen:78` — basically every successful click registered.
- "Далее" navigation worked at canvas (221, 661) under a stretched 1178×1223 CSS canvas; `visit.js`'s `sx/sy` scaling covered it.

### Standalone URL discovery

`https://valley.redspell.ru/play/vkjs/index.html?viewer_id=<VK_ID>` runs
the game directly, no vk.com iframe. Three benefits:
1. No cross-origin iframe complexity — the game is the top-level page.
2. No VK captcha popups interrupting the session.
3. Different tab from where Claude-in-Chrome MCP attaches its debugger
   → no debugger-attach conflict. (Coexistence on the iframe path
   would require disabling MCP, since `chrome.debugger` is exclusive
   per target.)

This is now the recommended environment for both development and
production runs of HC_Visit.

### Coexistence with Claude in Chrome MCP

`chrome.debugger.attach` is **exclusive per target**. MCP attaches to
the vk.com tab to drive its own automation. Two debuggers on the same
target is not supported by the API — they fight, with the most-recent
attach winning and the loser getting "Detached" errors.

Resolution: use the standalone valley.redspell.ru URL (different tab,
no conflict). MCP can keep running on its own targets at the same time.

### Path forward

Two click backends:

**B (validated today)** — MCP `computer` clicks. Works, but:
- Requires the tab to be focused
- Slow (one HTTP round-trip per click via MCP)
- Breaks if the user moves the mouse / window

**A (next implementation)** — `chrome.debugger` API. The extension
attaches to the page as a debugger and uses `Input.dispatchMouseEvent`,
which produces `isTrusted: true` events. Fast, works in background tabs,
no user interaction needed.

Implementation steps:
1. Add `"debugger"` to extension manifest permissions.
2. New background-script command channel: extension content script
   posts `{type:'HC_DBG_CLICK', x, y}` to extension service worker;
   service worker calls `chrome.debugger.attach` then
   `Input.dispatchMouseEvent` (mousePressed + mouseReleased).
3. Wire `HC_Visit.click()` to use the debugger backend when available;
   fall back to synthetic dispatch only for environments without the
   permission.

Two candidate fields hold positional info but neither is plain pixels:

- The trailing int32 (offset `22+N`) grows monotonically. Across 8
  apples: `152, 623, 624, 877, 878, 1327, 3274, 3411`. Pairs that
  differ by 1 (623↔624, 877↔878) suggest tree-pair placements with
  packed coords (e.g. `y * SCALE + x` for some scale).
- The signed varying int32 at offset 4 ranges over `{26, 22, 18, 22,
  18, 30, -12, -9, -2, -6, 1, 5, 8, -17, -25, -27, ...}` — tight
  enough to be one of (z, layer, isometric_offset, tile_y).

Hypotheses to test next session:
1. `(world_x, world_y)` = `(trailing % K, trailing / K)` for some K
   (try 64, 128, 256, 1000).
2. `(x, y) = (trailing, header_b)` — probably wrong because monotonic.
3. The trailing int32 is a tile/cell index into a separate map section
   we haven't decoded yet (look for a 2D array or another big region in
   the response).

### Validation strategy

Once a candidate (x, y) decoder is chosen:
1. Project all `te_*` positions onto an overlay canvas at scale K.
2. User screenshots the friend farm.
3. Compare overlay to screenshot — pick K that makes the dots land on
   visible trees.

Alternative: use the existing GLSpy/pixel-diff to detect tree positions
on screen, then back-solve the transform from `(packed_value) →
(screen_x, screen_y)`.

### Concrete next action

1. Fix `HC_Net` to use `xhr.status === 200` instead of envelope check.
2. Persist the captured 67 KB response to disk (extension → downloads
   API or `chrome.storage`) so we can iterate offline without re-entering
   a farm each time.
3. Build a tiny renderer: dot per record at candidate coords, overlaid
   on the canvas. Iterate K until dots align.
4. Once aligned, expose `HC_Net.lastFarmObjects()` returning
   `[{type, x, y}, ...]` filtered to collectibles.
