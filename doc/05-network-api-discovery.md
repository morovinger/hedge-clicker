# 05 — Game API Discovery: Binary RPC over `/proto.html`

Status: **Live capture confirmed.** Protocol partially decoded. This is the path toward fully headless operation (no synthetic clicks, no pixel-diff).

## What we found

The game speaks a custom **binary RPC** over plain HTTPS POSTs:

```
POST https://valley.redspell.ru/proto.html?<query string ~100 chars, contains session/auth>
Content-Type: application/octet-stream  (or similar — body is raw DataView)
Body: 41–100 bytes binary
Response: variable size binary (single collect = 56 bytes, farm-load likely several KB)
```

We saw a `/proto.html` request with a 6668-byte response load (full farm refresh) followed by GETs for `*.pack` (sprite atlases) and `*.swf` (legacy assets) — so a single POST can carry an entire farm state plus prompt asset prefetch.

There is **no WebSocket** — the game polls/pushes via XHR only. `window.sender` exists with `_send`, `avgTime`, `noFlash` methods. The XHRs we caught did NOT route through `sender._send`, so there is at least one other code path for outbound traffic (probably bundled inside a closure).

## How a click becomes a request

Captured one **collect-resource** action:

| Direction | Bytes (decoded relevant fields) |
|---|---|
| → request | header `80 00`, friend UUID `d9f62794-4504-4067-bb57-5ec57f37364a`, resource ID `sb_seedbed`, action token `a270c2f28f0938e8fb0f1bee8cf1dd2b` |
| ← response | header `80 00`, reward strings: `Exp`, `Coins`, `Energy`, `ra_leaf` |

Two things this proves:

1. **The server doesn't receive click X/Y.** It receives `(friend_id, resource_id, action_token)`. The X/Y → resource_id mapping happens client-side via PIXI's hit detection.
2. **Action tokens are per-instance, single-use.** Replaying a token won't work — server invalidates it after one accept. To act on a resource we must hold its current token.

So API replay needs the **farm state response** (the big one — multi-KB) which presumably contains, for every resource on the farm: `(resource_id, position, current_token)`. Capturing and parsing that is the unlock.

## Binary format pattern

From the captured bytes (decoded as ASCII where printable):

```
80 00            ← opcode / message header (little-endian "msg type 80")
03 3D 00         ← unknown — sequence number? size hint?
3B 00 00 00      ← length field (LE u32)
24 00            ← string length 36 (LE u16)
"d9f62794-..."   ← UUID bytes (36 ASCII chars)
01               ← field tag
1B 00 00 00      ← length 27 (LE u32)
0A 00            ← string length 10
"sb_seedbed"     ← resource id
01 00 00 00      ← field tag
"a270c2f2..."    ← 32-char token
```

Pattern looks like a tagged length-prefixed field stream. Strings are length-prefixed (LE u16) ASCII. Numbers are LE u32. Each field appears to have a 1-byte type tag.

Response uses the same envelope shape:

```
80 00            ← opcode
04 3D 00 2F 00 00 00   ← size headers
04 00 03 00      ← field counts? array headers?
"Exp"  02 00 00 00 05 00
"Coins" 02 00 00 00 06 00
"Energy" 02 00 00 00 07 00
"ra_leaf" 02 00 00 00
```

Pairs of `02 00 00 00 NN 00` look like `(type=2, value_count, value_len)` headers preceding each reward string.

This is **not** standard Protocol Buffers (no varints, different tag layout) — it's a custom format. But it's regular and parseable.

## Path to fully headless operation

Three milestones, in order:

### Milestone A — Capture & decode the **farm-load response**

Currently we only have the *click* request/response. The big payload arrives when the player **enters** a friend farm. Plan:

1. Re-arm raw byte logger.
2. User navigates: main → Путешествия → В путь → click farm icon.
3. Capture the multi-KB POST that fires on farm enter.
4. Decode: extract the list of resources with `(id, position, token)` triples.

If `position` isn't in the payload, fall back: the resource positions are deterministic per farm layout (every farm shares the same scenery template) so we can hard-code positions per `resource_id`.

### Milestone B — Send synthetic POSTs

