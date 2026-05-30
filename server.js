// Scoreboard broadcast server — single file, zero dependencies.
//
//   GET  /            -> viewer page (shows the latest photo, polls every 2s)
//   GET  /boss        -> capture page (camera, snaps + uploads every 5s)
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
<script>
  const POLL_MS = 2000;
  const STALE_MS = 15000; // hide "LIVE" if no fresh frame in this window
  const img = document.getElementById("shot");
  const waiting = document.getElementById("waiting");
  const live = document.getElementById("live");
  let lastShown = 0;
  async function poll() {
    try {
      const res = await fetch("/status", { cache: "no-store" });
      const { hasImage, lastUpdate } = await res.json();
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
      const fresh = hasImage && Date.now() - lastUpdate < STALE_MS;
      live.classList.toggle("on", fresh);
    } catch {
      live.classList.remove("on");
    }
  }
  poll();
  setInterval(poll, POLL_MS);
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
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0b0d12;
    color: #e8eaf0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: env(safe-area-inset-top) 16px 24px;
  }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: .02em; margin: 16px 0 4px; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 16px; text-align: center; }
  .stage {
    position: relative;
    width: 100%;
    max-width: 520px;
    aspect-ratio: 4 / 3;
    background: #000;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid #1d2230;
  }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .badge {
    position: absolute; top: 10px; left: 10px;
    display: flex; align-items: center; gap: 6px;
    background: rgba(0,0,0,.55); padding: 5px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #555; }
  .dot.live { background: #ff3b30; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .controls { width: 100%; max-width: 520px; margin-top: 18px; display: flex; flex-direction: column; gap: 12px; }
  button {
    appearance: none; border: 0; border-radius: 12px; padding: 16px;
    font-size: 17px; font-weight: 600; cursor: pointer; width: 100%;
  }
  .start { background: #2f7bff; color: #fff; }
  .stop { background: #2a2f3d; color: #e8eaf0; }
  button:disabled { opacity: .4; cursor: default; }
  .stats {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    width: 100%; max-width: 520px; margin-top: 14px;
  }
  .stat { background: #11141c; border: 1px solid #1d2230; border-radius: 12px; padding: 12px 14px; }
  .stat .k { color: #8b93a7; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .stat .v { font-size: 20px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .err { color: #ff6b60; font-size: 14px; margin-top: 12px; text-align: center; max-width: 520px; }
  .hint { color: #5d6477; font-size: 12px; margin-top: 16px; text-align: center; max-width: 520px; line-height: 1.5; }
</style>
</head>
<body>
  <h1>Scoreboard Capture</h1>
  <div class="sub">Point the camera at the scoreboard. A photo is sent every 5&nbsp;seconds.</div>
  <div class="stage">
    <video id="preview" playsinline muted autoplay></video>
    <div class="badge"><span class="dot" id="dot"></span><span id="badgeText">Idle</span></div>
  </div>
  <div class="controls">
    <button class="start" id="startBtn">Start broadcasting</button>
    <button class="stop" id="stopBtn" disabled>Stop</button>
  </div>
  <div class="stats">
    <div class="stat"><div class="k">Photos sent</div><div class="v" id="count">0</div></div>
    <div class="stat"><div class="k">Last sent</div><div class="v" id="last">—</div></div>
  </div>
  <div class="err" id="err"></div>
  <div class="hint">Keep this page open and the screen on. On iPhone, tap “Start” and allow camera access. The screen is kept awake automatically while broadcasting.</div>
<script>
  const INTERVAL_MS = 5000;
  const MAX_WIDTH = 1280;     // downscale wide frames to keep uploads small
  const JPEG_QUALITY = 0.7;
  const video = document.getElementById("preview");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const dot = document.getElementById("dot");
  const badgeText = document.getElementById("badgeText");
  const countEl = document.getElementById("count");
  const lastEl = document.getElementById("last");
  const errEl = document.getElementById("err");
  let stream = null, timer = null, count = 0, sending = false, wakeLock = null;
  const canvas = document.createElement("canvas");
  function setErr(msg) { errEl.textContent = msg || ""; }
  async function start() {
    setErr("");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
    } catch (e) {
      setErr("Camera access denied or unavailable. On iPhone this page must be served over HTTPS, and you must allow camera access.");
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    startBtn.disabled = true;
    stopBtn.disabled = false;
    dot.classList.add("live");
    badgeText.textContent = "Live";
    requestWakeLock();
    capture();
    timer = setInterval(capture, INTERVAL_MS);
  }
  function stop() {
    if (timer) clearInterval(timer), (timer = null);
    if (stream) stream.getTracks().forEach((t) => t.stop()), (stream = null);
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
      const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));
      if (!blob) throw new Error("encode failed");
      const res = await fetch("/upload", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (!res.ok) throw new Error("upload " + res.status);
      count++;
      countEl.textContent = count;
      lastEl.textContent = new Date().toLocaleTimeString();
      setErr("");
    } catch (e) {
      setErr("Upload problem: " + e.message + " (will retry on next frame)");
    } finally {
      sending = false;
    }
  }
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
    return json(res, 200, { hasImage: !!latestImage, lastUpdate });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`scoreboard-cast listening on :${PORT}`);
  console.log(`  viewer:  /`);
  console.log(`  capture: /boss`);
});
