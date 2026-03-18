// ── Configuration ──
// Color targets and scanning parameters.
// Edit targets here or use Calibrate in the UI to find HSL values.

window.HC_CFG = {
  targets: [
    // Purple/violet badges (resource ready indicators)
    // Calibrate on actual badges to refine these ranges!
    { name: 'purple', hMin: 260, hMax: 320, sMin: 30, sMax: 100, lMin: 25, lMax: 70 },
    // Gold badges — DISABLED by default (matches too much scenery).
    // Enable after calibrating on an actual gold badge.
    // { name: 'gold', hMin: 40, hMax: 50, sMin: 80, sMax: 100, lMin: 50, lMax: 70 },
  ],
  scanInterval: 2000,   // ms between scans in smart mode
  clickDelay: 300,       // ms between clicks
  minCluster: 15,        // min pixel hits to count as a badge (raised from 8)
  clusterRadius: 30,     // px radius for grouping hits
  skipTop: 70,           // skip UI bar at top
  skipBottom: 40,        // skip bottom bar
  scanStep: 3,           // pixel step (lower = more detail, slower)
};
