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
  let totalOk = 0, totalErr = 0, totalSeen = 0;
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
          let ok = false;
          let respBytes = null;
          try {
            if (this.response instanceof ArrayBuffer) {
              respBytes = Array.from(new Uint8Array(this.response));
              // 0x50 0x00 ('P\0') is the click-acknowledged envelope
              // (action produced game state change). 0x30 0x00 ('0\0')
              // is the background-tick envelope (no action). We want
              // only the former as the success oracle.
              if (respBytes.length >= 2 && respBytes[0] === 0x50 && respBytes[1] === 0x00) {
                ok = true;
              }
            }
          } catch (e) {}
          if (ok) { totalOk++; lastOkAt = lastResponseAt; }
          else    { totalErr++; lastErrAt = lastResponseAt; }
          pushRing({
            url: reqUrl,
            reqAt, respAt: lastResponseAt,
            ok,
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

  return {
    awaitNextResponse,
    getStats() {
      return { totalSeen, totalOk, totalErr, lastOkAt, lastErrAt, lastResponseAt, ringLen: ring.length };
    },
    dump,
    clearRing,
    // Cheap "did anything succeed in the last N ms?" — useful for a passive
    // sanity check after a known game action.
    wasRecentSuccess(sinceMs) { return Date.now() - lastOkAt < sinceMs; },
    wasRecentError(sinceMs)   { return Date.now() - lastErrAt < sinceMs; },
  };
})();
}
