// PosturePal browser app
// All pose detection runs HERE, on your computer, with MediaPipe.
// Only small JSON numbers are sent to the local server. Never images.
import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---------- Settings ----------
const CALIBRATION_SECONDS = 5;
const COUNTDOWN_SECONDS = 3;
const HEARTBEAT_MS = 10_000;
const MAX_SESSION_HOURS = 3;          // auto-stop for privacy
const RECOVER_SECONDS = 3;            // good posture this long resets the bad streak
const SMOOTHING = 0.2;                // 0..1, higher = more responsive, more jitter
const SENSITIVITY = { low: 1.4, medium: 1.0, high: 0.7 }; // multiplies thresholds

// MediaPipe landmark indices
const NOSE = 0, L_EAR = 7, R_EAR = 8, L_SH = 11, R_SH = 12;

// ---------- Where the server lives ----------
// Same computer (localhost:3000) → "" (same origin).
// GitHub Pages → set window.POSTUREPAL_API in config.js, or open the page once with
// ?api=https://your-tunnel-url and it is remembered in this browser.
function resolveApi() {
  const fromUrl = new URLSearchParams(location.search).get("api");
  try {
    if (fromUrl) localStorage.setItem("posturepal.api", fromUrl);
    const saved = localStorage.getItem("posturepal.api");
    if (saved) return saved.replace(/\/+$/, "");
  } catch {}
  if (fromUrl) return fromUrl.replace(/\/+$/, "");
  return (window.POSTUREPAL_API || "").replace(/\/+$/, "");
}
const API = resolveApi();
const NO_SERVER = "Can't reach the PosturePal server. Make sure `bun start` and the tunnel are running on the host computer.";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const video = $("video"), canvas = $("overlay"), ctx = canvas.getContext("2d");
const draw = new DrawingUtils(ctx);

// ---------- State ----------
let landmarker = null;
let stream = null;
let mode = "idle";            // idle | countdown | calibrating | tracking
let currentUser = loadUser();
let baseline = loadBaseline();
let smoothed = null;
let calibSamples = [];
let lastFrameTime = 0;
let sessionStart = 0;
let badStreak = 0, goodStreak = 0, alertedThisStreak = false;
let stats = freshStats();
let heartbeatTimer = null;

function freshStats() {
  return { goodSeconds: 0, badSeconds: 0, awaySeconds: 0, issueCounts: {} };
}

// ---------- Local storage (this browser only) ----------
function loadUser() {
  try { return JSON.parse(localStorage.getItem("posturepal.user")); } catch { return null; }
}
function saveUser(u) {
  try { u ? localStorage.setItem("posturepal.user", JSON.stringify(u)) : localStorage.removeItem("posturepal.user"); } catch {}
}
const baselineKey = () => `posturepal.baseline.${currentUser?.id ?? "anon"}`;
function loadBaseline() {
  try { return JSON.parse(localStorage.getItem(baselineKey())); } catch { return null; }
}
function saveBaseline(b) {
  try { localStorage.setItem(baselineKey(), JSON.stringify(b)); } catch {}
}

// ---------- Server calls ----------
async function post(path, body = {}) {
  body = { userId: currentUser?.id, ...body };
  $("lastPayload").textContent = `POST ${path}\n${JSON.stringify({ ...body, userId: "…" }, null, 2)}`;
  try {
    const res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.warn("Server unreachable:", err);
    return {};
  }
}

// ---------- MediaPipe ----------
async function initLandmarker() {
  if (landmarker) return landmarker;
  setStatus("Loading pose model…", "");
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  return landmarker;
}

// ---------- Camera on/off ----------
async function cameraOn() {
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  $("placeholder").classList.add("hidden");
  $("pill").className = "pill on";
  $("pill").textContent = "● Tracking (camera on)";
}

function cameraOff() {
  stream?.getTracks().forEach((t) => t.stop()); // this turns the camera light off
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("placeholder").classList.remove("hidden");
  $("pill").className = "pill off";
  $("pill").textContent = "● Camera off";
}

