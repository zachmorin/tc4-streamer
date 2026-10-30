import "./styles.css";
import {
  AUDIO_CONSTRAINTS_BASE,
  SITE_TITLE,
  VIDEO_CONSTRAINTS_BASE,
  VIDEO_MAX_BITRATE,
  secretSource,
} from "./config";
import { getProvider, type Endpoint } from "./providers";
import { hangup, negotiate, redactUrl } from "./lib/whip";
import { tuneOpus } from "./lib/sdp";
import { fmtDb, StereoMeter } from "./lib/meter";
import { unseal } from "./lib/seal";
import { createLog, fmtDuration, fmtKbps } from "./lib/terminal";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const log = createLog($("log"));
const provider = getProvider();
const source = secretSource(provider.id);

$("site-title").textContent = SITE_TITLE;
$("provider-label").textContent = provider.label;
document.title = `GO LIVE // ${SITE_TITLE}`;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
const gate = $("gate");
const gateForm = $<HTMLFormElement>("gate-form");
const gateInput = $<HTMLInputElement>("gate-input");
const gateLabel = $("gate-label");
const gateMsg = $("gate-msg");
const consoleEl = $("console");

const LS_KEY = `dj-stream:${provider.id}:secret`;
let publishEndpoint: Endpoint | null = null;

function unlock(secret: string) {
  const problem = provider.validateSecret(secret);
  if (problem) throw new Error(problem);
  publishEndpoint = provider.publish(secret);
  gate.classList.add("hidden");
  consoleEl.classList.remove("hidden");
  log(`unlocked. publish target: ${redactUrl(publishEndpoint.url)}`, "ok");
}

function setupGate() {
  if (source.mode === "plain") {
    log("WARNING: plaintext VITE_WHIP_URL in bundle. Use `npm run seal` for a public deployment.", "err");
    unlock(source.secret);
    return;
  }
  if (source.mode === "sealed") {
    gateLabel.textContent = "passphrase";
    gateInput.type = "password";
    gateInput.placeholder = "";
    log("broadcast credential is sealed. enter passphrase to unlock.");
  } else {
    gateLabel.textContent = provider.secretLabel.toLowerCase();
    gateInput.type = "text";
    gateInput.placeholder = provider.id === "livekit" ? "stream key" : "https://customer-xxxx.cloudflarestream.com/<secret>/webRTC/publish";
    const remembered = localStorage.getItem(LS_KEY);
    if (remembered) gateInput.value = remembered;
    log(`no sealed credential configured. paste the ${provider.secretLabel} (kept in this browser's localStorage only).`);
  }
  gateInput.focus();

  gateForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    gateMsg.textContent = "";
    const value = gateInput.value.trim();
    if (!value) return;
    try {
      if (source.mode === "sealed") {
        gateMsg.textContent = "deriving key...";
        const secret = await unseal(source.sealed, value);
        unlock(secret);
      } else {
        unlock(value);
        localStorage.setItem(LS_KEY, value);
      }
      gateInput.value = "";
    } catch (e) {
      gateMsg.textContent = `access denied: ${(e as Error).message}`;
      log(`unlock failed: ${(e as Error).message}`, "err");
    }
  });
}

// ---------------------------------------------------------------------------
// Devices + preview
// ---------------------------------------------------------------------------
const camSelect = $<HTMLSelectElement>("cam-select");
const micSelect = $<HTMLSelectElement>("mic-select");
const accessBtn = $<HTMLButtonElement>("access-btn");
const refreshBtn = $<HTMLButtonElement>("refresh-btn");
const monitorBtn = $<HTMLButtonElement>("monitor-btn");
const preview = $<HTMLVideoElement>("preview");
const previewOverlay = $("preview-overlay");
const meterCanvas = $<HTMLCanvasElement>("meter");
const meterL = $("meter-l");
const meterR = $("meter-r");
const audioFmt = $("audio-fmt");

const meter = new StereoMeter(meterCanvas);
let localStream: MediaStream | null = null;
let monitoring = false;
let acquiring = false;

const PREF_CAM = "dj-stream:cam";
const PREF_MIC = "dj-stream:mic";

