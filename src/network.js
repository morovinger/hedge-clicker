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

  if (!XMLHttpRequest.prototype.__hcNetWrapped) {
    XMLHttpRequest.prototype.__hcNetWrapped = true;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__hcIsProto = (typeof url === 'string' && url.indexOf('/proto.html') >= 0);
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (this.__hcIsProto) {
        // Force binary so we can read the opcode bytes
        try { if (!this.responseType) this.responseType = 'arraybuffer'; } catch (e) {}
        this.addEventListener('load', () => {
          totalSeen++;
          lastResponseAt = Date.now();
          try {
            if (!(this.response instanceof ArrayBuffer)) return;
            const u8 = new Uint8Array(this.response);
            // Success envelope starts with 0x80 0x00; error with 0x00 0x00
            if (u8.length >= 2 && u8[0] === 0x80 && u8[1] === 0x00) {
              totalOk++;
              lastOkAt = lastResponseAt;
            } else {
              totalErr++;
              lastErrAt = lastResponseAt;
            }
          } catch (e) {}
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

  return {
    awaitNextResponse,
    getStats() {
      return { totalSeen, totalOk, totalErr, lastOkAt, lastErrAt, lastResponseAt };
    },
    // Cheap "did anything succeed in the last N ms?" — useful for a passive
    // sanity check after a known game action.
    wasRecentSuccess(sinceMs) { return Date.now() - lastOkAt < sinceMs; },
    wasRecentError(sinceMs)   { return Date.now() - lastErrAt < sinceMs; },
  };
})();
}
