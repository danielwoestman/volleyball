// Scoreboard broadcast server — single file, zero dependencies.
//
//   GET  /            -> viewer page (shows the latest photo, polls every 2s)
//   GET  /boss        -> capture page (camera, zoom, snaps + uploads every 5s)
//   POST /upload      -> receives a JPEG body, keeps it as "the latest photo"
//   GET  /latest.jpg  -> serves the latest photo bytes
//   GET  /status      -> { hasImage, lastUpdate } for the viewer's polling
//
// The latest image lives in memory. That's fine for a single long-running
// process (e.g. Railway): the image is replaced every 5s, so a restart costs
// at most one frame.
//
// Run:  node server.js   (listens on PORT, default 3000)

const http = require("http");

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB ceiling per frame

let latestImage = null; // Buffer
let lastUpdate = 0; // epoch ms
let captureIntervalMs = 5000; // cadence the capture page reports, for staleness

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Scoreboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #000;
    color: #e8eaf0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  #shot {
    max-width: 100vw;
    max-height: 100vh;
    object-fit: contain;
    display: none;
  }
  #waiting { text-align: center; padding: 24px; }
  #waiting .spinner {
    width: 38px; height: 38px; margin: 0 auto 16px;
    border: 3px solid #1d2230; border-top-color: #2f7bff;
    border-radius: 50%; animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #waiting h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
  #waiting p { color: #8b93a7; font-size: 14px; margin: 0; }
  .live {
    position: fixed; top: 14px; right: 16px;
    display: flex; align-items: center; gap: 7px;
    background: rgba(0,0,0,.5); padding: 6px 12px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .04em;
    opacity: 0; transition: opacity .3s;
  }
  .live.on { opacity: 1; }
  .live .dot { width: 9px; height: 9px; border-radius: 50%; background: #ff3b30; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .stamp {
    position: fixed; bottom: 14px; left: 16px;
    background: rgba(0,0,0,.5); padding: 6px 12px; border-radius: 999px;
    font-size: 12px; font-weight: 600; color: #c7ccda;
    font-variant-numeric: tabular-nums;
    opacity: 0; transition: opacity .3s;
  }
  .stamp.on { opacity: 1; }
</style>
</head>
<body>
  <div id="waiting">
    <div class="spinner"></div>
    <h1>Waiting for the scoreboard…</h1>
    <p>The broadcast will appear here automatically.</p>
  </div>
  <img id="shot" alt="Scoreboard" />
  <div class="live" id="live"><span class="dot"></span>LIVE</div>
  <div class="stamp" id="stamp"></div>
<script>
  const POLL_MS = 2000;
  // "LIVE" stays on as long as frames keep arriving on the capture page's
  // cadence; allow a couple of missed frames (plus slack) before it drops.
  const STALE_FLOOR_MS = 8000;
  function staleMs(intervalMs) { return Math.max(STALE_FLOOR_MS, (intervalMs || 5000) * 2.5); }
  const img = document.getElementById("shot");
  const waiting = document.getElementById("waiting");
  const live = document.getElementById("live");
  const stamp = document.getElementById("stamp");
  let lastShown = 0;
  let lastUpdateMs = 0; // time of the latest photo, for the "x ago" counter
  function agoText(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "Updated " + s + " second" + (s === 1 ? "" : "s") + " ago";
    const m = Math.floor(s / 60), r = s % 60;
    return "Updated " + m + " min " + r + " sec ago";
  }
  // Tick the relative time once a second so it counts up between frames.
  function tick() {
    if (lastUpdateMs) stamp.textContent = agoText(lastUpdateMs);
  }
  async function poll() {
    try {
      const res = await fetch("/status", { cache: "no-store" });
      const { hasImage, lastUpdate, intervalMs } = await res.json();
      if (hasImage && lastUpdate !== lastShown) {
        const next = new Image();
        next.onload = () => {
          img.src = next.src;
          img.style.display = "block";
          waiting.style.display = "none";
        };
        next.src = "/latest.jpg?t=" + lastUpdate;
        lastShown = lastUpdate;
      }
      if (hasImage) {
        lastUpdateMs = lastUpdate;
        tick();
        stamp.classList.add("on");
      } else {
        stamp.classList.remove("on");
      }
      const fresh = hasImage && Date.now() - lastUpdate < staleMs(intervalMs);
      live.classList.toggle("on", fresh);
    } catch {
      live.classList.remove("on");
    }
  }
  poll();
  setInterval(poll, POLL_MS);
  setInterval(tick, 1000);
