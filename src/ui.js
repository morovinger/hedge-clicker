// ── UI Panel ──

window.HC_UI = (function() {
  const cap = window.HC_Capture;
  const vis = window.HC_Vision;
  const cfg = window.HC_CFG;
  const clicker = window.HC_Clicker;
  const canvas = cap.canvas;

  const MODES = ['smart', 'grid', 'single'];
  const MODE_NAMES = { smart: 'Smart', grid: 'Grid', single: 'Single' };

  // Cleanup previous instance
  const old = document.getElementById('hc-panel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'hc-panel';
  panel.innerHTML = `
    <style>
      #hc-panel{position:fixed;top:10px;right:10px;width:280px;background:rgba(18,18,18,.96);color:#eee;border-radius:12px;font-family:Arial,sans-serif;font-size:13px;z-index:999999;box-shadow:0 4px 24px rgba(0,0,0,.7);user-select:none;border:1px solid rgba(255,255,255,.08)}
      #hc-hdr{background:linear-gradient(135deg,#6a3093,#4a1068);padding:8px 12px;border-radius:12px 12px 0 0;cursor:move;display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-size:14px}
      #hc-body{padding:10px 12px}
      #hc-st{text-align:center;padding:6px;margin-bottom:8px;border-radius:6px;font-weight:bold}
      .hr{display:flex;align-items:center;margin-bottom:5px;gap:6px}.hr label{flex:0 0 78px;font-size:11px;color:#aaa}.hr input[type=range]{flex:1}.hr .v{flex:0 0 38px;text-align:right;font-size:11px;color:#ccc}
      .hb{padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;color:#fff;flex:1;text-align:center}.hb:hover{opacity:.85}
      .hbs{display:flex;gap:5px;margin-top:5px}
      .g{background:#2d7a3a}.r{background:#c0392b}.b{background:#2980b9}.p{background:#6a3093}.o{background:#e67e22}
      .sep{border-top:1px solid rgba(255,255,255,.06);margin:7px 0}
      #hc-det{font-size:11px;color:#b388ff;margin-top:4px;max-height:60px;overflow-y:auto}
      #hc-stats{font-size:11px;color:#888;margin-top:3px}
      #hc-cal-out{font-size:10px;color:#f1c40f;margin-top:2px;min-height:13px}
      #hc-info{font-size:10px;color:#555;margin-top:5px;line-height:1.3}
    </style>
    <div id="hc-hdr"><span>Hedgehog Vision</span><span id="hc-min" style="cursor:pointer;font-size:18px">-</span></div>
    <div id="hc-body">
      <div id="hc-st">STOPPED</div>
      <div class="hbs">
        <button class="hb g" id="hc-tog">START (F2)</button>
        <button class="hb p" id="hc-mode">Smart</button>
      </div>
      <div class="sep"></div>
      <div class="hr"><label>Scan interval</label><input type="range" id="hc-si" min="500" max="5000" value="${cfg.scanInterval}" step="100"><span class="v" id="hc-si-v">${cfg.scanInterval/1000}s</span></div>
      <div class="hr"><label>Click delay</label><input type="range" id="hc-cd" min="50" max="1000" value="${cfg.clickDelay}" step="50"><span class="v" id="hc-cd-v">${cfg.clickDelay}ms</span></div>
      <div class="hr"><label>Min cluster</label><input type="range" id="hc-mc" min="2" max="60" value="${cfg.minCluster}" step="1"><span class="v" id="hc-mc-v">${cfg.minCluster}</span></div>
      <div class="hr"><label>Scan detail</label><input type="range" id="hc-ss" min="1" max="6" value="${cfg.scanStep}" step="1"><span class="v" id="hc-ss-v">${cfg.scanStep}</span></div>
      <div class="sep"></div>
      <div class="hbs">
        <button class="hb o" id="hc-scan1" style="font-size:11px">Scan Once</button>
        <button class="hb b" id="hc-cal" style="font-size:11px">Calibrate</button>
        <button class="hb b" id="hc-pick" style="font-size:11px">Pick Target</button>
      </div>
      <div id="hc-cal-out"></div>
      <div id="hc-det">Detected: -</div>
      <div id="hc-stats">Clicks: 0 | Scans: 0</div>
      <div id="hc-info">
        <b>Smart</b>: Detects badges via pixel colors, clicks them.<br>
        <b>Grid</b>: Dense sweep. <b>Single</b>: One spot.<br>
        Use <b>Calibrate</b> to check pixel colors.
      </div>
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

  // ── Sliders ──
  document.getElementById('hc-si').addEventListener('input', function() { cfg.scanInterval = +this.value; document.getElementById('hc-si-v').textContent = (cfg.scanInterval / 1000) + 's'; });
  document.getElementById('hc-cd').addEventListener('input', function() { cfg.clickDelay = +this.value; document.getElementById('hc-cd-v').textContent = cfg.clickDelay + 'ms'; });
  document.getElementById('hc-mc').addEventListener('input', function() { cfg.minCluster = +this.value; document.getElementById('hc-mc-v').textContent = cfg.minCluster; });
  document.getElementById('hc-ss').addEventListener('input', function() { cfg.scanStep = +this.value; document.getElementById('hc-ss-v').textContent = cfg.scanStep; });

  // ── Buttons ──
  document.getElementById('hc-tog').addEventListener('click', () => { clicker.toggle(); updateUI(); });
  document.getElementById('hc-mode').addEventListener('click', () => {
    const cur = clicker.getMode();
    const next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
    clicker.setMode(next);
    document.getElementById('hc-mode').textContent = MODE_NAMES[next];
    updateUI();
  });

  // ── Scan Once ──
  document.getElementById('hc-scan1').addEventListener('click', () => clicker.scanOnce());

  // ── Calibrate ──
  let cal = false;
  document.getElementById('hc-cal').addEventListener('click', () => {
    cal = !cal;
    document.getElementById('hc-cal').textContent = cal ? 'Click canvas...' : 'Calibrate';
    document.getElementById('hc-cal').className = cal ? 'hb o' : 'hb b';
    if (cal) cap.requestFrame();
  });
  canvas.addEventListener('click', e => {
    if (!cal) return;
    setTimeout(() => {
      const rect = canvas.getBoundingClientRect();
      const cx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
      const cy = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
      const px = vis.samplePixel(cap.getFrame(), cx, cy);
      if (px) {
        const msg = `(${cx},${cy}) RGB(${px.r},${px.g},${px.b}) HSL(${px.h},${px.s}%,${px.l}%)`;
        console.log('[Calibrate]', msg);
        document.getElementById('hc-cal-out').textContent = msg;
      }
    }, 100);
    cal = false;
    document.getElementById('hc-cal').textContent = 'Calibrate';
    document.getElementById('hc-cal').className = 'hb b';
  }, true);

  // ── Pick Target ──
  let picking = false;
  document.getElementById('hc-pick').addEventListener('click', () => {
    picking = true;
    document.getElementById('hc-pick').textContent = 'Click...';
    document.getElementById('hc-pick').className = 'hb o';
  });
  canvas.addEventListener('click', e => {
    if (!picking) return;
    const rect = canvas.getBoundingClientRect();
    const tx = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
    const ty = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
    clicker.setTarget(tx, ty);
    picking = false;
    document.getElementById('hc-pick').textContent = '(' + tx + ',' + ty + ')';
    document.getElementById('hc-pick').className = 'hb b';
  }, true);

  // ── F2 hotkey ──
  document.addEventListener('keydown', e => {
    if (e.key === 'F2') { e.preventDefault(); clicker.toggle(); updateUI(); }
  });

  function updateUI() {
    const st = document.getElementById('hc-st'), btn = document.getElementById('hc-tog');
    const r = clicker.isRunning(), m = MODE_NAMES[clicker.getMode()];
    if (r) {
      st.textContent = 'RUNNING \u2014 ' + m; st.style.background = 'rgba(106,48,147,.5)'; st.style.color = '#b388ff';
      btn.textContent = 'STOP (F2)'; btn.className = 'hb r';
    } else {
      st.textContent = 'STOPPED'; st.style.background = 'rgba(192,57,43,.3)'; st.style.color = '#ff6b6b';
      btn.textContent = 'START (F2)'; btn.className = 'hb g';
    }
  }

  function updateInfo(stats) {
    document.getElementById('hc-stats').textContent = 'Clicks: ' + stats.clicks + ' | Scans: ' + stats.scans + ' | Found: ' + stats.found;
    if (stats.mode === 'smart' && stats.detected.length) {
      document.getElementById('hc-det').textContent = 'Last: ' + stats.detected.map(d => d.name + '(' + d.x + ',' + d.y + ')').join(' ');
    }
  }

  function showDetected(detected) {
    document.getElementById('hc-det').textContent =
      'Found: ' + detected.length + (detected.length
        ? ' \u2014 ' + detected.map(d => d.name + '(' + d.x + ',' + d.y + ')[' + d.count + 'px]').join(', ')
        : '');
  }

  updateUI();
  return { updateUI, updateInfo, showDetected };
})();
