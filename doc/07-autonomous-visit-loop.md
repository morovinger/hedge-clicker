# 07 — Autonomous farm-to-farm Visit loop

Status: **Working primitive — popup advance + hub bootstrap need live tuning**

This entry covers the work done on 2026-04-30: removing the dead pixel-based
"smart" pipeline, calibrating the advance buttons, and turning `HC_Visit`
into a self-bootstrapping loop that runs friend-farm to friend-farm until
the backpack is full.

## What was removed

The vision-based smart mode was abandoned in #01–#04, but its source files
were still bundled and the `clicker.js` module was still being initialised.
That left a dead `cap.requestFrame()` call path that threw on every
`HC_Clicker.scanOnce()` and every Smart-mode tick.

Deleted:

- `src/clicker.js` — the old smart/grid/single state machine (referenced
  `cap.requestFrame()`/`cap.getFrame()` which no longer exist).
- `src/vision.js` — `rgbToHsl` / `scanFrame` / `samplePixel`. Nothing else
  consumed it.
- `src/config.js` — `HC_CFG` (`scanInterval`, `targets`, `clusterRadius`,
  …). Only `clicker.js` and the old UI read it.

`src/capture.js` is kept as a thin canvas locator — `HC_Visit`,
`HC_DbgClick`, `HC_Overlay` all still ask `HC_Capture.canvas`. The build
order list and the postMessage bridge in `build.js` were trimmed to drop
the deleted modules and the `HC_Clicker`/`HC_Vision`/`HC_CFG` command
handlers.

`src/ui.js` was rewritten as a Visit-only panel: START/STOP, Sweep Once,
Enter Hub Farm, Probe DbgClick, three coord pickers (Далее / Выйти /
Popup Далее), live diagnostic line, and a 160 px scrollable log box.

## What was calibrated

Coordinates that the loop needs, all in canvas-pixel space (1000×700):

| Button | Coord | Notes |
|---|---|---|
| Bottom-left "Выйти" | `(80, 660)` | Returns from a friend farm to the hub. |
| Bottom-left "Далее" | `(200, 660)` | Advances to the *next* friend farm without going through the hub. Verified end-to-end on 2026-04-30: clicking it advanced from `наина haiha` to `Марина Д.` |
| Popup-center "Далее" | `(500, 310)` (default; recalibratable) | The dialog that pops up when a farm is fully harvested ("Здесь нам делать больше нечего. Отправляемся дальше!"). The bottom-left Далее sits behind this popup and only takes clicks once the popup is dismissed, so the popup button must be tried first. |

`HC_Visit` exposes `setNextBtn`, `setPopupNextBtn`, `setHomeBtn` for
manual tuning; the panel has matching pickers.

## How the loop runs

`HC_Visit.start()` →

1. `lastFarmSeq()` reads `HC_Net.lastFarmObjects().source.seq`. Null →
   we're not in a farm (or the farm-load XHR aged out of `HC_Net`'s 32-
   entry ring).
2. If null, `enterFarmFromHub()` walks a coarse 5×4 grid over the hub
   playfield (`HUB_PROBES`, x=200–850 step 130, y=220–520 step 100, 24
   total). After each click it polls `lastFarmSeq()` for up to
   `hubProbeTimeout` ms; the first probe that increments the seq wins.
3. Main loop, while `running`:
    1. Capture `seqBeforeSweep`.
    2. Run one full grid pass (`farmPass`) — 14×9 = 126 cells, 300 ms
       between clicks, ~38 s total. Every click is non-awaited; we
       measure success by the `HC_Net.totalOk` delta after a 1.8 s
       settle.
    3. `tryAdvance(seqBeforeSweep)` clicks `BTN.popupNext`, awaits a
       farm-load XHR; if none, clicks `BTN.next`, awaits again. First
       seq increment wins.
    4. If neither candidate produced a farm-load → bump `emptyAdvances`.
       After `stopAfterEmptyAdvances=2` consecutive empties, stop. This
       is the backpack-full proxy: when the bag is full the game blocks
       the transition and no new farm-load arrives. Between empties we
       try one `enterFarmFromHub()` recovery.

