// ── Vision: Color Detection + Clustering ──

window.HC_Vision = (function() {
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  // Scan frame pixels for target colors, return clustered detections
  function scanFrame(frameData, cfg) {
    if (!frameData) return [];
    const { data, width: w, height: h } = frameData;
    const step = cfg.scanStep;
    const hits = [];

    for (let y = cfg.skipTop; y < h - cfg.skipBottom; y += step) {
      for (let x = 10; x < w - 10; x += step) {
        const fy = h - 1 - y; // WebGL Y-flip
        const i = (fy * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r === 0 && g === 0 && b === 0) continue; // skip black
        const [hue, sat, lit] = rgbToHsl(r, g, b);

        for (const t of cfg.targets) {
          if (hue >= t.hMin && hue <= t.hMax &&
              sat >= t.sMin && sat <= t.sMax &&
              lit >= t.lMin && lit <= t.lMax) {
            hits.push({ x, y, name: t.name });
            break;
          }
        }
      }
    }

    // Cluster nearby hits
    const clusters = [];
    const used = new Set();
    const r2 = cfg.clusterRadius * cfg.clusterRadius;

    for (let i = 0; i < hits.length; i++) {
      if (used.has(i)) continue;
      let sx = hits[i].x, sy = hits[i].y, cnt = 1;
      used.add(i);
      for (let j = i + 1; j < hits.length; j++) {
        if (used.has(j)) continue;
        const dx = hits[j].x - hits[i].x, dy = hits[j].y - hits[i].y;
        if (dx * dx + dy * dy < r2) {
          sx += hits[j].x; sy += hits[j].y; cnt++;
          used.add(j);
        }
      }
      if (cnt >= cfg.minCluster) {
        clusters.push({
          x: Math.round(sx / cnt),
          y: Math.round(sy / cnt),
          count: cnt,
          name: hits[i].name
        });
      }
    }

    return clusters;
  }

  // Read pixel color at canvas coords from captured frame
  function samplePixel(frameData, cx, cy) {
    if (!frameData) return null;
    const { data, width: w, height: h } = frameData;
    const fy = h - 1 - cy;
    const i = (fy * w + cx) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const hsl = rgbToHsl(r, g, b);
    return { r, g, b, h: hsl[0], s: hsl[1], l: hsl[2] };
  }

  return { rgbToHsl, scanFrame, samplePixel };
})();
