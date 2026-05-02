// ── HC_Net: XHR observer for /proto.html responses ──
// Hybrid auto-collect uses this as the success oracle: after dispatching a
// synthetic click, await the next /proto.html response. If the body starts
// with `80 00` the click hit a real interactive element; if `00 00` (error
// envelope, e.g. "expired request") or no response arrives, the click missed
// or the action was rejected.
//
// Installs at document_start so it captures the very first POST. Idempotent
// across re-injection. Adds zero behavior to the page — only observes.

if (window.HC_Net) {
  console.log('[HC] Net already installed — reusing.');
} else {
window.HC_Net = (function() {
  let totalOk = 0, totalErr = 0, totalSeen = 0, totalTick = 0, total200 = 0;
  let totalLoad = 0; // server-push / state-load envelope ('\x05\x00')
  let lastOkAt = 0, lastErrAt = 0, lastResponseAt = 0, lastLoadAt = 0;

  // Ring buffer of recent (request, response) pairs for offline decoding.
  const RING_MAX = 32;
  const ring = [];
  let seq = 0;

  function pushRing(entry) {
    entry.seq = ++seq;
    ring.push(entry);
    if (ring.length > RING_MAX) ring.shift();
  }

  function bodyToBytes(body) {
    if (body == null) return null;
    try {
      if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
      if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      if (typeof body === 'string') {
        const out = new Array(body.length);
        for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
        return out;
      }
    } catch (e) {}
    return null;
  }

  if (!XMLHttpRequest.prototype.__hcNetWrapped) {
    XMLHttpRequest.prototype.__hcNetWrapped = true;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__hcIsProto = (typeof url === 'string' && url.indexOf('/proto.html') >= 0);
      this.__hcUrl = url;
      this.__hcMethod = method;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (this.__hcIsProto) {
        // Force binary so we can read the opcode bytes
        try { if (!this.responseType) this.responseType = 'arraybuffer'; } catch (e) {}
        const reqAt = Date.now();
        const reqBytes = bodyToBytes(body);
        const reqUrl = this.__hcUrl;
        const reqMethod = this.__hcMethod || 'POST';
        this.addEventListener('load', () => {
          totalSeen++;
          lastResponseAt = Date.now();
          let ok = false, tick = false, load = false, http200 = false;
          let envelope = null;
          let respBytes = null;
          try { http200 = this.status === 200; } catch (e) {}
          try {
            if (this.response instanceof ArrayBuffer) {
              respBytes = Array.from(new Uint8Array(this.response));
              // Envelope discrimination (3 known kinds, all HTTP 200):
              //   0x50 0x00 ('P\0')  click-acknowledged (collect action) →  ok
              //   0x30 0x00 ('0\0')  background heartbeat / idle tick    →  tick
              //   0x05 0x00 (\x05\0) server state push (initial session
              //                       load AND friend-farm load XHR — hub
              //                       probes returning a 594KB body land here)
              //                                                           →  load
              if (respBytes.length >= 2 && respBytes[1] === 0x00) {
                if (respBytes[0] === 0x50)      { ok = true;   envelope = 'P'; }
                else if (respBytes[0] === 0x30) { tick = true; envelope = '0'; }
                else if (respBytes[0] === 0x05) { load = true; envelope = '\\x05'; }
                else                            { envelope = String.fromCharCode(respBytes[0]); }
              }
            }
          } catch (e) {}
          if (http200) total200++;
          if (ok)        { totalOk++;   lastOkAt   = lastResponseAt; }
          else if (tick) { totalTick++; }
          else if (load) { totalLoad++; lastLoadAt = lastResponseAt; }
          else           { totalErr++;  lastErrAt  = lastResponseAt; }
          pushRing({
            url: reqUrl,
            method: reqMethod,
            reqAt, respAt: lastResponseAt,
            ok, tick, load, http200, envelope,
            reqLen: reqBytes ? reqBytes.length : 0,
            respLen: respBytes ? respBytes.length : 0,
            req: reqBytes,
            resp: respBytes,
          });
        });
      }
      return origSend.apply(this, arguments);
    };
    console.log('[HC-Net] XHR observer installed.');
  }

  // Wait up to timeoutMs for a /proto.html response to arrive.
  // Returns 'ok' | 'err' | 'none'. Caller should baseline counters before
  // dispatching the click — this fn does it internally for convenience.
  function awaitNextResponse(timeoutMs) {
    const startOk = totalOk;
    const startErr = totalErr;
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (totalOk > startOk) return resolve('ok');
        if (totalErr > startErr) return resolve('err');
        if (Date.now() - t0 >= timeoutMs) return resolve('none');
        setTimeout(tick, 30);
      };
      tick();
    });
  }

  // Return last N entries. opts: { withBytes: bool, n: number, minRespLen: number, sinceMs: number }
  // When withBytes=false (default) returns metadata only — keeps payloads
  // small. When true, includes req/resp byte arrays for offline decoding.
  function dump(opts) {
    opts = opts || {};
    const n = opts.n || 8;
    const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
    const min = opts.minRespLen || 0;
    let out = ring.filter(e => e.respAt >= since && e.respLen >= min);
    out = out.slice(-n);
    if (!opts.withBytes) {
      return out.map(e => ({
        seq: e.seq, url: e.url, reqAt: e.reqAt, respAt: e.respAt,
        ok: e.ok, reqLen: e.reqLen, respLen: e.respLen,
      }));
    }
    return out;
  }

  function clearRing() { ring.length = 0; }

  // ── Farm-load packet parser ──
  // Per doc 06: each object record is laid out as
  //   [int32 z=-13][int32 ?][uint16 N][N ASCII type][0x00][0x06 0x01]
  //   [4 entity_id][4 fingerprint=0x41DA7BCA][0x00][world_x][world_y][?][?]
  // Total stride = 26 + N bytes. The trailing 4-byte field reads cleanly as
  // (uint8 x, uint8 y) in world tile coords (X 6–250, Y 0–~100).
  //
  // Strategy: scan for length-prefixed printable strings whose surrounding
  // bytes match the flag/fingerprint pattern. Robust against header drift,
  // intermediate stray bytes, and variant record types we haven't seen.
  const FINGERPRINT = [0xCA, 0x7B, 0xDA, 0x41]; // little-endian 0x41DA7BCA
  const TYPE_RE = /^[a-z]{2,3}_[a-z][a-z0-9_]+$/;

  function parseFarmLoad(bytes) {
    if (!bytes || bytes.length < 64) return [];
    const out = [];
    const seenIds = new Set();
    // Records start with a uint16 length prefix at offset 8 in the record;
    // we scan the buffer for that prefix + ASCII string + flag bytes.
    const N = bytes.length;
    for (let i = 8; i < N - 30; i++) {
      const len = bytes[i] | (bytes[i + 1] << 8);
      if (len < 4 || len > 32) continue;
      const strStart = i + 2;
      const strEnd = strStart + len;
      if (strEnd + 16 > N) continue;

      // Cheap structural check before reading the string: flag bytes must
      // match. This filters out the vast majority of false positives.
      if (bytes[strEnd] !== 0x00) continue;
      if (bytes[strEnd + 1] !== 0x06 || bytes[strEnd + 2] !== 0x01) continue;
      // Fingerprint at strEnd + 7..10
      if (bytes[strEnd + 7]  !== FINGERPRINT[0]) continue;
      if (bytes[strEnd + 8]  !== FINGERPRINT[1]) continue;
      if (bytes[strEnd + 9]  !== FINGERPRINT[2]) continue;
      if (bytes[strEnd + 10] !== FINGERPRINT[3]) continue;

      // Now check ASCII string
      let ok = true, s = '';
      for (let j = 0; j < len; j++) {
        const c = bytes[strStart + j];
        if (c < 0x20 || c > 0x7e) { ok = false; break; }
        s += String.fromCharCode(c);
      }
      if (!ok || !TYPE_RE.test(s)) continue;

      // Entity id at strEnd + 3..6 (4 bytes — treat as opaque tuple)
      const idBytes = (bytes[strEnd + 3] << 24) | (bytes[strEnd + 4] << 16) |
                      (bytes[strEnd + 5] << 8)  |  bytes[strEnd + 6];
      const eid = idBytes >>> 0;
      if (seenIds.has(eid)) { i = strEnd + 15; continue; }
      seenIds.add(eid);

      // Position bytes at strEnd + 12 (x), strEnd + 13 (y)
      const wx = bytes[strEnd + 12];
      const wy = bytes[strEnd + 13];
      const wx2 = bytes[strEnd + 14]; // high byte of x for big maps (usually 0)
      const wy2 = bytes[strEnd + 15];

      out.push({ type: s, x: wx | (wx2 << 8), y: wy | (wy2 << 8), eid, off: i });
      i = strEnd + 15; // skip past this record
    }
    return out;
  }

  // Collectible type prefixes (per doc 06). tl_/dc_/ga_ are decoration.
  const COLLECTIBLE_PREFIXES = ['te_', 'sb_', 'pl_', 'pi_', 'fl_'];
  function isCollectible(type, prefixes) {
    const p = prefixes || COLLECTIBLE_PREFIXES;
    for (let i = 0; i < p.length; i++) if (type.indexOf(p[i]) === 0) return true;
    return false;
  }

  // Cheap "is there a friend-farm load in the ring, and what's its seq?" —
  // no packet parsing. opts: { minRespLen, maxRespLen }. Returns null if none.
  //
  // Envelope: friend-farm-load is the server-push envelope (`\x05\x00`,
  // classified as `load`). Older builds keyed on `e.ok` and missed every
  // farm-load — accept `load || ok`.
  //
  // Size: a fresh page load drops a HUGE (~1.77 MB) state-init payload that
  // is ALSO an `\x05\x00` envelope. It's not a friend-farm; it's the user's
  // session/hub bundle. If we counted it, the visit loop would skip its
  // hub-bootstrap and try to sweep the hub view. Cap at maxRespLen (default
  // 1.5 MB — friend farms observed at ~594 KB) to filter the init out.
  function lastFarmLoadSeq(opts) {
    opts = opts || {};
    const minLen = opts.minRespLen || 8000;
    const maxLen = opts.maxRespLen || 1500000;
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      if (!(e.load || e.ok)) continue;
      if (e.respLen < minLen || e.respLen > maxLen) continue;
      if (!e.resp) continue;
      return e.seq;
    }
    return null;
  }

  // Wait up to opts.timeoutMs (default 1500) for a farm-load XHR with seq
  // strictly greater than opts.afterSeq. Returns the new seq or null on
  // timeout. If afterSeq is omitted, uses the current lastFarmLoadSeq().
  async function awaitNextFarmLoad(opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 1500;
    const afterSeq = opts.afterSeq != null ? opts.afterSeq : lastFarmLoadSeq();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = lastFarmLoadSeq();
      if (s != null && s !== afterSeq) return s;
      await new Promise(r => setTimeout(r, 120));
    }
    return null;
  }

  // Find the most recent large /proto.html response (the farm-load) and
  // parse it. Returns { found, count, objects, source: {seq, respLen} }.
  // opts: { collectiblesOnly: bool, prefixes: string[], minRespLen: number }
  function lastFarmObjects(opts) {
    opts = opts || {};
    const minLen = opts.minRespLen || 8000;     // farm-load is ~67–594KB; tick polls ~3KB
    const maxLen = opts.maxRespLen || 1500000;  // exclude the 1.77 MB init payload (see lastFarmLoadSeq)
    let pick = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      // Farm-load is the server-push envelope (load=true). Older builds also
      // saw it via the action-ack path on some calls, so accept ok=true too.
      if (!(e.load || e.ok)) continue;
      if (e.respLen < minLen || e.respLen > maxLen) continue;
      if (!e.resp) continue;
      pick = e; break;
    }
    if (!pick) return { found: false, count: 0, objects: [], source: null };
    const all = parseFarmLoad(pick.resp);
    const filtered = (opts.collectiblesOnly === false)
      ? all
      : all.filter(o => isCollectible(o.type, opts.prefixes));
    return {
      found: true,
      count: filtered.length,
      totalRecords: all.length,
      objects: filtered,
      source: { seq: pick.seq, respLen: pick.respLen, respAt: pick.respAt },
    };
  }

  // ── Click-response (collect-action) parser ──
  // Every P\0 (action-ok) response carries the *server-side delta* for that
  // click. Format observed (n=32, 2026-05-01 session, ra_leaf / ra_bark /
  // ra_maple_syrup samples — all ~56–71 bytes):
  //   50 00                 envelope
  //   04 3d 00              fixed sub-header
  //   <uint32 LE inner-len> bytes that follow excluding the leading 9
  //   <uint16 LE recCount>
  //   recCount × {
  //     <uint16 LE name-len>
  //     <name-len ASCII bytes>      e.g. "Exp" "Coins" "Energy" "ra_leaf"
  //     <uint32 LE value>           positive integer; counter delta
  //   }
  // Resource records are the `ra_*` (or non-Exp/Coins/Energy) names — those
  // are the tangible loot. Exp/Coins/Energy show up on every collect.
  // When the backpack fills up (or the cell is empty) the server may still
  // return P\0 but with NO ra_* record — that's the signal we want.
  const META_NAMES = new Set(['Exp', 'Coins', 'Energy']);

  function parseCollectResp(bytes) {
    if (!bytes || bytes.length < 11) return null;
    if (bytes[0] !== 0x50 || bytes[1] !== 0x00) return null; // not a P\0 ack
    let i = 2;
    // Skip 3-byte sub-header (04 3d 00) — tolerated, not validated, in case
    // the server tweaks middle bytes.
    i += 3;
    // inner-len (uint32 LE) — for sanity only
    if (i + 4 > bytes.length) return null;
    const innerLen = bytes[i] | (bytes[i+1]<<8) | (bytes[i+2]<<16) | (bytes[i+3]<<24);
    i += 4;
    if (i + 2 > bytes.length) return null;
    const recCount = bytes[i] | (bytes[i+1]<<8);
    i += 2;
    const records = [];
    for (let r = 0; r < recCount; r++) {
      if (i + 2 > bytes.length) break;
      const nameLen = bytes[i] | (bytes[i+1]<<8);
      i += 2;
      if (i + nameLen + 4 > bytes.length) break;
      let name = '';
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(bytes[i + j]);
      i += nameLen;
      const value = bytes[i] | (bytes[i+1]<<8) | (bytes[i+2]<<16) | (bytes[i+3]<<24);
      i += 4;
      records.push({ name, value });
    }
    const resources = records.filter(r => !META_NAMES.has(r.name));
    return { recCount, records, resources, innerLen };
  }

  // Aggregate parseCollectResp across the recent click responses. Useful
  // signal for the visit loop: "did this sweep collect any ra_* items?"
  // opts: { sinceMs?: number, sinceSeq?: number }
  function lastCollectStats(opts) {
    opts = opts || {};
    const sinceTs = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
    const sinceSeq = opts.sinceSeq != null ? opts.sinceSeq : 0;
    let acks = 0, withResources = 0, withoutResources = 0;
    const totals = {}; // name → summed value
    let last = null;
    for (const e of ring) {
      if (!e.ok) continue;
      if (e.respAt < sinceTs) continue;
      if (e.seq <= sinceSeq) continue;
      if (!e.resp) continue;
      const p = parseCollectResp(e.resp);
      if (!p) continue;
      acks++;
      if (p.resources.length) withResources++; else withoutResources++;
      for (const r of p.records) totals[r.name] = (totals[r.name] || 0) + r.value;
      last = { seq: e.seq, respAt: e.respAt, records: p.records };
    }
    const resourceItems = Object.entries(totals)
      .filter(([n]) => !META_NAMES.has(n))
      .reduce((s, [, v]) => s + v, 0);
    return {
      acks, withResources, withoutResources,
      totals, resourceItems,
      last,
    };
  }

  // ── Endpoint-debugging helpers ──
  // The replay path (resend a captured Далее /proto.html POST) keeps failing
  // with `00 00 00 3d 00 13`. To diagnose we need to see the URL query
  // params, the body opcode, and what differs between two consecutive
  // successful Далее requests. These helpers are pure inspection + a
  // controlled replay tool.

  function _entryBySeq(s) {
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].seq === s) return ring[i];
    return null;
  }

  function _hex(bytes, n) {
    if (!bytes) return '';
    const lim = Math.min(bytes.length, n != null ? n : bytes.length);
    let s = '';
    for (let i = 0; i < lim; i++) {
      s += (bytes[i] < 0x10 ? '0' : '') + bytes[i].toString(16);
      if (i % 2 === 1) s += ' ';
    }
    return s.trim();
  }

  function _ascii(bytes, n) {
    if (!bytes) return '';
    const lim = Math.min(bytes.length, n != null ? n : bytes.length);
    let s = '';
    for (let i = 0; i < lim; i++) {
      const c = bytes[i];
      s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
    }
    return s;
  }

  function _parseUrl(url) {
    if (!url) return { path: null, params: {} };
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    const params = {};
    if (q >= 0) {
      const tail = url.slice(q + 1);
      for (const part of tail.split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) params[decodeURIComponent(part)] = '';
        else params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
      }
    }
    return { path, params };
  }

  // Pretty-dump one entry. Pass a seq, an entry, or omit for newest.
  function describe(arg) {
    let e = null;
    if (arg == null) e = ring[ring.length - 1];
    else if (typeof arg === 'number') e = _entryBySeq(arg);
    else e = arg;
    if (!e) return null;
    const u = _parseUrl(e.url);
    return {
      seq: e.seq,
      url: { path: u.path, params: u.params, raw: e.url },
      env: e.envelope, ok: e.ok, tick: e.tick, load: e.load, http200: e.http200,
      reqLen: e.reqLen, respLen: e.respLen,
      reqHex:   _hex(e.req,  Math.min(e.reqLen, 64)),
      reqAscii: _ascii(e.req, Math.min(e.reqLen, 64)),
      respHex:  _hex(e.resp, Math.min(e.respLen, 64)),
      respAscii:_ascii(e.resp, Math.min(e.respLen, 64)),
      reqAt: e.reqAt, respAt: e.respAt,
    };
  }

  // Filter the ring. opts:
  //   sinceMs        — only entries within last N ms
  //   urlContains    — substring match on full URL
  //   envelope       — 'P' | '0' | '\\x05' | etc
  //   ok / tick / load / err — booleans (combine via OR)
  //   reqLenMin / reqLenMax
  //   respLenMin / respLenMax
  //   reqStartsWith  — array of bytes the request body must start with
  // Returns descriptors (no raw bytes) by default; pass withBytes:true for full.
  function findRequests(opts) {
    opts = opts || {};
    const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
    const out = [];
    for (const e of ring) {
      if (e.respAt < since) continue;
      if (opts.urlContains && (!e.url || e.url.indexOf(opts.urlContains) < 0)) continue;
      if (opts.envelope && e.envelope !== opts.envelope) continue;
      if (opts.reqLenMin != null && e.reqLen < opts.reqLenMin) continue;
      if (opts.reqLenMax != null && e.reqLen > opts.reqLenMax) continue;
      if (opts.respLenMin != null && e.respLen < opts.respLenMin) continue;
      if (opts.respLenMax != null && e.respLen > opts.respLenMax) continue;
      // boolean OR set
      const wantOk = opts.ok, wantTick = opts.tick, wantLoad = opts.load, wantErr = opts.err;
      if (wantOk != null || wantTick != null || wantLoad != null || wantErr != null) {
        let any = false;
        if (wantOk && e.ok) any = true;
        if (wantTick && e.tick) any = true;
        if (wantLoad && e.load) any = true;
        if (wantErr && !e.ok && !e.tick && !e.load) any = true;
        if (!any) continue;
      }
      if (opts.reqStartsWith && e.req) {
        let match = true;
        for (let i = 0; i < opts.reqStartsWith.length; i++) {
          if (e.req[i] !== opts.reqStartsWith[i]) { match = false; break; }
        }
        if (!match) continue;
      }
      out.push(opts.withBytes ? e : describe(e));
    }
    return out;
  }

  // Group recent requests by their (envelope, first 4 req bytes) — a quick
  // way to find rare opcodes (Далее should appear once per farm advance,
  // collect actions appear constantly, ticks dominate everything else).
  function summarize(opts) {
    opts = opts || {};
    const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
    const buckets = {};
    for (const e of ring) {
      if (e.respAt < since) continue;
      const prefix = e.req && e.req.length >= 4
        ? _hex(e.req.slice(0, 4))
        : '(no-body)';
      const key = (e.envelope || '?') + ' | reqPrefix=' + prefix + ' | reqLen=' + e.reqLen;
      const b = buckets[key] || (buckets[key] = { count: 0, env: e.envelope, reqLen: e.reqLen, prefix, lastSeq: 0, lastRespLen: 0 });
      b.count++;
      if (e.seq > b.lastSeq) { b.lastSeq = e.seq; b.lastRespLen = e.respLen; }
    }
    return Object.entries(buckets)
      .map(([k, v]) => Object.assign({ key: k }, v))
      .sort((a, b) => a.count - b.count); // rare opcodes first — Далее candidate
  }

  // Byte-level diff of two requests' bodies + URL params. Useful to spot
  // request_id format, monotonic counters, embedded sequence numbers.
  function diff(seqA, seqB) {
    const a = _entryBySeq(seqA), b = _entryBySeq(seqB);
    if (!a || !b) return { error: 'one or both seqs not in ring' };
    const ua = _parseUrl(a.url), ub = _parseUrl(b.url);
    const urlDiff = { path: ua.path === ub.path ? null : [ua.path, ub.path], params: {} };
    const allKeys = new Set([...Object.keys(ua.params), ...Object.keys(ub.params)]);
    for (const k of allKeys) {
      if (ua.params[k] !== ub.params[k]) urlDiff.params[k] = [ua.params[k], ub.params[k]];
    }
    const bodyDiff = [];
    const aBody = a.req || [], bBody = b.req || [];
    const max = Math.max(aBody.length, bBody.length);
    for (let i = 0; i < max; i++) {
      if (aBody[i] !== bBody[i]) bodyDiff.push({ off: i, a: aBody[i], b: bBody[i] });
    }
    return {
      seqs: [seqA, seqB],
      urlDiff,
      reqLen: [aBody.length, bBody.length],
      bodyDiff: bodyDiff.slice(0, 64),
      bodyDiffCount: bodyDiff.length,
      respLen: [a.respLen, b.respLen],
      respEnv: [a.envelope, b.envelope],
    };
  }

  // Replay a captured request. opts:
  //   urlMutate(urlObj) → urlObj  // mutate {path, params, raw}
  //   bodyMutate(bytes) → bytes   // mutate request body bytes
  //   responseType: default 'arraybuffer'
  // Returns a Promise<{status, respLen, respHex, respAscii, envelope, ok, tick, load}>
  function replay(seq, opts) {
    opts = opts || {};
    const e = _entryBySeq(seq);
    if (!e) return Promise.resolve({ error: 'seq not in ring: ' + seq });
    if (!e.req) return Promise.resolve({ error: 'no captured req body' });
    let url = e.url;
    if (typeof opts.urlMutate === 'function') {
      const u = _parseUrl(e.url);
      const mutated = opts.urlMutate({ path: u.path, params: Object.assign({}, u.params), raw: e.url });
      if (typeof mutated === 'string') {
        url = mutated;
      } else if (mutated && mutated.path) {
        const qs = Object.entries(mutated.params || {}).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
        url = mutated.path + (qs ? '?' + qs : '');
      }
    }
    let body = e.req.slice();
    if (typeof opts.bodyMutate === 'function') {
      const m = opts.bodyMutate(body);
      if (Array.isArray(m) || (m && m.length != null)) body = Array.from(m);
    }
    const buf = new Uint8Array(body).buffer;
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open(e.method || 'POST', url, true);
      x.responseType = opts.responseType || 'arraybuffer';
      x.onload = function() {
        let respBytes = null;
        try { respBytes = x.response instanceof ArrayBuffer ? Array.from(new Uint8Array(x.response)) : null; } catch(_) {}
        let envelope = null, ok = false, tick = false, load = false;
        if (respBytes && respBytes.length >= 2 && respBytes[1] === 0x00) {
          if (respBytes[0] === 0x50)      { ok = true;   envelope = 'P'; }
          else if (respBytes[0] === 0x30) { tick = true; envelope = '0'; }
          else if (respBytes[0] === 0x05) { load = true; envelope = '\\x05'; }
          else                            { envelope = String.fromCharCode(respBytes[0]); }
        }
        resolve({
          status: x.status,
          respLen: respBytes ? respBytes.length : 0,
          respHex:  respBytes ? _hex(respBytes, Math.min(respBytes.length, 64)) : '',
          respAscii: respBytes ? _ascii(respBytes, Math.min(respBytes.length, 64)) : '',
          envelope, ok, tick, load,
          urlSent: url,
          bodyLenSent: body.length,
          // Full response bytes — callers that need to parse the body (farm-loads,
          // collect deltas, server error reasons) get the bytes directly instead
          // of fishing the ring for a sibling entry. Sidechannel lookup races
          // against background game traffic when the server is in an error loop.
          resp: respBytes,
        });
      };
      x.onerror = function() { resolve({ error: 'xhr error', status: x.status }); };
      x.send(buf);
    });
  }

  return {
    awaitNextResponse,
    getStats() {
      return { totalSeen, totalOk, totalErr, totalTick, totalLoad, total200, lastOkAt, lastErrAt, lastLoadAt, lastResponseAt, ringLen: ring.length };
    },
    dump,
    clearRing,
    parseFarmLoad,
    parseCollectResp,
    lastCollectStats,
    lastFarmObjects,
    lastFarmLoadSeq,
    awaitNextFarmLoad,
    isCollectible,
    // Endpoint-debugging surface
    describe,
    findRequests,
    summarize,
    diff,
    replay,
    // Cheap "did anything succeed in the last N ms?" — useful for a passive
    // sanity check after a known game action.
    wasRecentSuccess(sinceMs) { return Date.now() - lastOkAt < sinceMs; },
    wasRecentError(sinceMs)   { return Date.now() - lastErrAt < sinceMs; },
  };
})();
}