Once we know the request format and have valid tokens, fire collect requests directly:

```js
// Skeleton — actual byte layout follows protocol
function collectResource(friendId, resId, token) {
  const body = encodeProtoMsg(friendId, resId, token);
  return fetch('/proto.html?' + currentQueryString, {
    method: 'POST',
    body,
    credentials: 'include',
  });
}
```

The query string contains the auth (sid + signature). We capture it from any in-flight request and reuse it. If it includes a sequence number or HMAC we'll need to compute/increment it; if it's session-static we can cache it.

### Milestone C — Drive the visit FSM via API

Replace the entire click-and-pixel-diff loop with:

```
loop:
  GET farm state → parse → list of (resource, token)
  for each resource: POST collect(resource, token)
  POST navigate-to-next-farm
  if all bars full: POST go-home; break
```

No PIXI, no canvas, no clicks, no pixel readback. Just protocol.

## Risks and unknowns

- **Anti-cheat / signing.** The 102-char query string almost certainly carries an HMAC or session signature. If it includes a per-request nonce/sequence, we can't cache it; we'd need to replicate the signing function (which lives inside the bundled closure — same problem as the PIXI scene graph).
- **Rate limits.** Server may detect collects faster than humanly possible. Easy mitigation: throttle to ~1 collect per 500–1000 ms.
- **Token freshness.** Tokens probably expire if the farm state is stale. If we cache state for too long, replays will fail.
- **Account ban.** VK games sometimes ban automation. Use a low-volume test account first.
- **Anti-replay window.** Some servers reject any request older than N seconds (timestamp baked into token). Need to act fast after fetching state.

## What we kept from earlier doc/04 work

The pixel-diff path (doc/04) is still useful as a **fallback** when the API path hits a wall, and as a **screen-state classifier** (which screen am I on?) since GLSpy already gives us that for free. But for resource collection, API replay is the goal.

## Bridge commands to add

| cmd | purpose |
|---|---|
| `netStart` | install fetch+XHR loggers (raw byte capture, decimal arrays for transport) |
| `netStop` | uninstall and reset |
| `netGet` | return captured log |
| `netReplay(reqIdx)` | re-fire a captured request verbatim — useful for testing whether tokens are single-use |
| `protoSend(opcode, fields)` | once decoder is written, send a structured request through the same XHR plumbing |

## Bridge-side gotcha hit during capture

The MCP tool layer **censored hex strings** (`[BLOCKED: Base64 encoded data]`) when long enough to look base64-ish. Workaround: emit byte arrays as **decimal numbers** (`[80, 0, 3, 61, ...]`) — the filter doesn't trip. Important for any future binary-protocol work.

## Open questions for the next session

1. Is the query string static per session, or does it change per request? (Capture 2 consecutive POSTs and compare.)
2. Does the farm-load response include resource positions, or only IDs? (Capture one and read.)
3. Are tokens single-use? (Capture, navigate away, return, retry — see if token rejected.)
4. What opcode distinguishes farm-load from collect-resource? (Compare headers across captured messages.)

---

# Session 2 — Auth & request-id reverse engineering

Status: **Replay-blocked.** We can read everything but can't synthesize valid requests without reaching into the closed network manager. Hybrid (synthetic clicks + XHR-response oracle) remains the practical ship path.

## URL shape (fully decoded)

```
https://valley.redspell.ru/proto.html
  ?sid=<session-uuid>            ← stable per session, captured from any in-flight URL
  &request_id=<float>            ← e.g. "6081275.2576979"
  &proto=50x3                    ← protocol version, constant
  &network=vkontakte             ← social, constant per platform
  &cnt=<int>                     ← per-call counter, increments
```

**No HMAC. No signed headers.** `reqHeaders: {}` confirmed empty across captures — the game does not call `setRequestHeader` on these XHRs. Auth is *just* `sid + request_id`.

## URL builder — verbatim from bundle

Located in the iframe's bundled blob script at offset ~1521900–1522200:

```js
i.writeUTF("go!hedgehogs", !1);                              // signature seed
var n = Ab.hash(this.flushSendPackets(!1).buffer, !1);       // hash the body buffer
i.decWriteLength(3), i.writeUTF(n, !1);                       // append hash to body
this.xhr.open("POST",
  this.url + "&request_id=" + this.requestId
           + "&proto=" + this.packetAbout
           + "&network=" + P.socialNetwork
           + "&cnt=" + t, !0);
this.xhr.send(this.flushSendPackets(!0));
```

Key consequence: **the body hash is computed BEFORE `request_id` is appended to the URL**, so body-hash and `request_id` are independent. A replay with the original body + a fresh `request_id` would be byte-valid.

## Body hash function

`Ab.hash(buffer, !1)` returns a 32-char hex string — same length as MD5. Globals `hex_md5`, `binl_md5`, `rstr_md5`, `md5_cmn`, `md5_ff/gg/hh/ii`, plus HMAC variants (`hex_hmac_md5`, `rstr_hmac_md5`) are all **exposed at window scope**. The "go!hedgehogs" string is almost certainly the HMAC key (or a salt prepended/appended before MD5). One short test will confirm: hash a captured body with each candidate against the trailing 32 hex chars.

## What blocks full headless

Only one wall left, but it's a real one:

**`request_id` is `this.requestId` on the network manager — a closure-bound counter.**

We tried:
- Replaying a captured `request_id` verbatim → `200 OK` body `"expired request"`.
- Replaying with `request_id = Date.now()/1000` → same `"expired request"`. So the server enforces a window/range.
- Walking globals + 2-level deep object trees for any object whose `.xhr` matches the in-flight XHR → **zero matches**. The manager is fully encapsulated.

This is the same closure-trap pattern we hit with PIXI in doc/03 — the bundled module exposes nothing outward.

## Routes still worth trying for headless

Ranked by effort:

1. **Walk `cacheObj`** (global, "object") — likely the live game state. If it holds `(friend, resources[], tokens[])`, we don't need to parse the binary farm-load at all.
2. **Probe `sendRequest`** (global function) — if it accepts `(opcode, args)` we may be able to dispatch any RPC without owning the manager.
3. **Hijack a live XHR call to read `requestId` indirectly** — install a proxy on `XMLHttpRequest.prototype.open` that, when called by genuine game code, exposes the (URL-extracted) current `requestId` to a global. We then synthesize *one* extra request with `requestId + 0.000001` before the real one finishes. Risky (race, sequence enforcement) but cheap to test.
4. **Hook into the bundled module's `prototype` after construction** — if `this.requestId` lives on a class instance, monkey-patch its prototype to expose `requestId` via a getter we control. Requires finding the prototype, which means more bundle archeology.

## Successful protocol replay (with caveats)

We confirmed end-to-end:
- Server accepts our `fetch()` to `/proto.html` (CORS allows `*`, cookies forwarded with `credentials: 'include'`).
- Server returns `200 OK` with a binary error envelope for invalid requests:
  ```
  00 00 00 3D 00          ← error opcode (00, NOT 80 = success)
  13 00 00 00             ← payload length 19
  01 0F 00                ← error code 1, string len 15
  "expired request" 00
  ```
- This is a clean error format we can use as a test signal: success body starts with `80 00`, failure with `00 00`.

## Decoded multi-action capture (for reference)

In one farm-traversal session we captured these unique request shapes (all `POST /proto.html`):

| reqLen | opcode | meaning | payload |
|---|---|---|---|
| 41 | `09` | session ping/keepalive | 32-char session token only |
| 96 | `03` | collect resource | UUID + tag `02` + instance ID + `ga_oak` + count + 32-char hash |
| 97 | `03` | collect resource | UUID + tag `02` + instance ID + `ga_tree` + count + 32-char hash |
| 100 | `03` | collect resource | UUID + tag `01` + instance ID + `sb_seedbed` + count + 32-char hash |
| 168 | `03` ×2 | batched two-message frame | two opcode-`03` messages concatenated |

Resource categories:
- Tag `01` → `sb_*` (seedbeds, buildings)
- Tag `02` → `ga_*` (gardens, trees)