</script>
</body>
</html>`;

const BOSS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Scoreboard — Capture</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0b0d12;
    color: #e8eaf0;
    min-height: 100%;
    padding: env(safe-area-inset-top) 12px env(safe-area-inset-bottom);
    /* keep the page from rubber-banding so two-finger pinch zooms the camera */
    overscroll-behavior: none;
  }
  .app {
    max-width: 920px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  header { text-align: center; }
  h1 { font-size: 16px; font-weight: 600; letter-spacing: .02em; margin: 8px 0 2px; }
  .sub { color: #8b93a7; font-size: 12px; margin: 0 0 10px; }
  .layout {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .stage {
    position: relative;
    width: 100%;
    max-width: 340px;     /* smaller preview so the controls always fit */
    aspect-ratio: 4 / 3;
    background: #000;
    border-radius: 14px;
    overflow: hidden;     /* crops the CSS-zoomed (digital) preview */
    border: 1px solid #1d2230;
    flex: none;
    touch-action: none;   /* let us own pinch gestures on the preview */
  }
  video { width: 100%; height: 100%; object-fit: cover; display: block; transform-origin: center center; }
  .badge {
    position: absolute; top: 10px; left: 10px;
    display: flex; align-items: center; gap: 6px;
    background: rgba(0,0,0,.55); padding: 5px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
  }
  .zoomtag {
    position: absolute; top: 10px; right: 10px;
    background: rgba(0,0,0,.55); padding: 5px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #555; }
  .dot.live { background: #ff3b30; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  /* Perspective-correction overlay: outline polygon + four corner handles. */
  #warpSvg { position: absolute; inset: 0; width: 100%; height: 100%; display: none; pointer-events: none; }
  #warpSvg.on { display: block; }
  #warpSvg polygon { fill: rgba(47,123,255,.12); stroke: #2f7bff; stroke-width: 2; }
  .handle {
    position: absolute; width: 30px; height: 30px; margin: -15px 0 0 -15px;
    border-radius: 50%; border: 2px solid #fff; background: rgba(47,123,255,.5);
    display: none; touch-action: none; z-index: 3;
  }
  .handle.on { display: block; }
  .panel { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 12px; }
  .zoom { display: flex; flex-direction: column; gap: 6px; }
  .zoom .row { display: flex; justify-content: space-between; align-items: baseline; }
  .zoom .k { color: #8b93a7; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .zoom .v { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
  input[type=range] { width: 100%; accent-color: #2f7bff; height: 28px; }
  select {
    width: 100%; appearance: none; -webkit-appearance: none;
    background: #11141c; color: #e8eaf0; border: 1px solid #1d2230;
    border-radius: 10px; padding: 10px 12px; font-size: 14px; font-weight: 600;
  }
  .sent {
    width: 100%; border-radius: 10px; border: 1px solid #1d2230;
    background: #000; display: none; image-rendering: auto;
  }
  .sent.on { display: block; }
  .controls { display: flex; flex-direction: column; gap: 10px; }
  button {
    appearance: none; border: 0; border-radius: 12px; padding: 14px;
    font-size: 16px; font-weight: 600; cursor: pointer; width: 100%;
  }
  .start { background: #2f7bff; color: #fff; }
  .stop { background: #2a2f3d; color: #e8eaf0; }
  button:disabled { opacity: .4; cursor: default; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .stat { background: #11141c; border: 1px solid #1d2230; border-radius: 12px; padding: 10px 12px; }
  .stat .k { color: #8b93a7; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .stat .v { font-size: 18px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .err { color: #ff6b60; font-size: 13px; margin-top: 10px; text-align: center; max-width: 340px; }
  .hint { color: #5d6477; font-size: 12px; margin-top: 12px; text-align: center; max-width: 340px; line-height: 1.5; }

  /* Landscape: put the preview and controls side by side and drive the preview
     off the viewport height so everything is visible without scrolling. */
  @media (orientation: landscape) {
    .layout { flex-direction: row; align-items: flex-start; justify-content: center; }
    .stage { width: auto; height: min(64vh, 300px); aspect-ratio: 4 / 3; max-width: none; }
    .panel { max-width: 320px; }
    .err, .hint { max-width: 660px; }
  }
</style>
</head>
<body>
 <div class="app">
  <header>
    <h1>Scoreboard Capture</h1>
    <div class="sub">Point the camera at the scoreboard. A photo is sent every 5&nbsp;seconds.</div>
  </header>
  <div class="layout">
    <div class="stage" id="stage">
      <video id="preview" playsinline muted autoplay></video>
      <svg id="warpSvg" preserveAspectRatio="none" viewBox="0 0 100 100"><polygon id="warpPoly" points="" /></svg>
      <div class="handle" id="h0"></div>
      <div class="handle" id="h1"></div>
      <div class="handle" id="h2"></div>
      <div class="handle" id="h3"></div>
      <div class="badge"><span class="dot" id="dot"></span><span id="badgeText">Idle</span></div>
      <div class="zoomtag" id="zoomTag">1.0×</div>
    </div>
    <div class="panel">
      <div class="zoom">
        <div class="row"><span class="k">Camera</span></div>
        <select id="camSel"><option value="">Default (rear)</option><option value="front">Front (selfie)</option></select>
      </div>
      <div class="zoom">
        <div class="row"><span class="k">Zoom</span><span class="v" id="zoomVal">1.0×</span></div>
        <input type="range" id="zoom" min="1" max="5" step="0.1" value="1" />
      </div>
      <div class="zoom">
        <div class="row"><span class="k">Straighten corners</span></div>
        <div class="controls">
          <button class="stop" id="warpBtn">Adjust corners</button>
          <button class="stop" id="warpReset" disabled>Reset corners</button>
        </div>
      </div>
      <div class="zoom">
        <div class="row"><span class="k">Resolution</span></div>
        <select id="resSel">
          <option value="480">480px</option>
          <option value="720">720px</option>
          <option value="960" selected>960px</option>
          <option value="1280">1280px</option>
          <option value="0">Full camera</option>
        </select>
      </div>
      <div class="zoom">
        <div class="row"><span class="k">Quality</span></div>
        <select id="qualSel">
          <option value="0.3">Low — smallest</option>
          <option value="0.5">Medium</option>
          <option value="0.7" selected>High</option>
          <option value="0.85">Very high</option>
          <option value="0.95">Max — largest</option>
        </select>
      </div>
      <div class="zoom">
        <div class="row"><span class="k">Sent to viewers</span><span class="v" id="resInfo">—</span></div>
        <img id="sent" class="sent" alt="Last sent frame" />
      </div>
      <div class="zoom">
        <div class="row"><span class="k">Photo every</span></div>
        <select id="intervalSel">
          <option value="5" selected>5 seconds</option>
          <option value="10">10 seconds</option>
          <option value="15">15 seconds</option>
        </select>
      </div>
      <div class="controls">
        <button class="start" id="startBtn">Start broadcasting</button>
        <button class="stop" id="stopBtn" disabled>Stop</button>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Photos sent</div><div class="v" id="count">0</div></div>
        <div class="stat"><div class="k">Last sent</div><div class="v" id="last">—</div></div>
      </div>
    </div>
  </div>
  <div class="err" id="err"></div>
  <div class="hint">Keep this page open and the screen on. On iPhone, tap “Start” and allow camera access. Pinch or use the slider to zoom; drag the preview with one finger to choose what's in frame. Tap “Adjust corners” to drag the four corners onto the scoreboard — the photo is straightened to a rectangle, so an angled phone still sends a square-on view. The “Sent to viewers” image shows exactly what is broadcast. The screen is kept awake automatically while broadcasting.</div>
 </div>
<script>
  const MAX_DIM = 4096;       // hard ceiling on the encoded frame's longest side
  let intervalMs = 5000;      // capture cadence; adjustable on the fly
  let maxWidth = 960;         // single downsize target (px); 0 = full camera
  let jpegQuality = 0.7;      // JPEG quality; adjustable
  const video = document.getElementById("preview");
  const camSel = document.getElementById("camSel");
  const resSel = document.getElementById("resSel");
  const sentImg = document.getElementById("sent");
  const qualSel = document.getElementById("qualSel");
  const resInfo = document.getElementById("resInfo");
  const intervalSel = document.getElementById("intervalSel");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const dot = document.getElementById("dot");
  const badgeText = document.getElementById("badgeText");
  const countEl = document.getElementById("count");
  const lastEl = document.getElementById("last");
  const errEl = document.getElementById("err");
  const stage = document.getElementById("stage");
  const zoomSlider = document.getElementById("zoom");
  const zoomVal = document.getElementById("zoomVal");
  const zoomTag = document.getElementById("zoomTag");
  let stream = null, timer = null, count = 0, sending = false, wakeLock = null;
  let track = null;            // active video track
  let nativeZoom = null;       // kept null: zoom is always digital so pan works
  let zoom = 1;                // current digital zoom factor (×)
  let panX = 0, panY = 0;      // digital-zoom pan, normalized -1..1 (0 = centre)
  let deviceId = "";           // chosen camera; "" = let the browser pick rear
  const canvas = document.createElement("canvas");
  // Perspective correction: four corner points in normalized 0..1 stage coords,
  // order TL, TR, BR, BL. Default = full frame (identity, no warp).
  let warpMode = false;
  let corners = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  const handleEls = [0,1,2,3].map((i) => document.getElementById("h" + i));
  const warpSvg = document.getElementById("warpSvg");
  const warpPoly = document.getElementById("warpPoly");
  const warpBtn = document.getElementById("warpBtn");
  const warpReset = document.getElementById("warpReset");
  function setErr(msg) { errEl.textContent = msg || ""; }

  function cornersAreDefault() {
    const d = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    return corners.every((c, i) => Math.abs(c.x - d[i].x) < 1e-4 && Math.abs(c.y - d[i].y) < 1e-4);
  }
  // Position the handle elements and outline over the stage from corners.
  function drawWarpOverlay() {
    const rect = stage.getBoundingClientRect();
    corners.forEach((c, i) => {
      handleEls[i].style.left = (c.x * rect.width) + "px";
      handleEls[i].style.top = (c.y * rect.height) + "px";
    });
    warpPoly.setAttribute("points", corners.map((c) => (c.x * 100) + "," + (c.y * 100)).join(" "));
    warpReset.disabled = cornersAreDefault();
  }
  function showWarpUI(on) {
    warpSvg.classList.toggle("on", on);
    handleEls.forEach((h) => h.classList.toggle("on", on));
    warpBtn.textContent = on ? "Done" : "Adjust corners";
    warpBtn.classList.toggle("start", on);
    warpBtn.classList.toggle("stop", !on);
    if (on) drawWarpOverlay();
  }

  // List the cameras so the user can pick a specific rear lens (e.g. the
  // ultra-wide 0.5×) or the front camera. Labels need an active stream/
  // permission to be populated, so this is called again after start().
  async function refreshCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices;
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const cams = devices.filter((d) => d.kind === "videoinput");
    if (!cams.length) return;
    const front = /front|user|face/i;
    const prev = camSel.value;
    // Rebuild: the two fixed facingMode options, then each specific rear lens.
    camSel.innerHTML =
      '<option value="">Default (rear)</option><option value="front">Front (selfie)</option>';
    cams.forEach((c, i) => {
      if (front.test(c.label)) return; // front cameras are covered by the fixed option
      const opt = document.createElement("option");
      opt.value = c.deviceId;
      opt.textContent = c.label || ("Camera " + (i + 1));
      camSel.appendChild(opt);
    });
    if ([...camSel.options].some((o) => o.value === prev)) camSel.value = prev;
  }

  function fmtZoom(z) { return z.toFixed(1) + "×"; }
  function showZoom() {
    zoomVal.textContent = fmtZoom(zoom);
    zoomTag.textContent = fmtZoom(zoom);
  }
  // How far the digital-zoom view can pan from centre, as a fraction of the
  // frame, given the current zoom (0 when not zoomed in). At zoom Z the visible
  // window is 1/Z of the frame, leaving (1 - 1/Z) of slack, split both sides.
  function panRange() {
    if (nativeZoom || zoom <= 1) return 0;
    return (1 - 1 / zoom) / 2;
  }
  function clampPan() {
    const r = panRange();
    panX = Math.max(-r, Math.min(r, panX));
    panY = Math.max(-r, Math.min(r, panY));
    if (r === 0) panX = panY = 0;
  }
  // Apply the current zoom + pan. Prefer the camera's real zoom; otherwise fall
  // back to digital zoom — scale/translate the preview with CSS (the stage clips
  // it) and crop the captured frame so the upload matches what's shown.
  function applyZoom() {
    clampPan();
    // Always digital zoom: scale + translate the preview, and crop the captured
    // frame to match. This keeps panning available on every device (optical zoom
    // crops on the sensor centre, where there's nothing to pan to).
    const tx = -panX * 100, ty = -panY * 100;
    video.style.transform = "scale(" + zoom + ") translate(" + tx + "%, " + ty + "%)";
    showZoom();
  }
  function setupZoomRange() {
    // Digital zoom range, the same on every device.
    nativeZoom = null;
    zoomSlider.min = "1"; zoomSlider.max = "5"; zoomSlider.step = "0.1";
    zoomSlider.value = String(zoom);
    applyZoom();
  }
  function setZoom(z) {
    const lo = parseFloat(zoomSlider.min), hi = parseFloat(zoomSlider.max);
    zoom = Math.min(hi, Math.max(lo, z));
    zoomSlider.value = String(zoom);
    applyZoom();
  }

  // Open (or reopen) the camera stream for the current deviceId. Shared by
  // start() and by switching cameras mid-broadcast.
  async function openStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    // "front" -> selfie camera via facingMode; a deviceId -> that exact lens;
    // "" -> let the browser pick the rear camera. Request a high-res stream so
    // digital zoom crops into real sensor detail instead of a low default frame;
    // "ideal" lets the device snap to its nearest supported mode without failing.
    const res = { width: { ideal: 3840 }, height: { ideal: 2160 } };
    const video_c = deviceId === "front"
      ? { facingMode: { ideal: "user" }, ...res }
      : deviceId
        ? { deviceId: { exact: deviceId }, ...res }
        : { facingMode: { ideal: "environment" }, ...res };
    stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
    video.srcObject = stream;
    track = stream.getVideoTracks()[0] || null;
    zoom = 1;
    panX = panY = 0;
    await video.play().catch(() => {});
    setupZoomRange();
  }
  async function start() {
    setErr("");
    try {
      await openStream();
    } catch (e) {
      setErr("Camera access denied or unavailable. On iPhone this page must be served over HTTPS, and you must allow camera access.");
      return;
    }
    await refreshCameras(); // labels are available now that we have permission
    startBtn.disabled = true;
    stopBtn.disabled = false;
    dot.classList.add("live");
    badgeText.textContent = "Live";
    requestWakeLock();
    capture();
    timer = setInterval(capture, intervalMs);
  }

  // Render the quadrilateral defined by corners (normalized over the crop
  // sx,sy,sw,sh of the source video) into the full ow x oh output rectangle,
  // applying a projective warp via a triangle mesh. Dependency-free.
  function warpQuadToRect(ctx, src, sx, sy, sw, sh, ow, oh) {
    // Source positions of the four corners, in source-image pixels.
    const S = corners.map((c) => ({ x: sx + c.x * sw, y: sy + c.y * sh }));
    const N = 24; // mesh resolution; higher = smoother perspective
    // Bilinear point on the source quad for grid coords u,v in 0..1
    // (TL=S0, TR=S1, BR=S2, BL=S3).
    const srcAt = (u, v) => {
      const topx = S[0].x + (S[1].x - S[0].x) * u, topy = S[0].y + (S[1].y - S[0].y) * u;
      const botx = S[3].x + (S[2].x - S[3].x) * u, boty = S[3].y + (S[2].y - S[3].y) * u;
      return { x: topx + (botx - topx) * v, y: topy + (boty - topy) * v };
    };
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
        // Destination cell rectangle.
        const dx0 = u0 * ow, dx1 = u1 * ow, dy0 = v0 * oh, dy1 = v1 * oh;
        const s00 = srcAt(u0, v0), s10 = srcAt(u1, v0), s01 = srcAt(u0, v1);
        drawTri(ctx, src,
          s00, s10, s01,
          { x: dx0, y: dy0 }, { x: dx1, y: dy0 }, { x: dx0, y: dy1 });
        const s11 = srcAt(u1, v1);
        drawTri(ctx, src,
          s10, s11, s01,
          { x: dx1, y: dy0 }, { x: dx1, y: dy1 }, { x: dx0, y: dy1 });
      }
    }
  }
  // Draw the source triangle (a,b,c) onto the destination triangle (A,B,C)
  // using a clipped affine transform.
  function drawTri(ctx, src, a, b, c, A, B, C) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.closePath();
    ctx.clip();
    // Solve the affine matrix mapping src tri -> dst tri.
    const denom = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(denom) < 1e-6) { ctx.restore(); return; }
    const m11 = ((B.x - A.x) * (c.y - a.y) - (C.x - A.x) * (b.y - a.y)) / denom;
    const m12 = ((B.y - A.y) * (c.y - a.y) - (C.y - A.y) * (b.y - a.y)) / denom;
    const m21 = ((C.x - A.x) * (b.x - a.x) - (B.x - A.x) * (c.x - a.x)) / denom;
    const m22 = ((C.y - A.y) * (b.x - a.x) - (B.y - A.y) * (c.x - a.x)) / denom;
    const dx = A.x - m11 * a.x - m21 * a.y;
    const dy = A.y - m12 * a.x - m22 * a.y;
    ctx.setTransform(m11, m12, m21, m22, dx, dy);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function stop() {
    if (timer) clearInterval(timer), (timer = null);
    if (stream) stream.getTracks().forEach((t) => t.stop()), (stream = null);
    track = null;
    video.srcObject = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    dot.classList.remove("live");
    badgeText.textContent = "Idle";
    releaseWakeLock();
  }
  async function capture() {
    if (sending || !video.videoWidth) return;
    sending = true;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      // Digital zoom: crop the centre by the zoom factor, offset by the pan.
      const sw = vw / zoom, sh = vh / zoom;
      const sx = (vw - sw) / 2 + panX * vw, sy = (vh - sh) / 2 + panY * vh;
      // The single downsize happens here, on the phone: scale the crop to the
      // chosen width (0 = full camera, capped by MAX_DIM), then JPEG-encode once.
      const target = maxWidth || sw;
      const fit = Math.min(1, target / sw, MAX_DIM / Math.max(sw, sh));
      canvas.width = Math.round(sw * fit);
      canvas.height = Math.round(sh * fit);
      const ctx = canvas.getContext("2d");
      if (cornersAreDefault()) {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      } else {
        // Perspective-correct: the four marked corners (in crop-relative coords)
        // are warped so the quadrilateral fills the output rectangle.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        warpQuadToRect(ctx, video, sx, sy, sw, sh, canvas.width, canvas.height);
      }
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", jpegQuality));
      if (!blob) throw new Error("encode failed");
      const res = await fetch("/upload", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "X-Interval-Ms": String(intervalMs) },
        body: blob,
      });
      if (!res.ok) throw new Error("upload " + res.status);
      count++;
      countEl.textContent = count;
      lastEl.textContent = new Date().toLocaleTimeString();
      resInfo.textContent = canvas.width + "×" + canvas.height + " · " + Math.round(blob.size / 1024) + " KB";
      // Show exactly what viewers receive: the encoded JPEG itself, decoded back.
      const url = URL.createObjectURL(blob);
      const prev = sentImg.src;
      sentImg.onload = () => { if (prev.startsWith("blob:")) URL.revokeObjectURL(prev); };
      sentImg.src = url;
      sentImg.classList.add("on");
      setErr("");
    } catch (e) {
      setErr("Upload problem: " + e.message + " (will retry on next frame)");
    } finally {
      sending = false;
    }
  }

  // Resolution (the single downsize target) — takes effect on the next frame.
  resSel.addEventListener("change", () => { maxWidth = parseInt(resSel.value, 10) || 0; });

  // JPEG quality selection — takes effect on the next captured frame.
  qualSel.addEventListener("change", () => { jpegQuality = parseFloat(qualSel.value) || 0.7; });

  // Capture interval — restart the timer immediately if we're broadcasting.
  intervalSel.addEventListener("change", () => {
    intervalMs = (parseInt(intervalSel.value, 10) || 5) * 1000;
    if (timer) { clearInterval(timer); timer = setInterval(capture, intervalMs); }
  });

  // Camera selection. Re-open the stream live if we're already broadcasting.
  camSel.addEventListener("change", async () => {
    deviceId = camSel.value;
    if (!stream) return;
    setErr("");
    try { await openStream(); }
    catch (e) { setErr("Could not switch camera: " + e.message); }
  });

  // Slider zoom.
  zoomSlider.addEventListener("input", () => setZoom(parseFloat(zoomSlider.value)));

  // Corner-straightening controls.
  warpBtn.addEventListener("click", () => { warpMode = !warpMode; showWarpUI(warpMode); });
  warpReset.addEventListener("click", () => {
    corners = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    drawWarpOverlay();
  });
  // Drag a corner handle (own pointer stream so it doesn't trigger pan/zoom).
  handleEls.forEach((h, i) => {
    h.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener("pointermove", (e) => {
      if (!h.hasPointerCapture(e.pointerId)) return;
      const rect = stage.getBoundingClientRect();
      corners[i] = {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      };
      drawWarpOverlay();
      e.preventDefault();
    });
    const end = (e) => { if (h.hasPointerCapture(e.pointerId)) h.releasePointerCapture(e.pointerId); };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  });
  window.addEventListener("resize", () => { if (warpMode) drawWarpOverlay(); });

  // Pinch-to-zoom (two fingers) and drag-to-pan (one finger, when zoomed in).
  const pointers = new Map();
  let pinchStartDist = 0, pinchStartZoom = 1;
  let panStart = null; // { x, y, panX, panY } for single-finger drag
  stage.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchStartZoom = zoom;
      panStart = null; // a second finger ends any in-progress pan
    } else if (pointers.size === 1) {
      panStart = { x: e.clientX, y: e.clientY, panX, panY };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2 && pinchStartDist > 0) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setZoom(pinchStartZoom * (dist / pinchStartDist));
      e.preventDefault();
    } else if (pointers.size === 1 && panStart && panRange() > 0) {
      // Drag the image with the finger: move right -> reveal the left side.
      const rect = stage.getBoundingClientRect();
      panX = panStart.panX - (e.clientX - panStart.x) / rect.width / zoom;
      panY = panStart.panY - (e.clientY - panStart.y) / rect.height / zoom;
      applyZoom();
      e.preventDefault();
    }
  }, { passive: false });
  function dropPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStartDist = 0;
    if (pointers.size === 0) panStart = null;
  }
  stage.addEventListener("pointerup", dropPointer);
  stage.addEventListener("pointercancel", dropPointer);
  stage.addEventListener("pointerleave", dropPointer);
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {}), (wakeLock = null);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer) requestWakeLock();
  });
  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);

  // Populate the camera list on load (labels stay blank until permission is
  // granted, but this fills the count; start() refreshes it with real names).
  refreshCameras();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshCameras);
  }
</script>
</body>
</html>`;

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return sendHtml(res, VIEWER_HTML);
  }

  if (req.method === "GET" && url === "/boss") {
    return sendHtml(res, BOSS_HTML);
  }

  if (req.method === "POST" && url === "/upload") {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted || chunks.length === 0) return json(res, 400, { error: "bad upload" });
      latestImage = Buffer.concat(chunks);
      lastUpdate = Date.now();
      // The capture page reports its cadence so viewers can size staleness to it.
      const reported = parseInt(req.headers["x-interval-ms"], 10);
      if (reported > 0 && reported <= 600000) captureIntervalMs = reported;
      return json(res, 200, { ok: true, size: latestImage.length });
    });
    req.on("error", () => {
      if (!res.headersSent) json(res, 400, { error: "upload failed" });
    });
    return;
  }

  if (req.method === "GET" && url === "/latest.jpg") {
    if (!latestImage) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      return res.end("no image yet");
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    return res.end(latestImage);
  }

  if (req.method === "GET" && url === "/status") {
    return json(res, 200, { hasImage: !!latestImage, lastUpdate, intervalMs: captureIntervalMs });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`scoreboard-cast listening on :${PORT}`);
  console.log(`  viewer:  /`);
  console.log(`  capture: /boss`);
});
