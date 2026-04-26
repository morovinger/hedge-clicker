// ── PIXI scene-graph access ──
// Discovers the PIXI Application in the iframe and provides a tree walker
// for finding sprites by texture name, parent name, or custom predicate.
// See doc/02-pixi-scenegraph-pivot.md.

if (window.HC_Scene) {
  console.log('[HC] Scene already installed — reusing.');
} else {

// ── Eager probe (option 3): catch the moment PIXI is assigned, wrap key
// constructors so we capture renderer/stage instances at birth. Runs at
// document_start, before game scripts.
(function installPixiTrap() {
  if (window.__hcPixiTrap) return;
  window.__hcPixiTrap = { renderers: [], stages: [], events: [] };
  const T = window.__hcPixiTrap;

  function wrapPixi(P) {
    if (!P || P.__hcWrapped) return;
    P.__hcWrapped = true;
    T.events.push({ t: Date.now(), e: 'pixi-detected', keys: Object.keys(P).length });

    const wrapCtor = (name) => {
      const Orig = P[name];
      if (typeof Orig !== 'function') return;
      function Wrapped(...args) {
        const inst = new Orig(...args);
        try {
          if (name === 'WebGLRenderer' || name === 'CanvasRenderer') T.renderers.push(inst);
          if (name === 'Stage') T.stages.push(inst);
          T.events.push({ t: Date.now(), e: 'ctor:' + name });
        } catch (e) {}
        return inst;
      }
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig);
      try { P[name] = Wrapped; } catch (e) {}
    };
    ['WebGLRenderer', 'CanvasRenderer', 'Stage'].forEach(wrapCtor);
  }

  if (window.PIXI) {
    wrapPixi(window.PIXI);
  } else {
    let _pixi;
    try {
      Object.defineProperty(window, 'PIXI', {
        configurable: true,
        get() { return _pixi; },
        set(v) { _pixi = v; try { wrapPixi(v); } catch (e) {} },
      });
    } catch (e) { T.events.push({ t: Date.now(), e: 'defineProperty-failed', err: String(e) }); }
  }
})();