`maxSweepsPerFarm` was reduced from 4 → 1: a single full pass collects
every instant-collect resource, and the gained-oks threshold can't tell
an exhausted farm from a fresh one (background tiles also return
`0x80 OK` on click, so even an empty farm produces ~50+ oks per sweep).

## Coordinate plumbing

Three different pixel spaces are at play; mixing them was the source of
most failed clicks:

| Space | Range | Where |
|---|---|---|
| Canvas pixels | 0..1000 × 0..700 | What the game renders in. All `HC_Visit` and `HC_Overlay` coords. |
| Iframe-viewport pixels | varies | What `chrome.debugger Input.dispatchMouseEvent` accepts (the extension attaches to the iframe target). |
| Top-frame viewport pixels | varies | What CSS clicks land on. `iframe.getBoundingClientRect()` gives the iframe origin in this space. |

`HC_DbgClick.click(x, y)` expects iframe-viewport coords, not canvas
coords. The visit.js helper does the translation:

```js
const rect = canvas.getBoundingClientRect();
const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
HC_DbgClick.click(rect.left + cx / sx, rect.top + cy / sy);
```

The iframe's `rect.left` shifts when the HC Vision panel expands /
collapses (the page's flex layout re-centers), so always re-read the
rect per click; never cache.

The MCP claude-in-chrome `computer.left_click` `coordinate` parameter
is **also** in viewport pixels, not screenshot pixels. The screenshot
renders at a smaller scale (e.g. 1242×952 for a 1595×1223 viewport,
ratio ≈ 0.78) so picking pixels off a screenshot needs the inverse
multiplier before clicking.

## Known issues / open work

1. **MCP debugger vs. extension debugger.** When claude-in-chrome
   attaches its own `chrome.debugger` session to the same tab, our
   extension's `Input.dispatchMouseEvent` calls go through but the
   page never sees the events — the visit loop fires hundreds of
   clicks and `HC_Net.totalOk` stays at 0. `HC_DbgClick.probe()` still
   returns ok because `ensureAttached()` is a no-op once attached. The
   only workarounds are: don't use any `computer.*` tool while the
   extension's loop is running, OR run the loop without the MCP
   attached (which is the production path anyway).

2. **Hub probe grid is coarse.** The 24-point grid covers most hub
   layouts but not all. A friend with farms further than y=520 or
   spread to x>850 won't get hit. Future: read the hub farm-icon
   positions out of the GLSpy texture fingerprint or the parent-page
   DOM if the hub uses HTML markers.

3. **Backpack-full detection is a proxy.** We infer it from
   `2 consecutive empty advances`. A real signal would be parsing the
   resource counters (`14/120` style top-bar widget) out of the
   `/proto.html` farm-load response. The decoder in #06 already has
   the records; we just don't read the inventory section yet.

4. **Логи from iframe live in the iframe console context.** The panel
   has a copyable log box (`user-select` allowed), and `log()` mirrors
   to `window.parent.postMessage({type:'HC_LOG', line})` for any
   top-frame listener. There is no top-frame listener installed yet —
   future work if we want logs in the main DevTools console without a
   context switch.

## Verified end-to-end (2026-04-30)

Single sweep on `наина haiha` farm:

- 126 click attempts via `HC_DbgClick`.
- 102 net `0x80 OK` responses gained.
- Resource bars 14/120, 12/115 → 25/120, 24/115 (collected 11 + 12 = 23
  visible items).
- Game popped the "nothing more to do here" dialog with Далее button.
- `HC_DbgClick` at canvas (200, 660) cleanly advanced to `Марина Д.`
  farm; `lastFarmObjects().found` flipped to true on the new layout.

Bridge fragility was reproduced separately: after the MCP screenshot
tool was used, all subsequent `HC_DbgClick` calls timed out for the
remainder of the session, even though `probe()` reported ok.
