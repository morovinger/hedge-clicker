# 08 — Network Replay & Travel-Cycle Protocol

Picks up where #07 (autonomous visit loop) left off. The popup-Далее coords kept missing because they're rendered **at the player character's world position**, which varies per farm. Instead of hunting them visually, this round decoded the underlying XHR endpoints so the loop can drive the game directly via `XMLHttpRequest.send`.

## Travel-cycle model

Terminology (canonical, four screens):

- **own farm** — the player's actual home. Wide canvas with the player's full farm; bottom button bar includes Магазин / Кладовая / Достижения / Битва портных / Фестивали / **Путешествия** / Почта. See `screenshots/own-farm.png`. This is where every cycle starts and ends.
- **travel-prep** — interstitial view shown AFTER clicking Путешествия from own farm. Has the **"В путь!"** button at canvas `(765, 260)` (already calibrated as `BTN.voyage`). See `screenshots/travel-prep.png`.
- **friends hub** — grid of friend-farm icons each with a badge count of uncollected resources, "Домой" button bottom-left. Reached by clicking В путь from travel-prep. See `screenshots/friends-hub.png`. NO `\x05` farm-load fires when entering — it's a UI list view, not a farm.
- **friend farm** — an individual playable farm; `\x05` farm-load (~594KB–1.77MB) fires on entry. Sweep for resources, then advance via Далее.

The friend-visit pipeline is a **fixed 4–5 farm cycle**:

1. **own farm** — click bottom-bar **"Путешествия"** → transitions to travel-prep.
2. **travel-prep** — click **"В путь!"** → fires `5000 073d` → server returns the candidate friend list (10 UUIDs in a `P\0`-envelope payload, see "Decoded endpoints" below) → transitions to friends hub.
3. **friends hub** — click a friend-farm icon → fires `0500 013d` → server returns `\x05` farm-load → enters farm 1.
4. **farm i of N** — sweep, then click **Далее** (popup at character position OR bottom-left) → fires `5000 093d` → next farm-load → enters farm i+1.
5. **last Далее** → auto-return to own farm (or to friends hub — TBD).
6. Loop: re-click **"Путешествия"**.

**Implication for the visit loop:** four distinct screens, not three. The cycle's true entry point is the **own farm**, not the travel-prep view we previously called "home". Confirmed friend-icon coords on the friends hub from the panel picker: `(408, 233)`, `(529, 305)`, `(544, 414)`, `(512, 445)`. Detection: `lastFarmLoadSeq() == null` → on own farm OR travel-prep OR friends hub (XHR doesn't distinguish them; the В путешествие/В путь/friend-icon clicks each fire distinct opcodes that tell us which transition just happened).

## /proto.html envelope kinds

All XHR responses to `/proto.html` are HTTP 200; the meaningful classification is in the first 2 bytes:

| Bytes | ASCII | Meaning | Counter |
|---|---|---|---|
| `50 00` | `P\0` | Action acknowledged (collect, Далее ack, etc.) | `totalOk` |
| `30 00` | `0\0` | Background heartbeat / idle tick | `totalTick` |
| `05 00` | `\x05\0` | Server-push state load (init bundle, farm-load) | `totalLoad` |
| `10 00` | `\x10\0` | Own-farm collect ack (different envelope than friend-farm) | not classified yet |
| `00 00` | error | Server rejected the action; ASCII reason follows | `totalErr` |

`HC_Net` doesn't yet recognize `\x10`, so own-farm collects are being miscounted as errors. Worth adding once the headless loop graduates from friend farms to own-farm. Init payload is `\x05\0` and ~1.77 MB. Friend-farm loads are also `\x05\0` but ~594 KB–1.77 MB. `lastFarmLoadSeq()` filters with `8KB ≤ respLen ≤ 1.5MB` to exclude the init.

Init payload is `\x05\0` and ~1.77 MB. Friend-farm loads are also `\x05\0` but ~594 KB. `lastFarmLoadSeq()` filters with `8KB ≤ respLen ≤ 1.5MB` to exclude the init.

## Decoded endpoints

### В путь — start travel cycle (home → friends hub)