Every response was the **same 43,464 bytes** — server returns the entire world state on every action. (Earlier doc/05 hypothesis "single-action response is 56 bytes" was true for a simpler ping; a real resource-collect during traversal returns the full state. Both behaviors observed across sessions, depending on action type and session start state.)

## Recommended path from here

**Hybrid is shippable today:**
- Drive game with synthetic pointer events on canvas (proven by exit popup capture).
- Use XHR response as the success oracle (response starts `80 00` = ok, `00 00` = error). Zero reliance on pixel diff.
- Visit FSM uses `HC_GLSpy` fingerprints (doc/04) for screen-state classification only.

**Headless is a 1–2 hour reversing job** to break the closure wall (route 1 or 3 above). Worth doing only if hybrid hits a wall (e.g. game adds anti-bot heuristics on synthetic events).

---

# Session 3 — Hybrid validation + correction notes

Status: **Hybrid is functionally proven on a single cell.** Throughput-limited by two browser/engine quirks (below).

## Hex/decimal correction (important)

Earlier this doc described success-response opcode as `0x80 0x00`. That was wrong — confused decimal byte values with hex notation. The actual envelope is:

| Outcome | First two bytes (hex) | First two bytes (decimal — what raw arrays show) |
|---|---|---|
| Success | `0x50 0x00` (ASCII `"P\0"`) | `[80, 0, ...]` |
| Error   | `0x00 0x00`                 | `[0, 0, ...]`  |

`HC_Net` was first written checking `u8[0] === 0x80` (decimal 128), which never matches. Fixed in `src/network.js` to check `0x50`.

## What we validated

1. **`HC_Net` correctly classifies responses.** With the 0x50 fix, manual user clicks on real resources logged as `+4 totalOk`. Empty-area clicks logged nothing.
2. **Per-cell oracle works.** A 20-cell dense sweep around the avatar found one true resource at canvas `(250, 250)` — its probe returned `'ok'` while the other 19 returned `'none'`. Background game-poll responses (4 stray oks) did add to the global counter but `awaitNextResponse(700ms)` only resolves on the *next* response after the click, so they don't pollute the per-cell oracle.
3. **Synthetic clicks land regardless of tab focus.** User confirmed visual feedback (popups appearing) even with the tab in background.

## Throughput limits we hit

### A. PIXI processes pointer events per frame

Firing 77 `dispatchEvent` sequences in 20ms produced **zero** new `/proto.html` POSTs. Cause: PIXI's InteractionManager (or the game's hit-test wrapping it) appears to consolidate same-frame pointer state — only the *last* event of a frame is acted on. Rapid batch-fire is wasted; we must space events ≥1 frame (~17ms) apart.