async function listDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");
  fill(camSelect, cams, localStorage.getItem(PREF_CAM), "camera");
  fill(micSelect, mics, localStorage.getItem(PREF_MIC), "audio input");
  camSelect.disabled = cams.length === 0;
  micSelect.disabled = mics.length === 0;
  log(`devices: ${cams.length} camera(s), ${mics.length} audio input(s)`);
}

function fill(sel: HTMLSelectElement, devices: MediaDeviceInfo[], preferred: string | null, kind: string) {
  const current = sel.value || preferred;
  sel.innerHTML = "";
  if (devices.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = `(no ${kind} found)`;
    sel.appendChild(o);
    return;
  }
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `${kind} ${i + 1}`;
    sel.appendChild(o);
  });
  if (current && devices.some((d) => d.deviceId === current)) sel.value = current;
}

function stopLocal() {
  meter.detach();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  preview.srcObject = null;
  previewOverlay.classList.remove("hidden");
}

async function acquire(): Promise<void> {
  if (acquiring) return;
  acquiring = true;
  try {
    const camId = camSelect.value;
    const micId = micSelect.value;
    const constraints: MediaStreamConstraints = {
      video: { ...VIDEO_CONSTRAINTS_BASE, ...(camId ? { deviceId: { exact: camId } } : {}) },
      audio: { ...AUDIO_CONSTRAINTS_BASE, ...(micId ? { deviceId: { exact: micId } } : {}) },
    };
    log(`requesting media: ${JSON.stringify(constraints.audio)}`);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    const [audio] = stream.getAudioTracks();
    const [video] = stream.getVideoTracks();
    if (audio) {
      // Hint the encoder/processing pipeline that this is music, not speech.
      if ("contentHint" in audio) audio.contentHint = "music";
      await pushSampleRateToMax(audio);
    }

    // If already live, swap tracks in place rather than renegotiating.
    if (pc && localStream) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === "audio" && audio) await sender.replaceTrack(audio);
        if (sender.track?.kind === "video" && video) await sender.replaceTrack(video);
      }
      log("live tracks swapped", "ok");
    }

    // Replace local stream.
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = stream;
    preview.srcObject = stream;
    previewOverlay.classList.toggle("hidden", !!video);

    if (audio) {
      await meter.attach(stream, (r) => {
        meterL.textContent = `L ${fmtDb(r.rmsDb[0])} pk ${fmtDb(r.peakDb[0])} dBFS${r.clipped[0] ? " CLIP" : ""}`;
        meterR.textContent = `R ${fmtDb(r.rmsDb[1])} pk ${fmtDb(r.peakDb[1])} dBFS${r.clipped[1] ? " CLIP" : ""}`;
      });
      meter.setMonitor(monitoring);
      reportAudioSettings(audio);
    }
    if (video) {
      const s = video.getSettings();
      log(`video: ${s.width}x${s.height}@${s.frameRate ?? "?"}fps (${video.label})`);
    }

    // Remember choices; fill labels now that permission exists.
    if (camId) localStorage.setItem(PREF_CAM, camId);
    if (micId) localStorage.setItem(PREF_MIC, micId);
    await listDevices();
    refreshBtn.disabled = false;
    monitorBtn.disabled = !audio;
    liveBtn.disabled = !publishEndpoint || !audio;
    accessBtn.textContent = "re-acquire devices";
  } catch (e) {
    const err = e as DOMException;
    log(`getUserMedia failed: ${err.name}: ${err.message}`, "err");
    if (err.name === "OverconstrainedError") {
      log("device could not satisfy an exact constraint; pick another device or refresh", "err");
    }
  } finally {
    acquiring = false;
  }
}

