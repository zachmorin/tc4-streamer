import "./styles.css";
import { SITE_TITLE, VIEWER_PROBE_INTERVAL_MS } from "./config";
import { getProvider } from "./providers";
import { hangup, negotiate, SignalError } from "./lib/whip";
import { createLog, fmtDuration, fmtKbps } from "./lib/terminal";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const titleEl = $("site-title");
const pill = $("status-pill");
const detail = $("status-detail");
const player = $<HTMLVideoElement>("player");
const overlay = $("overlay");
const overlayText = $("overlay-text");
const statsEl = $("stats");
const log = createLog($("log"));

titleEl.textContent = SITE_TITLE;
document.title = `${SITE_TITLE} // LIVE`;

type State = "offline" | "connecting" | "live" | "error";

let pc: RTCPeerConnection | null = null;
let sessionUrl: string | null = null;
let probeTimer = 0;
let statsTimer = 0;
let liveSince = 0;
let lastBytes = 0;
let lastStatsAt = 0;
let wantAudio = true;

const provider = getProvider();
const playback = provider.playback();

function setState(s: State, text?: string) {
  pill.className = `pill ${s === "offline" ? "" : s}`;
  pill.textContent = s === "live" ? "LIVE" : s === "connecting" ? "TUNING" : s === "error" ? "ERROR" : "OFFLINE";
  detail.textContent = text ?? "";
  document.title = `${s === "live" ? "LIVE" : "OFFLINE"} // ${SITE_TITLE}`;
}

function showOverlay(text: string, clickable = false) {
  overlayText.textContent = text;
  overlay.classList.remove("hidden");
  overlay.classList.toggle("clickable", clickable);
}

function hideOverlay() {
  overlay.classList.add("hidden");
  overlay.classList.remove("clickable");
}

async function teardown() {
  clearInterval(statsTimer);
  statsTimer = 0;
  statsEl.textContent = "";
  if (pc) {
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
  }
  if (playback.endpoint) await hangup(sessionUrl, playback.endpoint);
  pc = null;
  sessionUrl = null;
  player.srcObject = null;
}

function scheduleProbe(ms = VIEWER_PROBE_INTERVAL_MS) {
  clearTimeout(probeTimer);
  probeTimer = window.setTimeout(() => void tuneIn(), ms);
}

async function tuneIn(): Promise<void> {
  if (!playback.endpoint) return;
  if (pc) return;

  setState("connecting", "probing for signal");
  const conn = new RTCPeerConnection();
  pc = conn;
  const stream = new MediaStream();
  conn.addTransceiver("video", { direction: "recvonly" });
  conn.addTransceiver("audio", { direction: "recvonly" });
  conn.ontrack = (ev) => {
    stream.addTrack(ev.track);
    player.srcObject = stream;
  };
  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    const st = conn.connectionState;
    if (st === "connected") {
      liveSince = Date.now();
      lastBytes = 0;
      lastStatsAt = 0;
      setState("live", "");
      log("signal acquired. stream is LIVE", "ok");
      hideOverlay();
      void startPlayback();
      statsTimer = window.setInterval(() => void pollStats(conn), 1000);
    } else if (st === "disconnected" || st === "failed" || st === "closed") {
      log(`connection ${st}. back to standby`, st === "failed" ? "err" : "info");
      void teardown().then(() => {
        setState("offline", "stream ended");
        showOverlay("NO SIGNAL");
        scheduleProbe(3000);
      });
    }
  };

  try {
    sessionUrl = await negotiate(conn, playback.endpoint, { gatherTimeoutMs: 800 });
    log("WHEP answer received, connecting...");
    // Some servers answer even with no publisher; do not sit in TUNING forever.
    window.setTimeout(() => {
      if (pc === conn && conn.connectionState !== "connected") {
        log("no media within 15s; back to standby");
        void teardown().then(() => {
          setState("offline", "no broadcast in progress");
          showOverlay("NO SIGNAL");
          scheduleProbe();
        });
      }
    }, 15_000);
  } catch (e) {
    const err = e as SignalError;
    await teardown();
    const offline = err.status === 404 || err.status === 400 || err.status === 409 || err.status === 503;
    if (offline) {
      setState("offline", "no broadcast in progress");
      log(`no signal (${err.message}); retry in ${VIEWER_PROBE_INTERVAL_MS / 1000}s`);
    } else {
      setState("offline", `probe failed: ${err.message}`);
      log(`probe failed: ${err.message}`, "err");
    }
    showOverlay("NO SIGNAL");
    scheduleProbe();
  }
}

async function startPlayback() {
  player.muted = !wantAudio;
  try {
    await player.play();
    if (player.muted) showOverlay("CLICK TO UNMUTE", true);
  } catch {
    // Autoplay with sound blocked: fall back to muted and ask for a click.
    player.muted = true;
    await player.play().catch(() => undefined);
    showOverlay("CLICK TO UNMUTE", true);
    log("autoplay with audio blocked by browser; click the video to unmute");
  }
}

overlay.addEventListener("click", () => {
  if (!overlay.classList.contains("clickable")) return;
  wantAudio = true;
  player.muted = false;
  void player.play().catch(() => undefined);
  hideOverlay();
  log("audio unmuted", "ok");
});

async function pollStats(conn: RTCPeerConnection) {
  const stats = await conn.getStats();
  let bytes = 0;
  let audioCodec = "";
  let videoRes = "";
  const codecs = new Map<string, string>();
  stats.forEach((r) => {
    if (r.type === "codec") codecs.set(r.id, `${String(r.mimeType).split("/")[1]}`);
  });
  stats.forEach((r) => {
    if (r.type === "inbound-rtp") {
      bytes += r.bytesReceived ?? 0;
      if (r.kind === "audio" && r.codecId) audioCodec = codecs.get(r.codecId) ?? "";
      if (r.kind === "video" && r.frameWidth) videoRes = `${r.frameWidth}x${r.frameHeight}@${Math.round(r.framesPerSecond ?? 0)}`;
    }
  });
  const now = performance.now();
  const bps = lastStatsAt ? ((bytes - lastBytes) * 8) / ((now - lastStatsAt) / 1000) : 0;
  lastBytes = bytes;
  lastStatsAt = now;
  statsEl.textContent = `up ${fmtDuration(Date.now() - liveSince)} | ${fmtKbps(bps)} | ${videoRes || "--"} | ${audioCodec || "--"}`;
}

// Boot
log(`${SITE_TITLE} // viewer online`);
if (playback.kind !== "whep" || !playback.endpoint) {
  setState("offline", "not configured");
  showOverlay("NOT CONFIGURED");
  log(`playback unavailable: ${playback.reason ?? "unknown"}`, "err");
  log("set VITE_WHEP_URL to the live input's WebRTC playback URL and rebuild");
} else {
  log(`provider: ${provider.label}`);
  log(`playback: ${new URL(playback.endpoint.url).host}`);
  showOverlay("NO SIGNAL");
  void tuneIn();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !pc) void tuneIn();
  });
}
