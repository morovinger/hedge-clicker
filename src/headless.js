// ── HC_Headless: pure-XHR friend-farm cycle, no canvas clicks ──
//
// Drives the entire travel cycle (own-farm → travel-prep → friends-hub →
// farm[0..N] → own-farm) by fabricating /proto.html POSTs directly. No
// dependency on HC_DbgClick, no need for the game tab to be foregrounded.
//
// Server endpoints used (see doc/08-network-replay-and-protocol.md):
//   5000 07VV  — В путь (start travel cycle, fetch friend list)
//   0500 01VV  — enter friend farm
//   5000 03VV  — collect single object (eid + type known from farm-load)
//   5000 09VV  — Далее (advance to next friend)
// VV is the protocol-version byte (0x3d until mid-2026, 0x4e since the
// 2026-10 game update). The server rejects a mismatched VV with err 0x01,
// so it's read from live traffic — see protoVer().
//
// Per-click hash is server-side IGNORED → we forge a random hex string.
// request_id second-part must be monotonically increasing per-session →
// we use Date.now() suffix.
//
// Trade-off vs the click-based loop: the game's PIXI client can't tell
// these requests happened, so the canvas UI desyncs from server state.
// That's fine for headless operation; if you want a synced UI, reload.

if (window.HC_Headless) {
  console.log('[HC] Headless already installed — reusing.');
} else {
window.HC_Headless = (function() {
  const N = window.HC_Net;
  if (!N) { console.error('[HC_Headless] HC_Net missing — cannot install.'); return null; }

  // ── log buffer (shared with HC_Visit-style UI) ──
  const logBuf = [];
  function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    const line = '[' + ts + '] ' + msg;
    logBuf.push(line);
    if (logBuf.length > 200) logBuf.shift();
    console.log('[HC_Headless]', msg);
    try { window.parent.postMessage({ type: 'HC_LOG', line: '[HC_Headless] ' + msg }, '*'); } catch (e) {}
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── request_id generator: monotonic per-session ──
  // Format <7d random>.<integer>. The second part must be ≥ the highest
  // the server has seen this session, so we anchor to Date.now() ms.
  // The % 1e8 wraps every ~27.8h; the lastReqCounter guard keeps the
  // counter monotonic across the wrap (a lower value → err 0x13).
  let lastReqCounter = 0;
  function freshReqId() {
    let c = Date.now() % 100000000;
    if (c <= lastReqCounter) c = lastReqCounter + 1;
    lastReqCounter = c;
    return Math.floor(Math.random() * 9e6 + 1e6) + '.' + c;
  }

  // ── pick the most recent /proto.html template to copy URL skeleton ──
  // We need a real recent /proto.html capture for: sid, host, path, base
  // params. Without one we can't fabricate URLs.
  function latestProtoTemplate() {
    const all = N.findRequests({ sinceMs: 3600000, withBytes: true });
    return all.length ? all[all.length - 1] : null;
  }

  // ── Protocol-version byte (byte 3 of every request and response) ──
  // Taken from the newest server response in the ring: the server is
  // authoritative (even its error envelopes `00 00 00 VV` carry it), and
  // the game's own first request (own-farm load) always lands there.
  const DEFAULT_PROTO_VER = 0x4e;
  function protoVer() {
    const all = N.findRequests({ sinceMs: 3600000, withBytes: true });
    for (let i = all.length - 1; i >= 0; i--) {
      const resp = all[i].resp;
      if (resp && resp.length >= 4) return resp[3];
    }
    return DEFAULT_PROTO_VER;
  }

  // 4-byte request header: <b0> 00 <b2> <version>
  function hdr(b0, b2) { return [b0, 0x00, b2, protoVer()]; }

  // ── Direct send: build URL from a template + body bytes, return parsed response ──
  function send(opcodeBytes, bodyBytes, opts) {
    opts = opts || {};
    const tmpl = latestProtoTemplate();
    if (!tmpl) return Promise.resolve({ error: 'no /proto.html template in ring — fire any in-game action once first' });
    return N.replay(tmpl.seq, {
      urlMutate(u) {
        u.params.proto = opts.proto || u.params.proto;
        u.params.request_id = freshReqId();
        return u;
      },
      bodyMutate() { return bodyBytes; },
    });
  }

  // ── Body builders ──
  function buildVoyage(friendIdHex32) {
    // 50 00 07 VV  00 00 00 00 00  <32 ASCII hex>
    const out = hdr(0x50, 0x07).concat([0x00, 0x00, 0x00, 0x00, 0x00]);
    for (let i = 0; i < 32; i++) out.push(friendIdHex32.charCodeAt(i));
    return out;
  }

  // Captured request templates, pinned so they survive ring eviction (the
  // 32-entry ring only covers ~2-3 minutes once background ticks churn
  // through it — the "last hour" findRequests window is much wider than
  // what the ring actually retains).
  const pinnedTpl = {};

  // Enter-farm body — when possible, copy bytes from a captured template
  // and only swap the trailing 32-char friend ID. Avoids any byte-ordering
  // drift between game versions. Falls back to a synthesized body that
  // matches the format observed in this session's captures:
  //   05 00 01 VV  00 03 00 00 00  01 00 00  <32 ASCII hex>
  function buildEnterFarm(friendIdHex32) {
    const tpl = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: hdr(0x05, 0x01) }).slice(-1)[0];
    if (tpl && tpl.req && tpl.req.length === 44) pinnedTpl.enter = tpl.req.slice();
    if (pinnedTpl.enter) {
      const out = pinnedTpl.enter.slice();
      out[3] = protoVer();
      for (let i = 0; i < 32; i++) out[12 + i] = friendIdHex32.charCodeAt(i);
      return out;
    }
    // synthesized fallback — header is 12 bytes, friend id is 32 bytes
    const out = hdr(0x05, 0x01).concat([0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
    for (let i = 0; i < 32; i++) out.push(friendIdHex32.charCodeAt(i));
    return out;
  }

  function buildDalee(friendIdHex32) {
    // Prefer copying captured Далее template (same trick as buildEnterFarm).
    const tpl = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: hdr(0x50, 0x09) }).slice(-1)[0];
    if (tpl && tpl.req && tpl.req.length === 41) pinnedTpl.dalee = tpl.req.slice();
    if (pinnedTpl.dalee) {
      const out = pinnedTpl.dalee.slice();
      out[3] = protoVer();
      for (let i = 0; i < 32; i++) out[9 + i] = friendIdHex32.charCodeAt(i);
      return out;
    }
    const out = hdr(0x50, 0x09).concat([0x00, 0x00, 0x00, 0x00, 0x00]);
    for (let i = 0; i < 32; i++) out.push(friendIdHex32.charCodeAt(i));
    return out;
  }

  // 50 00 03 VV  00 <contentLen-uint8> 00 00 00
  // 24 00 <36-char UUID with dashes>
  // <typeCode-uint8> <eid-uint32-LE> <typeNameLen-uint16-LE> <ASCII type>
  // 01 00 00 00 <32-char ASCII hex (random — server-ignored)>
  function buildCollect(friendUuidWithDashes, typeCode, eid, typeName) {
    const out = hdr(0x50, 0x03).concat([0x00]);
    // content-len placeholder at out[5] — patched at end
    out.push(0x00); // placeholder
    out.push(0x00, 0x00, 0x00);
    out.push(0x24, 0x00);
    if (friendUuidWithDashes.length !== 36) throw new Error('uuid must be 36 chars: ' + friendUuidWithDashes);
    for (let i = 0; i < 36; i++) out.push(friendUuidWithDashes.charCodeAt(i));
    out.push(typeCode & 0xff);
    out.push(eid & 0xff, (eid >>> 8) & 0xff, (eid >>> 16) & 0xff, (eid >>> 24) & 0xff);
    out.push(typeName.length & 0xff, (typeName.length >>> 8) & 0xff);
    for (let i = 0; i < typeName.length; i++) out.push(typeName.charCodeAt(i));
    out.push(0x01, 0x00, 0x00, 0x00);
    // random 32-char ASCII hex hash (server ignores)
    const hex = '0123456789abcdef';
    for (let i = 0; i < 32; i++) out.push(hex.charCodeAt((Math.random() * 16) | 0));
    // Patch content-len: total - 41 (header bytes)
    out[5] = (out.length - 41) & 0xff;
    return out;
  }

  // ── Type-prefix → typeCode mapping (collect request byte 47) ──
  // Observed: 01=sb_, 02=ga_, 03=te_. Others TBD; extend as needed.
  function typeCodeFor(typeName) {
    const pfx = typeName.slice(0, 3);
    return TYPE_PREFIX_CODE[pfx] || 0x00;
  }

  // ── Parsers ──

  // Parse the friend list from a captured В путь (5000 07VV) response.
  // Each friend record begins with `24 00` followed by a 36-char ASCII UUID.
  function parseVoyageResp(bytes) {
    if (!bytes) return [];
    const friends = [];
    for (let i = 0; i + 38 <= bytes.length; i++) {
      if (bytes[i] !== 0x24 || bytes[i + 1] !== 0x00) continue;
      let ok = true, s = '';
      for (let j = 0; j < 36; j++) {
        const c = bytes[i + 2 + j];
        if (j === 8 || j === 13 || j === 18 || j === 23) { if (c !== 0x2d) { ok = false; break; } }
        else if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) { ok = false; break; }
        s += String.fromCharCode(c);
      }
      if (ok) {
        friends.push({ uuid: s, hex32: s.replace(/-/g, '') });
        i += 37;
      }
    }
    return friends;
  }

  // Parse a friend-farm load. Records are anchored on type-name strings
  // that start with a known prefix (ga_/te_/sb_/fl_/pl_/ra_/dc_/tl_/bl_).
  // For each match we walk back 14 bytes to read:
  //   [uint32 LE eid][uint32 LE field1][uint32 LE field2][uint16 LE typeLen]
  // This works across both farm-load formats observed (with delimiter
  // `06 7d da 41 00` AND without it). Reading backward is cheap because
  // type prefixes are rare.
  // Prefixes that PARSE — used by parseFarmLoadV2 to anchor records.
  // (Includes scenery so the whole record list is parsed for diagnostics.)
  const KNOWN_PREFIXES = ['ga_', 'te_', 'sb_', 'fl_', 'pl_', 'ra_', 'dc_', 'tl_', 'bl_', 'fe_', 'pi_'];
  // Prefixes that are actually COLLECTIBLE on a friend's farm.
  // Per doc 06: te_/sb_/pl_/pi_/fl_. Subset of ga_ subtypes (wild_onion, tree)
  // were observed collectible too — we keep ga_ only when it matches a known
  // collectible-subtype regex; otherwise scenery (ga_grass3, ga_birch3, ...)
  // produces the "FriendAction: does not have available actions" error.
  const COLLECTIBLE_PREFIXES = ['te_', 'sb_', 'pl_', 'pi_', 'fl_'];
  const COLLECTIBLE_GA_RE = /^ga_(wild_|tree$|wild_onion)/;
  function isCollectibleType(typeName) {
    const pfx = typeName.slice(0, 3);
    if (COLLECTIBLE_PREFIXES.indexOf(pfx) >= 0) return true;
    if (pfx === 'ga_' && COLLECTIBLE_GA_RE.test(typeName)) return true;
    return false;
  }
  // Type-prefix code for collect requests (byte 47 of 5000 03VV body).
  // Verified: 01=sb_, 02=ga_, 03=te_. Others empirically guessed.
  const TYPE_PREFIX_CODE = { sb_: 0x01, ga_: 0x02, te_: 0x03, pl_: 0x04, fl_: 0x05, pi_: 0x06 };

  function parseFarmLoadV2(bytes) {
    if (!bytes) return [];
    const out = [];
    const seen = new Set();
    const N_ = bytes.length;
    for (let i = 14; i < N_ - 4; i++) {
      // Look for length-prefixed type-name: <uint16 typeLen> <prefix>
      if (bytes[i] === 0 || bytes[i] > 32) continue; // typeLen 1..32
      if (bytes[i + 1] !== 0) continue;
      const typeLen = bytes[i];
      if (i + 2 + typeLen > N_) continue;
      // Check prefix: byte[i+2..i+4] is "xx_"
      if (bytes[i + 4] !== 0x5f) continue;
      const c0 = bytes[i + 2], c1 = bytes[i + 3];
      if (c0 < 0x61 || c0 > 0x7a || c1 < 0x61 || c1 > 0x7a) continue;
      const prefix = String.fromCharCode(c0) + String.fromCharCode(c1) + '_';
      if (KNOWN_PREFIXES.indexOf(prefix) < 0) continue;
      // Read full type-name and ensure all printable
      let type = '', okType = true;
      for (let j = 0; j < typeLen; j++) {
        const c = bytes[i + 2 + j];
        if (c < 0x20 || c > 0x7e) { okType = false; break; }
        type += String.fromCharCode(c);
      }
      if (!okType) continue;
      // Walk back 14 bytes to read eid + field1 + field2 (+ typeLen at i)
      const p = i - 14;
      if (p < 0) continue;
      const eid    = bytes[p] | (bytes[p+1] << 8) | (bytes[p+2] << 16) | (bytes[p+3] << 24);
      const field1 = bytes[p+4] | (bytes[p+5] << 8) | (bytes[p+6] << 16) | (bytes[p+7] << 24);
      const field2 = bytes[p+8] | (bytes[p+9] << 8) | (bytes[p+10] << 16) | (bytes[p+11] << 24);
      // Sanity: eid must be a non-zero positive uint32 < ~10M
      if (eid === 0 || eid > 10_000_000) continue;
      if (seen.has(eid)) continue;
      seen.add(eid);
      out.push({ eid: eid >>> 0, field1: field1 | 0, field2: field2 | 0, type, prefix, off: i });
      i = i + 2 + typeLen - 1;
    }
    return out;
  }

  // ── High-level operations ──

  async function fetchFriendList() {
    // Always fire a fresh В путь — it (re)starts travel mode server-side.
    // Reusing a cached response from a previous cycle skips that step, so
    // the following enter-friend calls bounce with "user not in travel";
    // reusing a cached *error* response parses to 0 friends and dead-ends
    // the cycle. The friend ID in the body is payload-irrelevant (doc 08),
    // so any captured one (or zeros) works.
    const enterTpl = N.findRequests({ sinceMs: 3600000, withBytes: true, reqStartsWith: hdr(0x05, 0x01) }).slice(-1)[0];
    let placeholderId = '00000000000000000000000000000000';
    if (enterTpl) {
      const tail = enterTpl.req.slice(enterTpl.req.length - 32);
      placeholderId = String.fromCharCode.apply(null, tail);
    }
    const r = await send(hdr(0x50, 0x07), buildVoyage(placeholderId), { proto: '50x7' });
    if (r.error) {
      log('В путь failed: ' + r.error);
      return { error: r.error };
    }
    const envLabel = (r.envelope == null || r.envelope === '') ? '\\x00(err)' : r.envelope;
    log('В путь fired: env=' + envLabel + ' respLen=' + r.respLen);
    const diag = diagnoseErrorResp(r.resp);
    if (diag) {
      log('  ✗ ' + diag);
      return { error: diag };
    }
    // replay() returns the full response bytes — parse them directly. No
    // ring round-trip: that race against background ticks is what made the
    // old cached-voyage path grab stale or errored entries.
    const friends = parseVoyageResp(r.resp);
    log('parsed ' + friends.length + ' friends from В путь response');
    return { friends };
  }

  // Classify a /proto.html error response (envelope `00 00`). Returns a
  // human-readable diagnosis or null if the bytes don't look like an error.
  // Error format (per doc 08):
  //   00 00 <opcode-2B> 00 <code-uint8> [trailing ASCII reason]
  function diagnoseErrorResp(bytes) {
    if (!bytes || bytes.length < 6) return null;
    if (bytes[0] !== 0x00 || bytes[1] !== 0x00) return null;
    const code = bytes[5];
    let tail = '';
    for (let i = 6; i < Math.min(bytes.length, 200); i++) {
      const c = bytes[i];
      if (c >= 0x20 && c < 0x7f) tail += String.fromCharCode(c);
    }
    if (code === 0x02) {
      return 'server state desync (err 0x02) — reload the game page, then retry';
    }
    if (code === 0x13) {
      return 'request_id rejected (err 0x13 "' + tail + '") — sid in template is stale; reload page';
    }
    if (code === 0x32) {
      return 'object not collectible (err 0x32) — ' + tail;
    }
    if (code === 0x61) {
      return 'per-friend quota exhausted (err 0x61) — ' + tail;
    }
    return 'server error code 0x' + code.toString(16).padStart(2, '0') + (tail ? ' "' + tail + '"' : '');
  }

  async function enterFriendFarm(friendHex32) {
    log('entering friend ' + friendHex32.slice(0, 8) + '…');
    const r = await send(hdr(0x05, 0x01), buildEnterFarm(friendHex32), { proto: '5x1' });
    log('  enter result: env=' + r.envelope + ' ok=' + r.ok + ' load=' + r.load + ' respLen=' + r.respLen);
    const diag = diagnoseErrorResp(r.resp);
    if (diag) log('  ✗ ' + diag);
    // Use replay's own bytes — game's error-retry flood can evict ring entries
    // before we can read them back.
    const farmLoad = (r.resp && r.respLen >= 5000) ? { resp: r.resp, respLen: r.respLen } : null;
    return { result: r, farmLoad };
  }

  async function collectAll(friendUuidWithDashes, farmLoadBytes, opts) {
    opts = opts || {};
    const interMs = opts.interMs != null ? opts.interMs : 80;
    const stopOnConsecErrors = opts.stopOnConsecErrors != null ? opts.stopOnConsecErrors : 5;
    // Backpack-full signal (per doc 08): server keeps returning P\0 acks but
    // with no ra_* records. After this many consecutive empty-ok responses we
    // assume the backpack is full and abort the whole cycle.
    const stopOnConsecEmpty = opts.stopOnConsecEmpty != null ? opts.stopOnConsecEmpty : 5;
    const objs = parseFarmLoadV2(farmLoadBytes);
    const collectibles = objs.filter(o => isCollectibleType(o.type));
    // Type histogram for diagnostics
    const typeHist = {};
    for (const o of collectibles) typeHist[o.type] = (typeHist[o.type] || 0) + 1;
    log('  parsed ' + objs.length + ' total / ' + collectibles.length + ' collectibles: ' +
        Object.entries(typeHist).map(([k, v]) => k + ':' + v).join(' '));
    let tried = 0, acks = 0, errs = 0, consecErr = 0, quotaHit = false;
    let withRes = 0, withoutRes = 0, consecEmpty = 0, backpackFull = false;
    const resourceTotals = {};
    // Standalone calls (console debugging) run with running=false — clear
    // any stale stop flag so the loop actually executes. Inside runCycle
    // the flag is managed by runCycle/stop.
    if (!running) stopRequested = false;
    for (const o of collectibles) {
      if (stopRequested) break;
      const tc = typeCodeFor(o.type);
      if (tc === 0x00) continue;
      const r = await send(hdr(0x50, 0x03), buildCollect(friendUuidWithDashes, tc, o.eid, o.type), { proto: '50x3' });
      tried++;
      if (r.ok) {
        acks++; consecErr = 0;
        // Parse the ack to detect backpack-full. resources excludes Exp/Coins/Energy.
        const p = N.parseCollectResp(r.resp);
        if (p && p.resources && p.resources.length > 0) {
          withRes++; consecEmpty = 0;
          for (const rec of p.resources) {
            resourceTotals[rec.name] = (resourceTotals[rec.name] || 0) + rec.value;
          }
        } else {
          withoutRes++; consecEmpty++;
          if (consecEmpty >= stopOnConsecEmpty) {
            backpackFull = true;
            log('  backpack full — ' + consecEmpty + ' consecutive ok-but-empty acks');
            break;
          }
        }
      } else {
        errs++;
        consecErr++;
        // Read the error reason from r.resp directly (the ring sidechannel
        // races against the game's error-retry flood and grabs the wrong entry).
        if (errs <= 2 || consecErr === stopOnConsecErrors) {
          const reason = r.resp ? r.resp.slice(0, 80).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('') : '(no resp)';
          log('    err #' + errs + ' env=' + r.envelope + ' len=' + r.respLen + ': ' + reason);
          if (reason.indexOf('does not have availible actions') >= 0 ||
              reason.indexOf('does not have available actions') >= 0) {
            quotaHit = true;
          }
        }
        if (consecErr >= stopOnConsecErrors) {
          log('  stopping collect: ' + consecErr + ' consecutive errors' + (quotaHit ? ' (friend quota hit)' : ''));
          break;
        }
      }
      await sleep(interMs);
    }
    const lootSummary = Object.entries(resourceTotals).map(([k, v]) => k + ':' + v).join(' ') || '(none)';
    log('  collect pass: tried=' + tried + ' ok=' + acks +
        ' (loot:' + withRes + ' empty:' + withoutRes + ') err=' + errs +
        (quotaHit ? ' QUOTA' : '') + (backpackFull ? ' BACKPACK_FULL' : ''));
    if (withRes > 0) log('    loot: ' + lootSummary);
    return { tried, acks, errs, quotaHit, withRes, withoutRes, backpackFull, resourceTotals };
  }

  async function dalee(nextFriendHex32) {
    log('Далее → ' + nextFriendHex32.slice(0, 8) + '…');
    const r = await send(hdr(0x50, 0x09), buildDalee(nextFriendHex32), { proto: '50x9' });
    log('  Далее result: env=' + r.envelope + ' ok=' + r.ok + ' respLen=' + r.respLen);
    const diag = diagnoseErrorResp(r.resp);
    if (diag) log('  ✗ ' + diag);
    // The paired \x05 farm-load never arrives for fabricated XHRs (doc 08
    // client-desync gotcha), and runCycle re-enters each friend explicitly
    // anyway — so no ring polling here. Keep the farm-load only when the
    // server happens to return it inline with the ack.
    const farmLoad = (r.resp && r.respLen >= 5000) ? { resp: r.resp, respLen: r.respLen } : null;
    return { result: r, farmLoad };
  }

  // ── Full cycle ──
  let running = false;
  let stopRequested = false;

  async function runCycle(opts) {
    opts = opts || {};
    if (running) { log('runCycle ignored — already running'); return; }
    running = true;
    stopRequested = false;
    try {
      log('=== headless cycle START ===');
      const fl = await fetchFriendList();
      if (!fl.friends || fl.friends.length === 0) {
        log('STOP — no friends' + (fl.error ? ' (' + fl.error + ')' : ''));
        return;
      }
      // Default: iterate every candidate the В путь response gave us. The cycle
      // self-terminates when the backpack fills, so an explicit cap is only
      // useful for debug runs (e.g. maxFriends: 1).
      const max = opts.maxFriends || fl.friends.length;
      log('cycle plan: up to ' + max + ' friends (will stop on backpack-full)');
      const totalLoot = {};
      let visited = 0, backpackFull = false, quotaCount = 0;
      for (let i = 0; i < max; i++) {
        if (!running) { log('aborted'); break; }
        const f = fl.friends[i];
        log('— friend ' + (i + 1) + '/' + max + ' uuid=' + f.uuid);
        const enter = await enterFriendFarm(f.hex32);
        if (!enter.farmLoad) { log('  no farm-load captured; skipping collect'); }
        else {
          const result = await collectAll(f.uuid, enter.farmLoad.resp, opts);
          visited++;
          if (result.quotaHit) quotaCount++;
          if (result.resourceTotals) {
            for (const k of Object.keys(result.resourceTotals)) {
              totalLoot[k] = (totalLoot[k] || 0) + result.resourceTotals[k];
            }
          }
          if (result.backpackFull) { backpackFull = true; break; }
        }
        if (i + 1 < max) {
          await dalee(fl.friends[i + 1].hex32);
        }
      }
      const lootStr = Object.entries(totalLoot).map(([k, v]) => k + ':' + v).join(' ') || '(none)';
      log('=== headless cycle END (visited=' + visited +
          ', quotaHits=' + quotaCount +
          (backpackFull ? ', BACKPACK_FULL' : '') +
          ') loot: ' + lootStr + ' ===');
    } catch (e) {
      log('CRASH: ' + (e && e.stack || e));
    } finally {
      running = false;
    }
  }

  function stop() { stopRequested = true; running = false; log('stop requested'); }
  function isRunning() { return running; }

  function help() {
    const lines = [
      'HC_Headless — pure-XHR friend-farm cycle (no canvas clicks).',
      '',
      'Console one-liners (inside the game iframe):',
      '  HC_Headless.runCycle()              // full cycle, all candidate friends, stops on backpack-full',
      '  HC_Headless.runCycle({maxFriends:1})// debug: visit a single friend',
      '  HC_Headless.runCycle({interMs:200}) // slower per-collect spacing (default 80ms)',
      '  HC_Headless.stop()                  // abort the running cycle',
      '  HC_Headless.isRunning()             // bool',
      '  HC_Headless.getLog()                // last 200 log lines',
      '  HC_Headless.clearLog()',
      '',
      'From the parent frame:',
      "  H = document.querySelector('iframe').contentWindow.HC_Headless",
      '  H.runCycle()',
      '',
      'Cycle stops on: backpack full (5 consecutive ok-but-empty acks), or all',
      'candidate friends visited, or stop() called.',
    ];
    console.log(lines.join('\n'));
    return lines.join('\n');
  }

  // One-shot banner so the user sees the entry points on first install.
  console.log('[HC_Headless] installed. Type HC_Headless.help() for usage.');

  return {
    runCycle, stop, isRunning, help,
    // helpers exposed for debugging / panel use
    fetchFriendList,
    enterFriendFarm,
    dalee,
    collectAll,
    parseVoyageResp,
    parseFarmLoadV2,
    buildVoyage, buildEnterFarm, buildDalee, buildCollect,
    typeCodeFor,
    freshReqId,
    getLog() { return logBuf.slice(); },
    clearLog() { logBuf.length = 0; },
  };
})();
}
