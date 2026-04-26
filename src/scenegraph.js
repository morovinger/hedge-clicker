// ── PIXI scene-graph access ──
// Discovers the PIXI Application in the iframe and provides a tree walker
// for finding sprites by texture name, parent name, or custom predicate.
// See doc/02-pixi-scenegraph-pivot.md.

if (window.HC_Scene) {
  console.log('[HC] Scene already installed — reusing.');
} else {
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
      'app', 'game', 'pixiApp', '_app',
    ];
    for (const k of knownGlobals) {
      const v = window[k];
      if (v && (v.stage || v.scene)) {
        pixiApp = v;
        return capture();
      }
    }

    // 2. Walk window properties for any object with .stage and .renderer
    try {
      for (const k of Object.keys(window)) {
        if (k.startsWith('__hc')) continue; // skip our own
        let v;
        try { v = window[k]; } catch (e) { continue; }
        if (v && typeof v === 'object' && v.stage && v.renderer) {
          pixiApp = v;
          return capture();
        }
      }
    } catch (e) {}

    // 3. PIXI namespace exposed?
    if (window.PIXI) {
      // Some apps store the renderer as PIXI.autoDetectRenderer's last result,
      // or instances are tracked. Best-effort:
      const PIXI = window.PIXI;
      if (PIXI._app || PIXI.app) {
        pixiApp = PIXI._app || PIXI.app;
        return capture();
      }
    }

    // 4. Nothing found yet.
    return null;
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
  };
})();
}
