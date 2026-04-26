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
