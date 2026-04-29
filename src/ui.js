// ── UI Panel ──
// Visit-loop control surface. Smart-mode pixel detection was removed when
// HC_Capture stopped being a frame-capture hook (see doc/01-pixel-capture-attempt.md);
// HC_Visit now drives the game via grid sweeps + chrome.debugger trusted clicks.

window.HC_UI = (function() {
  const cap = window.HC_Capture;
  const visit = window.HC_Visit;
  const canvas = cap.canvas;

  const old = document.getElementById('hc-panel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'hc-panel';
  panel.innerHTML = `
    <style>
      #hc-panel{position:fixed;top:10px;right:10px;width:340px;background:rgba(18,18,18,.96);color:#eee;border-radius:12px;font-family:Arial,sans-serif;font-size:13px;z-index:999999;box-shadow:0 4px 24px rgba(0,0,0,.7);user-select:none;border:1px solid rgba(255,255,255,.08)}
      #hc-hdr{background:linear-gradient(135deg,#6a3093,#4a1068);padding:8px 12px;border-radius:12px 12px 0 0;cursor:move;display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-size:14px}
      #hc-body{padding:10px 12px}
      #hc-st{text-align:center;padding:6px;margin-bottom:8px;border-radius:6px;font-weight:bold}
      .hb{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;color:#fff;flex:1;text-align:center}.hb:hover{opacity:.85}
      .hbs{display:flex;gap:5px;margin-top:5px}
      .g{background:#2d7a3a}.r{background:#c0392b}.b{background:#2980b9}.p{background:#6a3093}.o{background:#e67e22}
      .sep{border-top:1px solid rgba(255,255,255,.06);margin:7px 0}
      #hc-stats{font-size:11px;color:#b388ff;margin-top:4px;line-height:1.4}
      #hc-diag{font-size:10px;color:#aaa;margin-top:4px;line-height:1.3}
      #hc-log{font-family:Consolas,monospace;font-size:10px;color:#9fd4ff;background:rgba(0,0,0,.4);border-radius:4px;padding:6px;margin-top:5px;height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
    </style>
    <div id="hc-hdr"><span>Hedgehog Vision</span><span id="hc-min" style="cursor:pointer;font-size:18px">-</span></div>
    <div id="hc-body">
      <div id="hc-st">STOPPED</div>
      <div class="hbs">
        <button class="hb g" id="hc-tog">START Visit (F2)</button>
      </div>
      <div class="hbs">
        <button class="hb o" id="hc-sweep" style="font-size:11px">Sweep Once</button>
        <button class="hb p" id="hc-hub" style="font-size:11px">Enter Hub Farm</button>
      </div>
      <div class="hbs">
        <button class="hb b" id="hc-pick-next" style="font-size:11px">Set Далее Btn</button>
        <button class="hb b" id="hc-pick-home" style="font-size:11px">Set Выйти Btn</button>
        <button class="hb b" id="hc-pick-popup" style="font-size:11px">Set Popup Далее</button>
      </div>
      <div class="hbs">
        <button class="hb b" id="hc-probe" style="font-size:11px">Probe DbgClick</button>
        <button class="hb b" id="hc-clear-log" style="font-size:11px">Clear Log</button>
      </div>
      <div class="sep"></div>
      <div id="hc-stats">Idle.</div>
      <div id="hc-diag">—</div>
      <div id="hc-log">no log yet — click START to begin</div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Drag ──
  let drag = 0, dx = 0, dy = 0;
  document.getElementById('hc-hdr').addEventListener('mousedown', e => {
    drag = 1; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop;
  });
  document.addEventListener('mousemove', e => {
    if (drag) { panel.style.left = (e.clientX - dx) + 'px'; panel.style.right = 'auto'; panel.style.top = (e.clientY - dy) + 'px'; }
  });
  document.addEventListener('mouseup', () => drag = 0);

  // ── Minimize ──
  const bodyEl = document.getElementById('hc-body');
  document.getElementById('hc-min').addEventListener('click', () => {
    const hidden = bodyEl.style.display === 'none';
    bodyEl.style.display = hidden ? 'block' : 'none';
    document.getElementById('hc-min').textContent = hidden ? '-' : '+';
  });

  // ── Buttons ──
  document.getElementById('hc-tog').addEventListener('click', () => {
    console.log('[HC_UI] START button clicked, visit.isRunning=' + visit.isRunning());
    visit.toggle();
    updateUI();
  });
  document.getElementById('hc-sweep').addEventListener('click', () => {
    console.log('[HC_UI] Sweep Once clicked');
    visit.sweepOnce(false).then(updateUI);
  });
  document.getElementById('hc-hub').addEventListener('click', () => {
    console.log('[HC_UI] Enter Hub Farm clicked');
    visit.enterFarmFromHub().then(ok => console.log('[HC_UI] hub entry result:', ok));
  });
  document.getElementById('hc-probe').addEventListener('click', () => {
    if (!window.HC_DbgClick) { console.warn('no HC_DbgClick'); return; }
    window.HC_DbgClick.probe().then(r => {
      console.log('[HC_UI] DbgClick probe:', r);
      const diag = document.getElementById('hc-diag');
      diag.textContent = 'Probe: ' + (r && r.resp ? ('ok=' + r.resp.ok + (r.resp.error ? ' err=' + r.resp.error : '')) : (r && r.timeout ? 'TIMEOUT' : JSON.stringify(r)));
    });
  });
  document.getElementById('hc-clear-log').addEventListener('click', () => {
    visit.clearLog();
    document.getElementById('hc-log').textContent = '';
  });

  // ── Calibrators: click-to-pick canvas coords for advance buttons ──
  function pickCoord(setter, label, btnId) {
    let armed = false;
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
      armed = true;
      btn.textContent = 'Click ' + label + '...';
      btn.className = 'hb o';
    });
    canvas.addEventListener('click', e => {
      if (!armed) return;
      const rect = canvas.getBoundingClientRect();
      const tx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
      const ty = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
      setter(tx, ty);
      armed = false;
      btn.textContent = label + '(' + tx + ',' + ty + ')';
      btn.className = 'hb b';
    }, true);
  }
  pickCoord((x, y) => visit.setNextBtn(x, y), 'Далее', 'hc-pick-next');
  pickCoord((x, y) => visit.setHomeBtn(x, y), 'Выйти', 'hc-pick-home');
  pickCoord((x, y) => visit.setPopupNextBtn(x, y), 'Popup', 'hc-pick-popup');

  // ── F2 hotkey ──
  document.addEventListener('keydown', e => {
    if (e.key === 'F2') { e.preventDefault(); visit.toggle(); updateUI(); }
  });

  function updateUI() {
    const st = document.getElementById('hc-st'), btn = document.getElementById('hc-tog');
    const r = visit.isRunning();
    const s = visit.getStats();
    const cc = visit.getClickCounters();
    if (r) {
      st.textContent = 'RUNNING'; st.style.background = 'rgba(106,48,147,.5)'; st.style.color = '#b388ff';
      btn.textContent = 'STOP Visit (F2)'; btn.className = 'hb r';
    } else {
      st.textContent = 'STOPPED'; st.style.background = 'rgba(192,57,43,.3)'; st.style.color = '#ff6b6b';
      btn.textContent = 'START Visit (F2)'; btn.className = 'hb g';
    }
    document.getElementById('hc-stats').textContent =
      'Passes: ' + s.passes + ' | Hits: ' + s.hits + ' | Attempts: ' + s.attempts +
      ' | Farms: ' + s.farms + (s.lastResult ? ' | Last: ' + s.lastResult : '');
    const dbg = window.HC_DbgClick;
    const net = window.HC_Net && window.HC_Net.getStats();
    document.getElementById('hc-diag').textContent =
      'DbgClick: ' + (dbg ? ('avail=' + dbg.isAvailable() + ' clicks=' + cc.clicks + ' fails=' + cc.fails) : 'MISSING') +
      ' | Net: ' + (net ? ('seen=' + net.totalSeen + ' ok=' + net.totalOk + ' err=' + net.totalErr) : 'MISSING');
    const logEl = document.getElementById('hc-log');
    const lines = visit.getLog();
    if (lines.length) {
      const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 5;
      logEl.textContent = lines.join('\n');
      if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
    }
  }

  setInterval(updateUI, 500);
  updateUI();
  return { updateUI };
})();
