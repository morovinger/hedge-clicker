  Main Issues / Refactor Targets

  1. Parsed sweep is enabled too eagerly.
     src/visit.js:54 defaults sweepMode to auto, which prefers parsed-object clicking if any projected coords exist. But src/overlay.js:22 uses an uncalibrated default transform. That can produce plausible but wrong     
  canvas coords. I’d either default to grid, or add an explicit overlay.calibrated flag and only allow parsed mode after calibration.
  2. Manual “Enter Hub Farm” likely fails while stopped.
     src/visit.js:221 aborts probes when running === false, but the UI button calls it directly while the loop may be stopped. Refactor enterFarmFromHub({ requireRunning }), with loop calls requiring running and manual  
  UI/debug calls not requiring it.
  3. Farm-state naming is misleading.
     src/visit.js:206 lastFarmSeq() really means “last large decoded farm-load response in the network ring,” not “currently inside a farm.” This can mislead bootstrap/recovery if an old farm-load remains in the ring.   
  I’d move this into HC_Net as lastFarmLoad() / awaitNextFarmLoad({ afterSeq }).
  4. Click health is too asynchronous.
     src/visit.js:84 fires debugger clicks without awaiting them; failures are logged later. For debugging, I’d add clickCanvas(cx, cy, { awaitResult }) and use awaited clicks for advance/hub probes, while keeping fire- 
  and-spacing for bulk sweeps.
  5. Stats are slightly wrong.
     src/visit.js:270 increments stats.farms even when advance fails. That should probably increment only after advanced === true, or be renamed to advanceAttempts.
  6. Docs are inconsistent with the current implementation.
     README.md, CLAUDE.md, chrome-ext/README.md, build.js headers, and parts of doc/07-autonomous-visit-loop.md still describe the removed HSL/vision/config/clicker pipeline. Also 07 still references 0x80 OK, while      
  doc/05 and src/network.js:54 use the corrected 0x50 / P\0 envelope.