```
URL:   POST /proto.html?cnt=1&network=vksite&proto=50x7&request_id=<TOKEN>&sid=<SESSION>
Body:  41 bytes
       50 00 07 3d           envelope=50, opcode=07 3d
       00 00 00 00 00        5 zero pad bytes
       <32 ASCII hex chars>  friend ID (carried from prior cycle; observed payload-irrelevant)
```

Response: `P\0` envelope, opcode `08 3d`, ~1966–3260 bytes, containing **the candidate friend list for this cycle** (typically 10 entries):

```
50 00 08 3d           response envelope + opcode
<uint32 LE inner-len>
14 00 00 00 14 00 00 00     header counters
01 00 06 00 'Energy' ...    energy meta
[then for each friend, repeating record:]
24 00                                              uint16 LE = 36 (UUID-with-dashes length)
<36 ASCII chars: "8-4-4-4-12" hex UUID>            ← friend's ID (e.g. 0b925adc-7a7b-4a52-8081-866792b6e73e)
1f 00 <UTF-8 cyrillic name bytes>                  display name
53 00 <avatar URL>                                 contains numeric VK user ID
55 00 ... <num-id>
0b 00 'frame_terra'                                avatar frame
... (more flags, TBD)
```

**Strip the dashes from the UUID to get the 32-char hex form used by `0500 013d` and `5000 093d` request bodies.** This is the source of the friend cycle list — the long-open question of "where does the next-friend ID come from" is answered here. The server presumably picks 4–5 of the 10 candidates for the actual cycle (selection rule TBD; could be first-N, badge-count weighted, or random).

### Enter friend farm (friends-hub icon click)

```
URL:   POST /proto.html?cnt=1&network=vksite&proto=5x1&request_id=<TOKEN>&sid=<SESSION>
Body:  44 bytes
       05 00 01 3d           envelope=05, opcode=01 3d
       00 03 00 00           4 bytes header
       00 01 00 00           4 bytes flag (varies: 01 00 00 00 vs 00 00 01 01 — meaning TBD)
       <32 ASCII hex chars>  target friend ID
```

This is what fires when the user clicks a friend in the start-of-cycle hub. Server replies with `05 00 02 3d` envelope + 594 KB farm-load.

### RandomFriendVisit / Далее (advance to next friend)

```
URL:   POST /proto.html?cnt=1&network=vksite&proto=50x9&request_id=<TOKEN>&sid=<SESSION>
Body:  41 bytes
       50 00 09 3d           envelope=50, opcode=09 3d
       00 00 00 00 00        5 zero pad bytes
       <32 ASCII hex chars>  target friend ID (the NEXT friend)
```

Server returns **two responses 5s apart, both keyed on the same request_id**:
1. Small `P\0` ack (~69 B) — "Далее acknowledged."
2. `\x05` farm-load (~594 KB) — the next farm's content.

Server-side action name (from error message): `RandomFriendVisit`.

## request_id semantics

- Format: `<7-digit random>.<integer counter>` (observed: `5472465.117416`, `6179345.102382`, `1095923.981428`).
- **Single-use** AND **monotonic per session.** Re-using the exact same id, OR using a fresh id where the second part is LOWER than what the server has seen this session, both return `00 00 00 3d 00 13` = `"expired request"`. Fresh first-part isn't enough — the second part must be ≥ the highest seen this session.
- **Reliable generator:** `Math.floor(Math.random()*9e6+1e6) + '.' + (Date.now() % 100000000)`. The Date.now suffix guarantees monotonic for any practical reuse rate.
- The `sid` URL param is the session ID; it rotates on page reload (and possibly on certain server-side state events). Always read sid from the latest captured XHR before fabricating a new one — using a stale sid silently fails.

## Replay state machine

The body-bytes are accepted as-is; rejection happens on **server-side game state**. With a fresh request_id but the wrong state, you get e.g. `00 00 00 3d 00 59 ... RandomFriendVisit: user not in travel`. So the constraint is:

- `Далее (5000 093d)` requires the user to currently be **in travel mode** (i.e. between "В путь!" and the cycle end).
- `Enter friend (0500 013d)` is the action that PUTS the user into travel mode, OR moves between friends within the cycle.

**Confirmed end-to-end (2026-05-01):** fabricated `0500 013d` (enter friend 0) and `5000 093d` (Далее to friend 1) both succeed when called with a correct sid + monotonic request_id. The full cycle is replay-driveable.

## Client desync gotcha

When `0500 013d` / `5000 093d` are fired via fabricated `XMLHttpRequest.send` (e.g. through `HC_Net.replay`), only the `P\0` ack arrives — the paired `\x05` farm-load (the 594 KB / 1.77 MB next-farm payload) does NOT come through. The game's PIXI/JS client has its own listener path that pushes the `\x05` farm-load **only when the request was made through the game's own request handler**. A replay made from outside that path is invisible to the client; server state advances, client UI stays put.

Practical consequences:
- After a replay-driven advance, the canvas still shows the previous screen (friends hub or previous farm), but server thinks you're somewhere else. Subsequent in-game clicks will mis-target.
- For an autonomous loop, this means **either**: (a) drive replays end-to-end (no in-game clicks at all — but you'll never see resources actually appear visually) OR (b) hijack the game's own request function (call `cm.getVisitMap` or its sibling internally so the client's `\x05` listener triggers normally).
- A page reload re-syncs (server state still tracks the user, client refetches everything).

Since collection sweeps still need DbgClick (canvas clicks) to produce ra_* loot, option (b) is the cleaner integration target. The server dispatcher likely lives behind a closure-scoped object — `cm` was identified in the call stack at `bundle_522.js:1:1470261` in earlier sessions but is not window-reachable.

Possible loop architecture (replay-driven, no popup hunting):
```
loop:
  click(BTN.voyage)                    # trusted click — start travel cycle
  await awaitNextFarmLoad              # confirm we're in farm 1
  for each farm in cycle:
    runSweep()                         # collect everything
    nextFriendId = parseFromFarmLoad() # extract target from current load
    HC_Net.replay(daleeTemplate, {
      urlMutate(u){ u.params.request_id = freshToken(); return u; },
      bodyMutate(b){ overwrite ID at offset 9..40 with nextFriendId; return b; },
    })
    await awaitNextFarmLoad
  # cycle ends → back on home screen
```

The unknown is `parseFromFarmLoad()` — the next friend's ID has to come from somewhere. Candidates:
- Embedded in the current farm's load packet (player roster the server pre-sent).
- Derivable from the user's friend-list (separate XHR).
- Returned in the `P\0` ack of the previous Далее (small 69-byte payload).

## Collect action — request format & headless invocation

The `5000 033d` collect-action request body (variable length, ~97–104 bytes):

```
[0..3]   50 00 03 3d           envelope + opcode
[4]      00                    pad
[5]      <uint8>               content-len (= reqLen - 41)
[6..8]   00 00 00              pad
[9..10]  24 00                 uint16 LE = 36 (UUID len prefix)
[11..46] <36 ASCII chars>      friend UUID with dashes (the farm we're in)
[47]     <uint8>               type-prefix code (01=sb_, 02=ga_, 03=te_)
[48..51] <uint32 LE>           eid (matches farm-load record's eid)
[52..53] <uint16 LE>           type-name length
[54..]   <ASCII type>          object type ("sb_seedbed", "te_apple", "ga_wild_onion3", ...)
+0..3    01 00 00 00           uint32 LE constant (action count = 1)
+4..35   <32 ASCII hex>        per-click hash — server-side IGNORED (logging tag only).
                               Random hex accepted. We can fabricate this freely.
```

**Confirmed (2026-05-01):** replay with a fully random 32-char hash returns the normal Exp/Coins/Energy/ra_leaf P\0 ack. Server doesn't validate the hash. This means **collect requests can be constructed entirely from farm-load data** — no per-click client state required.

## Friend-farm load — record format (delimiter-less)

The current game version's farm-load (~63 KB to 1.77 MB depending on farm activity) uses **back-to-back records with no fingerprint or delimiter byte sequence** — neither the old `0x41DA7BCA` from doc 06 nor the `06 7d da 41 00` we briefly observed in one 78KB load this session. Records are simply concatenated and anchored only by the type-name string itself:

```
[uint32 LE eid]                ← entity ID (matches eid sent in 5000 033d collect)
[uint32 LE field1]             ← state/position uint
[uint32 LE field2]             ← state/position uint (often signed-looking, eg d1 ff ff ff)
[uint16 LE type-len][ASCII]    ← e.g. 07 00 "ga_tree", 0a 00 "sb_seedbed"
[2-byte trailer][...]          ← format varies; not needed for collect requests
```

**Robust parser** (`HC_Headless.parseFarmLoadV2` in `src/headless.js`): scan the buffer for `<uint16 typeLen> <2 ASCII chars> <0x5f>` (length-prefixed type-name starting with a known 2-char prefix), validate the prefix is in the known list, then walk back 14 bytes to read eid/field1/field2. This works on both delimiter and no-delimiter formats. Verified to find 1247 records in a real 1.77 MB friend-farm load.

`HC_Net.parseFarmLoad` (the older `0x41DA7BCA`-anchored parser from doc 06) is now obsolete for this game version and returns 0 — keep it for archival reference only.

## Type prefix taxonomy

Not every parsed object is collectible. Server returns `"FriendAction: does not have availible actions"` for non-collectible scenery. Confirmed taxonomy:

| Prefix | Category | Collectible on friend farm? |
|---|---|---|
| `te_` | Trees with fruit (te_apple, te_linden) | Yes |
| `sb_` | Seedbeds with crops | Yes |
| `pl_` | Mature plants | Yes |
| `pi_` | (Per doc 06) | Yes |
| `fl_` | Flowers | Yes |
| `ga_*` | Garden / scenery — MOSTLY non-collectible (ga_grass3, ga_birch3, ga_blackberry_bush) | Partial — only ga_wild_*, ga_tree subtypes |
| `dc_` | Decoration | No |
| `tl_` | Tile / terrain | No |
| `bl_` | Building | No |
| `fe_` | Field / fence | No |
| `ra_` | Resource (in inventory) — appears in own-farm load | N/A |

## Error response taxonomy

All error responses use the `00 00` envelope and mirror the request opcode in the next 2 bytes (`00 3d`). Byte 5 is the **error code**; the meaning of subsequent bytes depends on the code. Confirmed codes (2026-05-03):

| Code | Resp len | Trailing text? | Meaning | Triggered by |
|---|---|---|---|---|
| `0x02` | 11 B | none | state mismatch / wrong farm context | replay-driven session-state desync — usually after a previous cycle didn't terminate cleanly. Page reload fixes. |
| `0x13` | small + text | `"expired request"` | request_id rejected (reused or non-monotonic) | bad `request_id` generation — see "request_id semantics". |
| `0x32` | 59 B | `dumps'.<player_uuid>_<eid_suffix>` | object cannot be collected | calling collect on an object that's in our `collectibles` list but the server says no — wrong type, wrong state, not ready, scenery (e.g. some `pl_*` event variants, `ga_tree` subtypes). **Does not consume quota.** Free "no" from the server. |
| `0x61` | 106 B | `"FriendAction: does not have availible actions"` | per-friend daily quota exhausted | hits after the 12th successful collect on a given friend that day. Definitive "stop sweeping this farm" signal. |

Practical impact in the headless loop: per friend we attempt ~20 of the 50 parsed collectibles and get the typical `ok=12 / err=8` split. Of those 8 errors, ~7 are `0x32` (object-not-collectible — noise we can't predict) and 1 is `0x61` (quota — the real stop signal). Both are server rejections, neither penalises the player, neither corrupts state. The 12-cap per friend is the daily game-rule limit, not a side-effect of our attempts.

Two cheap wins if `0x32` noise becomes worth optimising:
- Reorder collectibles so the high-success types (`te_*`, `sb_seedbed`, `ga_wild_*`) go first; quota typically hits before we walk into the doubtful types.
- Tighten `COLLECTIBLE_PREFIXES` / `COLLECTIBLE_GA_RE` once a per-error type table is captured.

## Per-click collect-response format (from earlier)

Each `P\0` ack carries the resource delta:
```
50 00 04 3d 00 <inner-len uint32 LE> <recCount uint16 LE>
recCount × { uint16 nameLen, ASCII name, uint32 LE value }
```
Names like `Exp`, `Coins`, `Energy` are meta; `ra_*` (ra_leaf, ra_bark, ra_maple_syrup, ...) are tangible loot. **Items collected count = banked into PLAYER STORAGE** (capped by global inventory free space), NOT a measure of farm loot remaining. So `withResources=0 && acks>0` means backpack full, not farm exhausted.

Parsed by `HC_Net.parseCollectResp(bytes)`; aggregated per-window by `HC_Net.lastCollectStats({sinceMs})`.

## Endpoint-debugging surface (added this round)

```js
const N = document.querySelector('iframe').contentWindow.HC_Net;

N.summarize({sinceMs})
  // Group ring entries by (envelope, first-4-req-bytes, reqLen).
  // Sorted ascending → rare opcodes (e.g. Далее) appear at top.

N.findRequests({sinceMs, urlContains, envelope, ok, tick, load,
                reqLenMin, reqLenMax, respLenMin, respLenMax,
                reqStartsWith: [0x50, 0x00, 0x09, 0x3d], withBytes: false})
  // Filter ring entries.

N.describe(seq | entry | undefined)
  // Pretty dump: parsed URL params, envelope, body hex+ascii (first 64B).

N.diff(seqA, seqB)
  // Byte-level diff of two requests' bodies + URL param diff.
  // Useful to spot per-request tokens vs constants.

await N.replay(seq, {urlMutate(u){...}, bodyMutate(b){...}})
  // Re-fire a captured request with optional URL/body mutation.
  // Returns {status, envelope, ok, tick, load, respHex, respAscii}.
```

Bridge commands (from parent frame): `netSummarize`, `netFind`, `netDescribe`, `netDiff`, `netReplay`.

## Cycle-end canvas state

After a full headless cycle, the canvas shows **travel-prep** (`screenshots/travel-prep.png`), not own-farm (`screenshots/own-farm.png`). The PIXI client never received a "back to home" signal because the headless path skips the trailing UI transitions. This is purely cosmetic for the headless loop — it neither clicks any button nor reads the canvas, so a second `runCycle()` immediately after the first works without any reset. Server-side state advances regardless of canvas position; the next В путь will fetch a fresh candidate list and the cycle proceeds.

What this *doesn't* mean: more loot per session. After a complete 10-friend sweep, every candidate's per-friend daily quota is burned, so back-to-back cycles will return identical-looking traffic with `ok=0` collects (or trigger backpack-full immediately if anything was collectible). Useful only when (a) a cycle was interrupted partway, or (b) the daily reset has elapsed (game time, not real time — unverified when).

## Other gotchas confirmed this session

- **Hidden tab kills clicks.** When the game tab is not foregrounded, `Input.dispatchMouseEvent` hangs silently — not an error, just never resolves. Background tab → DbgClick timeouts climb monotonically. User must keep the game window foregrounded.
- **Same-origin iframe needs coord translation.** Direct entry `https://valley.redspell.ru/` makes the game iframe same-origin with the parent. `chrome.debugger.getTargets` then returns one shared page target, so `Input.dispatchMouseEvent` expects TOP-frame viewport coords. `dbgclick.js:parentIframeOffset()` adds `iframe.getBoundingClientRect().left/top` on the same-origin path; cross-origin (VK wrapper) needs no offset.
- **MCP debugger steals the extension's attach.** `mcp__claude-in-chrome__javascript_tool` opens its own `chrome.debugger` session, which evicts the extension's session and breaks DbgClick until the extension reattaches. Don't run MCP eval and HC_Visit clicks at the same time.
- **HC_Net helpers ship via the extension content script** — modifying `src/network.js` requires `node build.js` AND a Chrome extension reload (chrome://extensions → ↻) AND a page reload. Page reload alone keeps the cached old bundle.

## Headless module — `HC_Headless` (branch: `headless-replay-loop`)

`src/headless.js` implements the full no-clicks replay loop:

```js
const H = document.querySelector('iframe').contentWindow.HC_Headless;
await H.runCycle({ maxFriends: 4, interMs: 100 });
H.getLog();
```

Status (verified 2026-05-03 — fresh-page 10-friend run):
- ✅ В путь fabricated, friend list parsed (10 UUIDs)
- ✅ enter-friend, Далее, collect replays all accepted by server
- ✅ Farm-load parser finds 1247 records on real 1.77 MB loads (consistent across all 10 friends)
- ✅ Backpack-full detection wired (`parseCollectResp(r.resp).resources.length === 0` × 5 in a row → break cycle)
- ✅ Per-cycle loot aggregation: `ra_leaf:120, ra_dry_grass:27` from a full 10-friend sweep
- ✅ Error reasons read from `r.resp` directly (no more ring-sidechannel race)

**Bug fixed this round:** `HC_Net.replay` previously returned only the first 64 bytes of the response (hex/ascii preview). Callers had to re-fetch the response from the ring, which races against the game's error-retry flood and grabs a wrong sibling entry. Symptom: collect-error log lines showed `P\0 04 3d ...Exp...Coins...ra_leaf` (a stale success ack) while still incrementing the err counter. Fix: `replay` now returns the full `resp` byte array; `enterFriendFarm`, `dalee`, `collectAll` consume it directly.

**Cross-realm gotcha** for any future MCP-based hot-patching: the wrapper's `body instanceof ArrayBuffer` check is anchored in the iframe's realm. Patches injected via main-frame `eval` create cross-realm ArrayBuffers — `instanceof` returns false, `bodyToBytes` returns null, and the ring records `req=null`. Always inject via a `<script>` element appended to the iframe document, or do an extension reload.

Body builders use a **"copy template, mutate trailing 32 bytes"** strategy — they grab a captured 0500 013d / 5000 093d request from the ring and only replace the friend ID portion. This avoids per-game-version byte-ordering bugs (we hit one with enter-farm where my initial fabricated header had the flag bytes off by one, causing the server to silently return a profile-ack instead of a farm-load).

Bridge commands wired in `build.js`: `headlessRun`, `headlessStop`, `headlessFriends`, `headlessParseLast`.

## Open questions

1. ~~Where does the next-friend ID come from inside a travel cycle?~~ **Resolved** — В путь response carries the full candidate friend list (10 entries observed) as length-prefixed UUIDs.
2. ~~What does the `0500 013d` flag-byte difference mean (`01 00 00 00` vs `00 00 01 01`)?~~ Likely irrelevant — copying the captured template's bytes verbatim works regardless.
3. ~~How does the server pick the 4–5 cycle members from the 10 candidates?~~ **Resolved** — there isn't a 4–5 selection. The server returns 10 candidates and we iterate all of them; each friend has a flat 12-action daily limit (signalled by `0x61` "FriendAction: does not have availible actions"). Earlier "4–5 farm" guess was a UI artefact, not a server constraint.
4. Does the server expose an "end of cycle" signal? Empirically no — every Далее returns a fresh farm-load, including the one that follows the last "real" friend; the cycle simply iterates `fl.friends.length`. Cosmetic canvas state ends on **travel-prep** (see "Cycle-end canvas state" above).
5. Confirm the `ga_*` collectible subtypes — `COLLECTIBLE_GA_RE = /^ga_(wild_|tree$|wild_onion)/` is best-guess. The 2026-05-03 run yielded 12 collects per friend (all `ra_leaf` + occasional `ra_dry_grass`); the `ga_*` items in the parsed list never came up before quota hit, so the regex is unverified. Worth dumping the per-error eid+type table on a future run to learn which subtypes silently bounce as `0x32`.
6. Decode `\x10` envelope (own-farm collect ack) so the headless loop can also drive own-farm chores.
7. When does the daily-action quota reset? Real-clock midnight, server-clock midnight, or rolling 24h? Confirm by running back-to-back cycles separated by a long pause.