window.HC_Scene = (function() {
  let pixiApp = null;
  let stage = null;
  let renderer = null;

  // --- Discovery strategies (try in order) ---

  function discover() {
    if (pixiApp) return pixiApp;

    // 1. PIXI Devtools convention: __PIXI_APP__ or __PIXI_DEVTOOLS_GLOBAL_HOOK__
    const knownGlobals = [
      '__PIXI_APP__', '__PIXI_RENDERER__', '__PIXI_STAGE__',
      'app', 'game', 'pixiApp', '_app', 'stage',
    ];
    for (const k of knownGlobals) {
      let v; try { v = window[k]; } catch (e) { continue; }
      if (v && (v.stage || v.scene)) { pixiApp = v; return capture(); }
      if (v && v.children && v.transform) { pixiApp = { stage: v, renderer: null }; return capture(); }
    }

    // 2. PIXI Devtools hook: __PIXI_DEVTOOLS_GLOBAL_HOOK__ collects registered apps.
    try {
      const h = window.__PIXI_DEVTOOLS_GLOBAL_HOOK__;
      if (h) {
        const apps = h.apps || (h.app ? [h.app] : null);
        if (apps && apps.length) { pixiApp = apps[0]; return capture(); }
        if (h.renderers && h.renderers.length && h.stages && h.stages.length) {
          pixiApp = { renderer: h.renderers[0], stage: h.stages[0] };
          return capture();
        }
      }
    } catch (e) {}

    // 3. Walk window properties for any object with .stage and .renderer
    try {
      for (const k of Object.keys(window)) {
        if (k.startsWith('__hc') || k.startsWith('HC_')) continue;
        let v; try { v = window[k]; } catch (e) { continue; }
        if (v && typeof v === 'object' && v.stage && v.renderer) {
          pixiApp = v; return capture();
        }
      }
    } catch (e) {}

    // 4. Canvas back-references — some PIXI apps store on the canvas element.
    try {
      const c = window.HC_Capture && window.HC_Capture.canvas;
      if (c) {
        for (const k of ['__pixi_app', '__pixiApp', '_pixiApp', 'pixiApp']) {
          if (c[k]) { pixiApp = c[k]; return capture(); }
        }
        // WebGL context back-ref?
        const gl = c._gl || (c.getContext && c.getContext('webgl'));
        if (gl) {
          for (const k of ['__pixi_renderer', 'renderer', '_renderer']) {
            if (gl[k]) { pixiApp = { renderer: gl[k], stage: gl[k].lastObjectRendered || null }; return capture(); }
          }
        }
      }
    } catch (e) {}

    // 5. PIXI namespace exposed?
    if (window.PIXI) {
      const PIXI = window.PIXI;
      if (PIXI._app || PIXI.app) {
        pixiApp = PIXI._app || PIXI.app; return capture();
      }
    }

    return null;
  }

  // Walk a known stage root from outside (used by eval probe).
  function attachStage(s) {
    if (!s) return false;
    pixiApp = pixiApp || { stage: s, renderer: null };
    stage = s;
    return true;
  }

  function capture() {
    if (!pixiApp) return null;
    stage = pixiApp.stage || pixiApp.scene || null;
    renderer = pixiApp.renderer || null;
    return pixiApp;
  }

  // --- Tree walking ---

  function* walk(node, depth = 0, maxDepth = 50) {
    if (!node || depth > maxDepth) return;
    yield { node, depth };
    const children = node.children;
    if (Array.isArray(children)) {
      for (const c of children) yield* walk(c, depth + 1, maxDepth);
    }
  }

  function describeNode(n) {
    const tex = n.texture;
    let texIds = null;
    if (tex && tex.textureCacheIds) texIds = tex.textureCacheIds.slice(0, 3);
    else if (tex && tex.baseTexture && tex.baseTexture.cacheId) texIds = [tex.baseTexture.cacheId];
    let worldPos = null;
    try {
      if (n.worldTransform) worldPos = [Math.round(n.worldTransform.tx), Math.round(n.worldTransform.ty)];
      else if (n.x !== undefined) worldPos = [Math.round(n.x), Math.round(n.y)];
    } catch (e) {}
    return {
      type: n.constructor && n.constructor.name,
      name: n.name || null,
      visible: n.visible !== false,
      worldVisible: n.worldVisible !== false,
      interactive: !!n.interactive,
      worldPos,
      texIds,
      childCount: (n.children && n.children.length) || 0,
      width: n.width !== undefined ? Math.round(n.width) : null,
      height: n.height !== undefined ? Math.round(n.height) : null,
    };
  }

  function summarize(maxNodes = 200) {
    discover();
    if (!stage) return { error: 'no PIXI stage found', tried: 'globals + .stage walk + PIXI namespace' };
    const nodes = [];
    let n = 0;
    for (const { node, depth } of walk(stage)) {
      if (n++ >= maxNodes) break;
      nodes.push({ depth, ...describeNode(node) });
    }
    return { nodeCount: n, sample: nodes };
  }

  // Find nodes whose texture id contains any of the given substrings.
  function findByTexture(...substrings) {
    discover();
    if (!stage) return [];
    const matches = [];
    for (const { node, depth } of walk(stage)) {
      const tex = node.texture;
      let ids = [];
      if (tex && tex.textureCacheIds) ids = tex.textureCacheIds;
      else if (tex && tex.baseTexture && tex.baseTexture.cacheId) ids = [tex.baseTexture.cacheId];
      for (const id of ids) {
        if (typeof id !== 'string') continue;
        if (substrings.some(s => id.toLowerCase().includes(s.toLowerCase()))) {
          matches.push({ depth, ...describeNode(node) });
          break;
        }
      }
    }
    return matches;
  }

  // Find unique texture ids across the tree (helps identify sprite assets).
  function listTextures(limit = 100) {
    discover();
    if (!stage) return [];
    const seen = new Set();
    for (const { node } of walk(stage)) {
      const tex = node.texture;
      if (tex && tex.textureCacheIds) tex.textureCacheIds.forEach(id => seen.add(id));
      else if (tex && tex.baseTexture && tex.baseTexture.cacheId) seen.add(tex.baseTexture.cacheId);
      if (seen.size > limit) break;
    }
    return Array.from(seen);
  }

  return {
    discover,
    isReady() { return !!stage; },
    getApp() { return pixiApp; },
    getStage() { return stage; },
    getRenderer() { return renderer; },
    summarize,
    findByTexture,
    listTextures,
    describeNode,
    attachStage,
    walk,
  };
})();
}
