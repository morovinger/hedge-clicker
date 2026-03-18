// Build script: concatenates src modules into a single injectable clicker.js
// Run: node build.js

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'clicker.js');

// Load order matters: config → capture → vision → clicker → ui
const modules = ['config.js', 'capture.js', 'vision.js', 'clicker.js', 'ui.js'];

const header = `// Hedgehog Smart Collector (Ёжики) - Vision-based Auto-Clicker
// Built: ${new Date().toISOString().slice(0, 10)}
//
// HOW TO USE:
// 1. Open the game at https://vk.com/ezhiky_game
// 2. Press F12 → Console tab
// 3. Switch context from "top" to "valley.redspell.ru" iframe
// 4. Paste this script and press Enter
//
// CONTROLS: F2 = toggle on/off
`;

const footer = `
// ── Init ──
console.log('[HC] Hedgehog Vision loaded! Canvas:', HC_Capture.canvas.width + 'x' + HC_Capture.canvas.height);
console.log('[HC] Targets:', HC_CFG.targets.map(t => t.name).join(', ') || 'NONE — use Calibrate to set up');
console.log('[HC] Press F2 or START to begin.');
`;

let output = header + '\n(function() {\n  "use strict";\n\n';
output += '  // Cleanup\n  const old = document.getElementById("hc-panel");\n  if (old) old.remove();\n  if (window.__hcTimer) clearTimeout(window.__hcTimer);\n\n';
output += '  const canvas = document.querySelector("canvas");\n  if (!canvas) { console.error("[HC] No canvas!"); return; }\n\n';

for (const file of modules) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  output += `  // ═══ ${file} ═══\n`;
  // Indent each line by 2 spaces
  output += src.split('\n').map(line => '  ' + line).join('\n');
  output += '\n\n';
}

output += footer.split('\n').map(line => '  ' + line).join('\n');
output += '\n})();\n';

fs.writeFileSync(OUT, output, 'utf8');
console.log(`Built ${OUT} (${(output.length / 1024).toFixed(1)} KB)`);
