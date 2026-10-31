import "./styles.css";
import { SITE_TITLE, VIEWER_PROBE_INTERVAL_MS } from "./config";
import { getProvider } from "./providers";
import { hangup, negotiate, SignalError } from "./lib/whip";
import { createLog, fmtDuration, fmtKbps } from "./lib/terminal";
import { ChatClient, EMOJI, loadChatName, saveChatName, type ChatMessage } from "./lib/chat";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const titleEl = $("site-title");
const pill = $("status-pill");
const detail = $("status-detail");
const player = $<HTMLVideoElement>("player");
const overlay = $("overlay");
const overlayText = $("overlay-text");
const statsEl = $("stats");
const logEl = $("log");
const log = createLog(logEl);
const liveFill = $("live-fill");
const liveLabel = $("live-label");
const videoShell = $("video-shell");
const settingsPanel = $("settings-panel");
const playBtn = $<HTMLButtonElement>("ctrl-play");
const muteBtn = $<HTMLButtonElement>("ctrl-mute");
const volSlider = $<HTMLInputElement>("ctrl-vol");
const settingsBtn = $<HTMLButtonElement>("ctrl-settings");
const fsBtn = $<HTMLButtonElement>("ctrl-fs");

titleEl.textContent = SITE_TITLE;
document.querySelectorAll<HTMLElement>("[data-brand]").forEach((el) => {
  el.textContent = SITE_TITLE;
});
document.title = `${SITE_TITLE} // LIVE`;

/** Seamless ticker: clone sets to fill the viewport, animate by exact set width. */
function setupMarquee(): void {
  const root = document.querySelector<HTMLElement>(".marquee");
  const track = document.querySelector<HTMLElement>(".marquee-track");
  const proto = track?.querySelector<HTMLElement>(".marquee-set");
  if (!root || !track || !proto) return;

  const PX_PER_SEC = 80;

  const layout = () => {
    // Reset to a single set, then clone.
    track.querySelectorAll(".marquee-set").forEach((el, i) => {
      if (i > 0) el.remove();
    });
    track.style.animation = "none";

    // Force layout so widths are real after font load / resize.
    const setWidth = proto.getBoundingClientRect().width;
    const gap = Number.parseFloat(getComputedStyle(track).gap) || 0;
    const unit = setWidth + gap;
    if (unit <= 0) return;

    const need = Math.max(2, Math.ceil((root.clientWidth + unit) / unit) + 1);
    for (let i = 1; i < need; i++) {
      const clone = proto.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-brand]").forEach((el) => {
        el.textContent = SITE_TITLE;
      });
      track.appendChild(clone);
    }

    root.style.setProperty("--marquee-shift", `${unit}px`);
    root.style.setProperty("--marquee-duration", `${unit / PX_PER_SEC}s`);
    // Retrigger animation after measurement.
    void track.offsetWidth;
    track.style.animation = "";
  };

  const run = () => requestAnimationFrame(layout);
  run();
  document.fonts?.ready.then(run).catch(() => undefined);
  window.addEventListener("resize", run);
}
setupMarquee();

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
  liveFill.classList.toggle("on", s === "live");
  liveLabel.textContent = s === "live" ? "LIVE" : s === "connecting" ? "TUNING" : "STANDBY";
  syncPlayIcon();
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

function syncPlayIcon() {
  const paused = player.paused;
  playBtn.querySelector("use")?.setAttribute("href", paused ? "#g-play" : "#g-pause");
  playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
}

function syncMuteIcon() {
  const muted = player.muted || player.volume === 0;
  muteBtn.querySelector("use")?.setAttribute("href", muted ? "#g-mute" : "#g-vol");
  muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
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
  syncPlayIcon();
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
  syncMuteIcon();
  try {
    await player.play();
    if (player.muted) showOverlay("CLICK TO UNMUTE", true);
  } catch {
    player.muted = true;
    await player.play().catch(() => undefined);
    showOverlay("CLICK TO UNMUTE", true);
    syncMuteIcon();
    log("autoplay with audio blocked by browser; click the video to unmute");
  }
  syncPlayIcon();
}

overlay.addEventListener("click", () => {
  if (!overlay.classList.contains("clickable")) return;
  wantAudio = true;
  player.muted = false;
  void player.play().catch(() => undefined);
  hideOverlay();
  syncMuteIcon();
  syncPlayIcon();
  log("audio unmuted", "ok");
});