/** Ask the device for its highest supported sample rate (Chrome exposes it via getCapabilities). */
async function pushSampleRateToMax(track: MediaStreamTrack): Promise<void> {
  const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  const max = caps.sampleRate?.max;
  const current = track.getSettings().sampleRate;
  if (!max || !current || max <= current) return;
  for (const sampleRate of [{ exact: max }, { ideal: max }] as const) {
    try {
      await track.applyConstraints({ ...AUDIO_CONSTRAINTS_BASE, sampleRate });
    } catch {
      continue;
    }
    const after = track.getSettings().sampleRate ?? current;
    if (after > current) {
      log(`sample rate raised ${current} -> ${after} Hz (device max ${max})`, "ok");
      return;
    }
  }
  log(
    `device advertises ${max} Hz but Chrome kept ${current} Hz; set the interface to 48 kHz in Audio MIDI Setup (WebRTC Opus runs at 48 kHz regardless)`,
  );
}

function reportAudioSettings(track: MediaStreamTrack) {
  const s = track.getSettings();
  // Logged as JSON on purpose: this is the line to check that constraints were honored.
  console.log("[dj-stream] audio track.getSettings()", JSON.stringify(s));
  const ch = s.channelCount ?? "?";
  const sr = s.sampleRate ?? "?";
  const ss = s.sampleSize ?? "?";
  audioFmt.textContent = `audio: ${ch === 2 ? "stereo" : ch === 1 ? "MONO" : `${ch}ch`} ${sr} Hz ${ss}-bit`;
  const flags = [
    `ec=${String(s.echoCancellation)}`,
    `ns=${String(s.noiseSuppression)}`,
    `agc=${String(s.autoGainControl)}`,
    `ch=${ch}`,
    `sr=${sr}`,
    `bits=${ss}`,
    `latency=${(s as MediaTrackSettings & { latency?: number }).latency ?? "?"}`,
  ];
  log(`audio: ${track.label}`);
  log(`audio settings: ${flags.join(" ")}`, "bright");
  if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
    log("browser kept some processing ON; audio will be degraded", "err");
  }
  if (ch === 1) log("input is MONO. check the interface/aggregate device in Audio MIDI Setup", "err");
}

accessBtn.addEventListener("click", () => void acquire());
refreshBtn.addEventListener("click", () => void listDevices());
camSelect.addEventListener("change", () => void acquire());
micSelect.addEventListener("change", () => void acquire());
monitorBtn.addEventListener("click", () => {
  monitoring = !monitoring;
  meter.setMonitor(monitoring);
  monitorBtn.textContent = `monitor: ${monitoring ? "on" : "off"}`;
  monitorBtn.classList.toggle("active", monitoring);
  log(monitoring ? "monitor ON (use headphones, this is post-capture so it has latency)" : "monitor off");
});
navigator.mediaDevices.addEventListener("devicechange", () => void listDevices());

// ---------------------------------------------------------------------------
// Transmit
// ---------------------------------------------------------------------------
const txPill = $("tx-pill");
const txDetail = $("tx-detail");
const txStats = $("tx-stats");
const liveBtn = $<HTMLButtonElement>("live-btn");
const stopBtn = $<HTMLButtonElement>("stop-btn");

let pc: RTCPeerConnection | null = null;
let sessionUrl: string | null = null;
let statsTimer = 0;
let liveSince = 0;
let lastBytes = { audio: 0, video: 0, at: 0 };

type TxState = "idle" | "connecting" | "live" | "error";
function setTx(s: TxState, text = "") {
  txPill.className = `pill ${s === "idle" ? "" : s}`;
  txPill.textContent = s === "live" ? "LIVE" : s === "connecting" ? "CONNECTING" : s === "error" ? "ERROR" : "IDLE";
  txDetail.textContent = text;
  liveBtn.classList.toggle("hidden", s === "live" || s === "connecting");
  stopBtn.classList.toggle("hidden", !(s === "live" || s === "connecting"));
}