// ---------- Posture math ----------
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function measure(lm) {
  const visible = [NOSE, L_SH, R_SH].every((i) => (lm[i].visibility ?? 1) > 0.5);
  if (!visible) return null;
  const sh = mid(lm[L_SH], lm[R_SH]);
  const ear = mid(lm[L_EAR], lm[R_EAR]);
  const shoulderWidth = Math.hypot(lm[L_SH].x - lm[R_SH].x, lm[L_SH].y - lm[R_SH].y);
  if (shoulderWidth < 0.05) return null; // person too far or turned sideways
  return {
    // Height of nose above shoulders, relative to shoulder width (drops when you slump)
    headHeight: (sh.y - lm[NOSE].y) / shoulderWidth,
    // Height of ears above shoulders (drops when head juts forward / down)
    earHeight: (sh.y - ear.y) / shoulderWidth,
    // How big you look on camera (grows when you lean toward the screen)
    shoulderWidth,
    // Left/right shoulder height difference (grows when you lean sideways)
    tilt: Math.abs(lm[L_SH].y - lm[R_SH].y) / shoulderWidth,
  };
}

function smooth(m) {
  if (!smoothed) return (smoothed = { ...m });
  for (const k in m) smoothed[k] = smoothed[k] * (1 - SMOOTHING) + m[k] * SMOOTHING;
  return smoothed;
}

function evaluate(m) {
  const k = SENSITIVITY[$("sensitivity").value];
  const issues = [];
  if (m.headHeight < baseline.headHeight * (1 - 0.15 * k)) issues.push("slouching");
  else if (m.earHeight < baseline.earHeight * (1 - 0.18 * k)) issues.push("head forward");
  if (m.shoulderWidth > baseline.shoulderWidth * (1 + 0.15 * k)) issues.push("leaning in");
  if (m.tilt > baseline.tilt + 0.1 * k) issues.push("tilted");
  return issues;
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ---------- Main loop ----------
function loop() {
  if (!stream) return;
  const now = performance.now();
  const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 1) : 0;
  lastFrameTime = now;

  const result = landmarker.detectForVideo(video, now);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const lm = result.landmarks?.[0];

  if (lm) {
    draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#7CFC9A", lineWidth: 3 });
    draw.drawLandmarks(lm.slice(0, 13), { color: "#ffffff", radius: 3 });
  }
  const raw = lm ? measure(lm) : null;

  if (mode === "calibrating" && raw) calibSamples.push(raw);
  if (mode === "tracking") track(raw, dt);

  requestAnimationFrame(loop);
}

function track(raw, dt) {
  if (!raw) {
    stats.awaySeconds += dt;
    badStreak = 0;
    alertedThisStreak = false;
    setStatus("Away (no one in frame), paused", "away");
    return;
  }
  const m = smooth(raw);
  const issues = evaluate(m);
  showMetrics(m);

  if (issues.length) {
    stats.badSeconds += dt;
    badStreak += dt;
    goodStreak = 0;
    for (const i of issues) stats.issueCounts[i] = (stats.issueCounts[i] ?? 0) + dt;
    setStatus(`⚠ ${issues.join(" + ")} (${Math.round(badStreak)}s)`, "bad");

    const limit = Number($("slouchSeconds").value);
    if (badStreak >= limit && !alertedThisStreak) {
      alertedThisStreak = true;
      sendAlert(issues[0], Math.round(badStreak));
    }
  } else {
    stats.goodSeconds += dt;
    goodStreak += dt;
    if (goodStreak >= RECOVER_SECONDS) {
      badStreak = 0;
      alertedThisStreak = false;
    }
    setStatus("✓ Good posture", "good");
  }
  updateSessionUI();
}

async function sendAlert(issue, seconds) {
  const res = await post("/api/alert", { issue, seconds });
  if (res.sent) {
    $("alerts").textContent = Number($("alerts").textContent) + 1;
    flash(`📱 Nudge sent: ${issue}`);
  } else {
    flash(`Nudge not sent: ${explain(res.reason)}`, 5000);
    if (res.reason === "needs-reply") setActivated(false);
  }
}