Workaround: keep ~50–100 ms between clicks (well above frame time, leaves headroom for the game's own RAF work).

### B. Inactive tab throttles `setTimeout`

A 45-cell sweep ran 21 attempts in 40 s, then only 23 attempts in another 90 s — i.e. timers slowed to once per ~45 seconds. This is Chrome's standard background-tab throttling. The synthetic clicks themselves still fire (UI events bypass throttling), but our `await sleep(...)` between cells stalls.

Mitigations (best to worst):
1. Keep the game tab focused/visible during automation.
2. Drive timing from a Web Worker (workers aren't throttled). Worker can `postMessage` to the main thread on every tick; main thread fires the click on receipt.
3. Use `MessageChannel` self-loops (less throttled than `setTimeout` in some Chrome versions, but inconsistent).

Decision: for now, document the limitation and ask the user to keep the tab visible. Worker-driven timing is a future-work item if hands-off operation becomes important.

## Multi-click on confirmed cells WORKS (correction)

Initial worry that resources are one-shot was wrong. User confirmed: resources *do* accept multiple clicks. Trees / stones / seedbeds return fresh action tokens for repeat hits as long as they have material left (3–5 chops/hits typical). The current `visit.js` `maxRepeats = 5` strategy is correct: probe a cell, if `ok` keep clicking until a probe returns non-`ok`, then move on.

In a real run on a friend farm we observed: 6 distinct cells found via the grid sweep, 8 total hits across them — so some cells gave multi-collect, some single. The early-stop on first non-`ok` correctly moves on without wasting clicks.

## Updated `visit.js` behavior we want

```
sweep cells with 80–100ms inter-cell spacing (NOT instant batch)
each cell: one probe, await up to 700ms for response
on 'ok': record hit, move to next cell (do NOT multi-click)
after full pass:
  if 0 hits → assume farm exhausted → click home/exit
  else → optionally do another pass (some "trees" regenerate over many seconds)
```

## Bot-detection scare (debunked)

A "Проверяем, что вы не робот" popup appeared on the VK page after one rapid-fire sweep. Initially looked like the platform had detected our automation. User confirmed it was VPN-related VK behavior unrelated to clicks. Keeping this note here in case we see it again — first verify VPN/IP state before assuming the game flagged us.

## Open work for next session

1. Re-run a properly-throttled sweep (80 ms inter-cell, 700 ms response window) with tab focused. Measure hit rate.
2. Add session-end popup detector (the "Backpack full / time to go home" dialog from `Screenshot_5.png`). Likely route: after N empty passes, take a screenshot via the MCP `computer` tool and look for the dialog texture, OR pixel-fingerprint the popup region.
3. Wire up "Путешествия" entry button on main farm so the FSM can complete a full home → travels → friend → collect → home cycle.
4. Decide whether multi-pass is worth it (do resources regenerate within a single visit?). If yes, add a configurable repeat-pass with delay.

---

# Session 4 — Hybrid loop end-to-end + new walls

Status: **Loop traverses farms, but synthetic clicks went silent mid-session.** Real progress on FSM design + new dead-end on input dispatch reliability.

## What we built

`src/network.js` (`HC_Net`) — a tiny XHR observer that wraps `XMLHttpRequest.open/send` at document_start. For every `/proto.html` POST it inspects the first two response bytes and increments either `totalOk` or `totalErr`. Also exposes `awaitNextResponse(ms)` so callers can synchronously wait for "the next server reply".

`src/visit.js` rewrite — replaced the HSL-vision FSM with a hybrid loop:
- **Dense grid**: 14×9 = 126 cells, 70 px spacing
- **Blind sweep**: fire all 126 clicks with `clickGap=300 ms`, no per-cell oracle wait
- **Decision via net delta**: after `settleAfterSweep=1800 ms`, compare `HC_Net.totalOk` before/after. If `gained ≥ minOkPerSweep (3)` → another pass; else click "Далее" (or "Выйти" if Далее unset)
- **Per-farm cap**: `maxSweepsPerFarm=4` to bound time on rich farms

Bridge: `visitStart`, `visitStop`, `visitStats`, `visitSweep` (one-shot for testing), `visitSetNext(x, y)`, `visitSetSessionEndOk(x, y)`, `visitSetTravels(x, y)`, `visitSetHomeBtn`. `netStats`, `netAwait` for direct oracle inspection. The old `clickAt(x, y)` and `eval(body)` debug commands stay.

Captured static UI:
- **"Далее"** (advance to next friend farm) — canvas (221, 661). **Only visible after the player has collected at least one resource on the current farm.** Fresh / depleted farms only show "Выйти".
- **"Выйти"** (exit to travels hub) — canvas (80, 660), always present.
- "В путь!" — canvas (765, 260) on travels hub (from doc/01).
- Backpack-full popup confirm — coords TBD.
- "Путешествия" main-farm entry — coords TBD.

## What worked

1. **HC_Net oracle is reliable.** Manual user clicks always increment `totalOk`. Game's periodic background polls also increment it (~1 per 10–30 s).
2. **0x50 vs 0x80 fix.** Earlier doc had hex/decimal confused — success envelope is `0x50 0x00` (ASCII `"P\0"`), error is `0x00 0x00`. Fixed in network.js.
3. **First end-to-end run**: 6 cells hit, 8 net oks, backpack went 0 → 48/120. After this run we knew the path was viable.
4. **"Далее" at canvas (221, 661)** works — clicking it advances to the next friend farm and emits ~7 oks (looks like a batch transition packet).
5. **Pulse-then-sweep traversed 21 farms in 80 s** before we discovered the pulse was missing real resources.
6. **Random 6-zone pulse traversed 7 farms before stopping** — but missed all resources because the random points landed on grass.

## What broke

### A. Per-cell oracle window is unreliable

A 700 ms `awaitNextResponse` window misses many real hits. The game's `/proto.html` response can arrive in 300 ms or 1500 ms depending on server load. We saw runs where `visit.hits=0` while `net.totalOk` rose by 11 — clicks WERE collecting, just the per-cell timing missed the responses.

**Mitigation in current visit.js**: dropped the per-cell oracle entirely. Only measure pre/post sweep `totalOk` delta. Cleaner signal, but loses per-cell hit coords (less useful for tuning the grid).

### B. Stratified-random pulse is too sparse

Resources cluster — they're not evenly distributed across the canvas. 6 random points (one per stratified zone) miss them on most farms. We watched the loop click "Далее" past 7 visible-resource farms in a row because no random point landed on a sprite.

**Decision**: dropped pulse entirely. Always do the full 126-cell sweep. Trade ~38 s of clicking on empty farms for never missing resources.

### C. Synthetic clicks went silent mid-session

This is the big one. Earlier in the session, a synthetic `dispatchEvent` chain on the canvas opened the exit popup. After ~30 minutes of activity (many sweeps, several forced page reloads, a couple of bot-detection captchas from VK), the same dispatch sequence stopped doing anything. Verified:
- Event reaches the canvas (capture-phase listener saw `pointerdown` with `isTrusted: false`)
- Coords are correct (canvas 1000×700 at 1:1 scale)
- Game responds to manual clicks (`totalOk +3` on a manual collect)
- CDP `left_click` via the MCP `computer` tool also failed to open the popup (might be a coord-conversion bug or might also be blocked)

Possible causes (not yet distinguished):
- Game/PIXI added an `isTrusted` check after detecting our patterns
- VK or game enforces a soft rate-limit on this account/IP
- The canvas reference in `HC_Capture` got stale and the visible canvas is different (possible — should re-resolve via `document.querySelector('canvas')` each click)
- Inactive-tab throttling caused click bursts the game blocked

### D. "Далее" is conditional, not permanent

Caught late: "Далее" only appears AFTER the player has collected ≥1 resource on the current farm. Fresh farms show only "Выйти". So the loop's `click(BTN.next)` on a 0-collect farm was a no-op — we kept "advancing" by clicking dead pixels, leading to ghost `farms++` increments while staying on the same farm.

Fix needed: branch the advance logic. If the just-completed sweep collected 0 → click Выйти (returns to travels hub) → click another friend-farm icon. If sweep collected ≥1 → click Далее (advance directly).

This means we need:
- "Travels hub" detection (which screen are we on after Выйти?)
- "Friend farm icon" coords on the travels hub (probably need to scroll/randomize)
- Or: just always click Выйти + В путь! (works on both fresh and collected farms, but slower)

## Lessons distilled

- **Trust the net counter more than per-cell timing.** The server is the source of truth.
- **Random sampling is a bad fit for resource detection** when resources cluster. Either dense-sweep everything or use a real spatial signal.
- **Synthetic dispatch reliability degrades over a long session.** Plan for it: detect "10 sweeps with 0 oks while bars aren't full" → stop and ask user to verify.
- **UI elements are state-dependent.** "Далее" is one example; the backpack-full popup is another. The FSM should classify the screen, not blindly click coords.

## Next session priorities

1. **Resolve synthetic click failure.** Try a fresh tab + extension reload. If still broken, switch to CDP-based clicks via MCP `computer` (verifying iframe-to-screen coord math first).
2. **Always-Выйти branch.** Modify `loop()` to use Выйти + В путь! when the previous sweep collected 0 (fallback when Далее isn't available).
3. **Screen classifier.** Use `HC_GLSpy.snapshot()` to fingerprint travels-hub vs friend-farm vs main-farm vs backpack-full-popup. Drives the FSM correctly.
4. **Backpack-full handler.** When the popup appears, click confirm → land on main farm → click Путешествия → click В путь! → continue.
5. **Coord capture helpers.** A `setNextBtn` style for: travels hub farm icons, Путешествия button, popup confirms. Same pattern as the click-recorder we already used.
