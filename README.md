# Hedgehog Clicker

Vision-based auto-clicker for the VK game **Ёжики** (Hedgehogs).

Hooks into the game's WebGL renderer to capture frame pixels mid-draw, detects resource-ready badges by HSL color matching, and clicks them automatically.

## Quick Start

1. Open https://vk.com/ezhiky_game
2. Press **F12** → Console tab
3. Switch context from `top` to the `valley.redspell.ru` iframe
4. Paste the contents of `clicker.js` and press Enter

The **Hedgehog Vision** panel appears in the top-right corner.

## Controls

| Control | Action |
|---------|--------|
| **F2** | Toggle auto-collect on/off |
| **Scan Once** | Run one detection pass (debug) |
| **Calibrate** | Click canvas to read pixel HSL values |
| **Pick Target** | Set click position for Single mode |

### Modes

- **Smart** — Scans for badge colors, clicks only on detections
- **Grid** — Dense sweep across the entire farm (no vision)
- **Single** — Repeatedly clicks one spot

### Sliders

- **Scan interval** — Delay between scans (500ms–5s)
- **Click delay** — Delay between clicks on detected targets (50ms–1s)
- **Min cluster** — Minimum pixel hits to count as a badge (filters noise)
- **Scan detail** — Pixel step size (1 = every pixel, 6 = fast/coarse)

## Calibration Workflow

The color targets need tuning for your specific farm. To calibrate:

1. Click **Calibrate** in the panel
2. Click on a resource-ready badge on the canvas
3. Note the HSL values shown (e.g., `HSL(280,65%,45%)`)
4. Edit `src/config.js` — add or adjust target ranges
5. Run `node build.js` to rebuild `clicker.js`
6. Re-inject the updated script

## Project Structure

```
src/
  config.js    — Color targets & scan parameters
  capture.js   — WebGL frame capture (drawElements hook)
  vision.js    — HSL color detection + pixel clustering
  clicker.js   — Click simulation & auto-collect loops
  ui.js        — Draggable control panel
build.js       — Concatenates src/ into injectable clicker.js
clicker.js     — Built output (paste this into console)
```

## Build

```bash
node build.js
```

Concatenates all `src/` modules into a single `clicker.js` IIFE that can be pasted into the browser console.

## How It Works

The game uses PIXI.js with a WebGL renderer that has `preserveDrawingBuffer: false`, meaning normal `readPixels()` calls return black. The script hooks `gl.drawElements()` to intercept pixel data mid-render when the framebuffer still contains valid data.

Each scan pass:
1. Requests a fresh frame capture
2. Iterates pixels at configurable step size
3. Converts RGB to HSL and matches against target color ranges
4. Clusters nearby hits within a radius
5. Filters clusters below the minimum size threshold
6. Clicks the center of each surviving cluster

## License

MIT