function explain(reason) {
  return {
    "needs-reply": "reply \"hi\" to PosturePal's text on your iPhone first",
    "not-allowed": "Photon won't text this number (see Terminal)",
    unsubscribed: "you unsubscribed. Text 'subscribe' to PosturePal",
    error: "send failed (see Terminal)",
  }[reason] ?? reason ?? "server unreachable";
}

async function testNudge() {
  const res = await post("/api/alert", { test: true });
  flash(res.sent ? "🔔 Test nudge sent. Check your iMessages!" : `Test failed: ${explain(res.reason)}`, 5000);
  if (res.reason === "needs-reply") setActivated(false);
}

// ---------- Calibration ----------
async function calibrate() {
  mode = "countdown";
  for (let i = COUNTDOWN_SECONDS; i > 0; i--) {
    flash(`Sit up straight in your normal chair… ${i}`, 1000);
    await sleep(1000);
  }
  calibSamples = [];
  mode = "calibrating";
  flash(`Hold still… calibrating`, CALIBRATION_SECONDS * 1000);
  await sleep(CALIBRATION_SECONDS * 1000);

  if (calibSamples.length < 20) {
    flash("Couldn't see you clearly. Make sure your head and shoulders are in frame.", 4000);
    mode = "idle";
    return false;
  }
  baseline = {};
  for (const key of Object.keys(calibSamples[0])) {
    baseline[key] = median(calibSamples.map((s) => s[key]));
  }
  baseline.calibratedAt = new Date().toISOString();
  saveBaseline(baseline);
  showCalibInfo();
  flash("✅ Calibrated! This is your 'good posture'.", 2500);
  return true;
}

// ---------- Session control ----------
async function start() {
  $("startBtn").disabled = true;
  try {
    await initLandmarker();
    await cameraOn();
  } catch (err) {
    alertBox("Could not start camera: " + err.message);
    $("startBtn").disabled = false;
    return;
  }
  lastFrameTime = 0;
  requestAnimationFrame(loop);

  if (!baseline && !(await calibrate())) {
    stop(false);
    return;
  }

  // Begin tracking
  stats = freshStats();
  smoothed = null;
  badStreak = 0; goodStreak = 0; alertedThisStreak = false;
  sessionStart = Date.now();
  $("alerts").textContent = "0";
  mode = "tracking";
  $("stopBtn").disabled = false;
  $("calibrateBtn").disabled = false;
  await post("/api/session/start", {});

  heartbeatTimer = setInterval(async () => {
    if (Date.now() - sessionStart > MAX_SESSION_HOURS * 3600_000) {
      flash("Auto-stopped after " + MAX_SESSION_HOURS + " hours", 4000);
      return stop();
    }
    const res = await post("/api/heartbeat", { stats: roundStats() });
    if (res.stop) {
      flash("Stopped from iMessage", 4000);
      stop();
    }
  }, HEARTBEAT_MS);
}

async function stop(report = true) {
  const wasTracking = mode === "tracking";
  mode = "idle";
  clearInterval(heartbeatTimer);
  cameraOff();
  setStatus("Not tracking", "");
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  if (report && wasTracking) await post("/api/session/stop", { stats: roundStats() });
}

async function recalibrate() {
  if (!stream) {
    baseline = null;           // next Start will calibrate first
    return start();
  }
  const prev = mode;
  if (await calibrate()) smoothed = null;
  mode = prev === "tracking" ? "tracking" : "idle";
}

// ---------- UI helpers ----------
function roundStats() {
  const r = (x) => Math.round(x);
  const issueCounts = Object.fromEntries(Object.entries(stats.issueCounts).map(([k, v]) => [k, r(v)]));
  return { goodSeconds: r(stats.goodSeconds), badSeconds: r(stats.badSeconds), awaySeconds: r(stats.awaySeconds), issueCounts };
}

function updateSessionUI() {
  const secs = Math.floor((Date.now() - sessionStart) / 1000);
  $("timer").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const total = stats.goodSeconds + stats.badSeconds;
  $("goodPct").textContent = total ? Math.round((stats.goodSeconds / total) * 100) + "%" : "–";
}