async function goLive(): Promise<void> {
  if (!publishEndpoint || !localStream || pc) return;
  setTx("connecting", "negotiating WHIP");
  liveBtn.disabled = true;

  const conn = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  pc = conn;
  for (const track of localStream.getTracks()) {
    const tr = conn.addTransceiver(track, { direction: "sendonly", streams: [localStream] });
    if (track.kind === "video") {
      const p = tr.sender.getParameters();
      p.encodings = [{ maxBitrate: VIDEO_MAX_BITRATE }];
      p.degradationPreference = "maintain-framerate";
      await tr.sender.setParameters(p).catch(() => undefined);
    }
  }

  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    const st = conn.connectionState;
    log(`peer connection: ${st}`);
    if (st === "connected") {
      liveSince = Date.now();
      lastBytes = { audio: 0, video: 0, at: 0 };
      setTx("live", "on air");
      log("ON AIR", "ok");
      statsTimer = window.setInterval(() => void pollStats(conn), 1000);
    } else if (st === "failed") {
      setTx("error", "connection failed");
      void endStream(false);
    } else if (st === "disconnected") {
      txDetail.textContent = "reconnecting...";
    }
  };

  try {
    sessionUrl = await negotiate(conn, publishEndpoint, { mungeOffer: tuneOpus, mungeAnswer: tuneOpus });
    log(`WHIP accepted by ${new URL(publishEndpoint.url).host}${sessionUrl ? " (session created)" : ""}`, "ok");
  } catch (e) {
    log(`WHIP failed: ${(e as Error).message}`, "err");
    setTx("error", (e as Error).message);
    await endStream(false);
  }
}

async function endStream(userInitiated = true): Promise<void> {
  clearInterval(statsTimer);
  statsTimer = 0;
  txStats.textContent = "";
  const conn = pc;
  pc = null;
  if (conn) {
    conn.onconnectionstatechange = null;
    conn.close();
  }
  if (publishEndpoint) await hangup(sessionUrl, publishEndpoint);
  sessionUrl = null;
  if (userInitiated) {
    setTx("idle", "stream ended");
    log("stream ended", "ok");
  }
  liveBtn.disabled = !publishEndpoint || !localStream;
}

async function pollStats(conn: RTCPeerConnection) {
  const stats = await conn.getStats();
  let audio = 0;
  let video = 0;
  let audioCodec = "";
  let res = "";
  let rtt = 0;
  const codecs = new Map<string, string>();
  stats.forEach((r) => {
    if (r.type === "codec") codecs.set(r.id, `${String(r.mimeType).split("/")[1]}${r.sdpFmtpLine?.includes("stereo=1") ? " stereo" : ""}`);
  });
  stats.forEach((r) => {
    if (r.type === "outbound-rtp") {
      if (r.kind === "audio") {
        audio += r.bytesSent ?? 0;
        if (r.codecId) audioCodec = codecs.get(r.codecId) ?? "";
      } else if (r.kind === "video") {
        video += r.bytesSent ?? 0;
        if (r.frameWidth) res = `${r.frameWidth}x${r.frameHeight}@${Math.round(r.framesPerSecond ?? 0)}`;
      }
    }
    if (r.type === "candidate-pair" && r.nominated && r.currentRoundTripTime) rtt = r.currentRoundTripTime * 1000;
  });
  const now = performance.now();
  const dt = lastBytes.at ? (now - lastBytes.at) / 1000 : 0;
  const aBps = dt ? ((audio - lastBytes.audio) * 8) / dt : 0;
  const vBps = dt ? ((video - lastBytes.video) * 8) / dt : 0;
  lastBytes = { audio, video, at: now };
  txStats.textContent = `on air ${fmtDuration(Date.now() - liveSince)} | A ${fmtKbps(aBps)} ${audioCodec} | V ${fmtKbps(vBps)} ${res} | rtt ${rtt.toFixed(0)}ms`;
}

liveBtn.addEventListener("click", () => void goLive());
stopBtn.addEventListener("click", () => void endStream(true));
window.addEventListener("beforeunload", (ev) => {
  if (pc) {
    ev.preventDefault();
    void endStream(false);
  }
});
window.addEventListener("pagehide", () => {
  if (pc) void endStream(false);
  stopLocal();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
log(`${SITE_TITLE} // broadcast console`);
if (!navigator.mediaDevices?.getUserMedia) {
  log("this browser has no getUserMedia (needs https or localhost)", "err");
}
if (!window.isSecureContext) {
  log("not a secure context: camera/mic access requires https or localhost", "err");
}
setupGate();