playBtn.addEventListener("click", () => {
  if (player.paused) void player.play().catch(() => undefined);
  else player.pause();
  syncPlayIcon();
});

muteBtn.addEventListener("click", () => {
  player.muted = !player.muted;
  wantAudio = !player.muted;
  if (!player.muted && player.volume === 0) {
    player.volume = 1;
    volSlider.value = "1";
  }
  syncMuteIcon();
});

volSlider.addEventListener("input", () => {
  player.volume = Number(volSlider.value);
  player.muted = player.volume === 0;
  wantAudio = !player.muted;
  syncMuteIcon();
});

settingsBtn.addEventListener("click", () => {
  const open = settingsPanel.classList.toggle("hidden");
  settingsBtn.setAttribute("aria-expanded", String(!open));
});

fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void videoShell.requestFullscreen?.();
});

player.addEventListener("play", syncPlayIcon);
player.addEventListener("pause", syncPlayIcon);

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

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
const chatGate = $("chat-gate");
const chatRoom = $("chat-room");
const chatLog = $("chat-log");
const chatNameForm = $<HTMLFormElement>("chat-name-form");
const chatNameInput = $<HTMLInputElement>("chat-name");
const chatForm = $<HTMLFormElement>("chat-form");
const chatInput = $<HTMLInputElement>("chat-input");
const chatPromptName = $("chat-prompt-name");
const emojiBtn = $<HTMLButtonElement>("emoji-btn");
const gifBtn = $<HTMLButtonElement>("gif-btn");
const emojiPanel = $("emoji-panel");
const gifPanel = $("gif-panel");
const gifForm = $<HTMLFormElement>("gif-form");
const gifUrl = $<HTMLInputElement>("gif-url");

const chatWs = (import.meta.env.VITE_CHAT_WS ?? "").trim() || null;
const chat = new ChatClient(chatWs);

function renderChat(msg: ChatMessage) {
  const row = document.createElement("div");
  row.className = `chat-line kind-${msg.kind}`;
  const ts = new Date(msg.at).toTimeString().slice(0, 8);
  if (msg.kind === "system") {
    row.textContent = `[${ts}] * ${msg.text}`;
  } else if (msg.kind === "gif") {
    const head = document.createElement("div");
    head.className = "chat-meta";
    head.textContent = `[${ts}] ${msg.name}>`;
    const img = document.createElement("img");
    img.src = msg.text;
    img.alt = "gif";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    row.append(head, img);
  } else {
    row.textContent = `[${ts}] ${msg.name}> ${msg.text}`;
  }
  chatLog.appendChild(row);
  while (chatLog.childElementCount > 300) chatLog.firstElementChild?.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function openChat(name: string) {
  saveChatName(name);
  chatGate.classList.add("hidden");
  chatRoom.classList.remove("hidden");
  chatPromptName.textContent = `${name}>`;
  chat.start(name, renderChat);
  chatInput.focus();
}

emojiPanel.innerHTML = "";
for (const e of EMOJI) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "emoji-cell";
  b.textContent = e;
  b.addEventListener("click", () => {
    chatInput.value += e;
    emojiPanel.classList.add("hidden");
    chatInput.focus();
  });
  emojiPanel.appendChild(b);
}

chatNameForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = chatNameInput.value.trim().replace(/\s+/g, " ");
  if (!name) return;
  openChat(name);
});

chatForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chat.send("text", text);
  chatInput.value = "";
});

emojiBtn.addEventListener("click", () => {
  emojiPanel.classList.toggle("hidden");
  gifPanel.classList.add("hidden");
});

gifBtn.addEventListener("click", () => {
  gifPanel.classList.toggle("hidden");
  emojiPanel.classList.add("hidden");
  if (!gifPanel.classList.contains("hidden")) gifUrl.focus();
});

gifForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const url = gifUrl.value.trim();
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad scheme");
  } catch {
    renderChat({ id: "err", name: "system", kind: "system", text: "gif url invalid", at: Date.now() });
    return;
  }
  chat.send("gif", url);
  gifUrl.value = "";
  gifPanel.classList.add("hidden");
});

const remembered = loadChatName();
if (remembered) {
  chatNameInput.value = remembered;
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
