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
  let lastOkAt = 0, lastErrAt = 0, lastResponseAt = 0;

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
        this.addEventListener('load', () => {
          totalSeen++;
          lastResponseAt = Date.now();
          let ok = false, tick = false, http200 = false;
          let envelope = null;
          let respBytes = null;
          try { http200 = this.status === 200; } catch (e) {}
          try {
            if (this.response instanceof ArrayBuffer) {
              respBytes = Array.from(new Uint8Array(this.response));
              // Envelope discrimination: 0x50 0x00 ('P\0') = click-acknowledged
              // (action produced state change — friend-farm collects). 0x30 0x00
              // ('0\0') = background tick (no action). Both are HTTP 200.
              if (respBytes.length >= 2 && respBytes[1] === 0x00) {
                if (respBytes[0] === 0x50)      { ok = true;   envelope = 'P'; }
                else if (respBytes[0] === 0x30) { tick = true; envelope = '0'; }
                else                            { envelope = String.fromCharCode(respBytes[0]); }
              }
            }
          } catch (e) {}
          if (http200) total200++;
          if (ok)        { totalOk++;   lastOkAt  = lastResponseAt; }
          else if (tick) { totalTick++; }
          else           { totalErr++;  lastErrAt = lastResponseAt; }
          pushRing({
            url: reqUrl,
            reqAt, respAt: lastResponseAt,
            ok, tick, http200, envelope,
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

  // Cheap "is there a farm-load in the ring, and what's its seq?" — no
  // packet parsing. opts: { minRespLen: number }. Returns null if none.
  function lastFarmLoadSeq(opts) {
    opts = opts || {};
    const minLen = opts.minRespLen || 8000;
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      if (e.ok && e.respLen >= minLen && e.resp) return e.seq;
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
    const minLen = opts.minRespLen || 8000; // farm-load is ~67KB; tick polls ~3KB
    let pick = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      if (!e.ok) continue;
      if (e.respLen < minLen) continue;
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

  return {
    awaitNextResponse,
    getStats() {
      return { totalSeen, totalOk, totalErr, totalTick, total200, lastOkAt, lastErrAt, lastResponseAt, ringLen: ring.length };
    },
    dump,
    clearRing,
    parseFarmLoad,
    lastFarmObjects,
    lastFarmLoadSeq,
    awaitNextFarmLoad,
    isCollectible,
    // Cheap "did anything succeed in the last N ms?" — useful for a passive
    // sanity check after a known game action.
    wasRecentSuccess(sinceMs) { return Date.now() - lastOkAt < sinceMs; },
    wasRecentError(sinceMs)   { return Date.now() - lastErrAt < sinceMs; },
  };
})();
}
