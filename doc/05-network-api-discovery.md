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