function showMetrics(m) {
  const pct = (v, b) => `${Math.round((v / b) * 100)}%`;
  $("metrics").innerHTML = `
    <li><span>Head height</span><span>${pct(m.headHeight, baseline.headHeight)} of baseline</span></li>
    <li><span>Ear height</span><span>${pct(m.earHeight, baseline.earHeight)} of baseline</span></li>
    <li><span>Distance (size)</span><span>${pct(m.shoulderWidth, baseline.shoulderWidth)} of baseline</span></li>
    <li><span>Tilt</span><span>${m.tilt.toFixed(2)} (base ${baseline.tilt.toFixed(2)})</span></li>`;
}

function setStatus(text, cls) {
  $("status").textContent = text;
  $("status").className = "status " + cls;
}

let flashTimer;
function flash(text, ms = 2500) {
  const b = $("banner");
  b.textContent = text;
  b.classList.remove("hidden");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add("hidden"), ms);
}

function alertBox(text) { flash(text, 5000); console.error(text); }

function showCalibInfo() {
  $("calibInfo").textContent = baseline
    ? `Calibrated ${new Date(baseline.calibratedAt).toLocaleString()}`
    : "Not calibrated yet. You'll calibrate when you press Start.";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Accounts ----------
function showView() {
  const signedIn = !!currentUser;
  $("signup").classList.toggle("hidden", signedIn);
  $("tracker").classList.toggle("hidden", !signedIn);
  $("hello").classList.toggle("hidden", !signedIn);
  $("signOutBtn").classList.toggle("hidden", !signedIn);
  if (!signedIn) $("activateBanner").classList.add("hidden");
  if (signedIn) {
    $("hello").textContent = `Hi, ${currentUser.firstName}`;
    setActivated(!!currentUser.activated);
    baseline = loadBaseline();
    showCalibInfo();
  }
}

$("signupForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = $("signupBtn");
  btn.disabled = true;
  btn.textContent = "Signing up…";
  $("signupError").classList.add("hidden");
  try {
    const res = await fetch(API + "/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify({
        firstName: f.get("firstName"),
        lastName: f.get("lastName"),
        email: f.get("email"),
        phone: f.get("phone"),
        consent: f.get("consent") === "on",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sign-up failed");
    currentUser = data.user;
    saveUser(currentUser);
    showView();
    flash(data.returning ? `Welcome back, ${currentUser.firstName}!` : "📱 Check your iMessages for a welcome text!", 4000);
  } catch (err) {
    $("signupError").textContent = err instanceof TypeError || err instanceof SyntaxError ? NO_SERVER : err.message;
    $("signupError").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign up";
  }
};

$("signOutBtn").onclick = async () => {
  if (mode === "tracking") await stop();
  currentUser = null;
  saveUser(null);
  showView();
};

// Activation: Photon only allows a few texts until the person replies once.
let activationPoll = null;
function setActivated(on) {
  if (!currentUser) return;
  currentUser.activated = on;
  saveUser(currentUser);
  $("activateBanner").classList.toggle("hidden", on);
  clearInterval(activationPoll);
  if (!on) activationPoll = setInterval(verifyUser, 4000);
}

// Refresh the user from the server (also catches a cleared data/ folder)
async function verifyUser() {
  if (!currentUser) return;
  try {
    const res = await fetch(API + "/api/me", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify({ userId: currentUser.id }),
    });
    if (res.status === 401) {
      currentUser = null;
      saveUser(null);
      clearInterval(activationPoll);
      showView();
      return;
    }
    const { user } = await res.json();
    if (user.activated !== currentUser.activated) {
      setActivated(user.activated);
      if (user.activated) flash("✅ Nudges activated!", 3000);
    }
  } catch {}
}

// ---------- Wire up ----------
$("startBtn").onclick = start;
$("stopBtn").onclick = () => stop();
$("calibrateBtn").onclick = recalibrate;
$("testBtn").onclick = testNudge;
window.addEventListener("beforeunload", () => {
  if (mode === "tracking" && currentUser)
    navigator.sendBeacon(API + "/api/session/stop", JSON.stringify({ userId: currentUser.id, stats: roundStats() }));
});
showView();
verifyUser();
