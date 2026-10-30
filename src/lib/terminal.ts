/** Append-only on-page log that mirrors to the console. */
export type LogLevel = "info" | "ok" | "err" | "bright";

export function createLog(el: HTMLElement) {
  const max = 400;
  const stamp = () => new Date().toTimeString().slice(0, 8);
  return (msg: string, level: LogLevel = "info"): void => {
    const line = document.createElement("div");
    line.className = `l-${level}`;
    line.textContent = `[${stamp()}] ${level === "err" ? "!" : ">"} ${msg}`;
    el.appendChild(line);
    while (el.childElementCount > max) el.firstElementChild?.remove();
    el.scrollTop = el.scrollHeight;
    (level === "err" ? console.error : console.log)(`[dj-stream] ${msg}`);
  };
}

export type Logger = ReturnType<typeof createLog>;

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function fmtKbps(bps: number): string {
  return `${Math.round(bps / 1000)} kbps`;
}
