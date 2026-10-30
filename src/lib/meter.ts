/**
 * Stereo level meter + optional local monitor, drawn on a <canvas>.
 * The AudioContext is also what lets us toggle "listen to the input" without
 * touching the MediaStream that goes to WebRTC.
 */
export interface MeterReading {
  rmsDb: [number, number];
  peakDb: [number, number];
  clipped: [boolean, boolean];
}

const FLOOR_DB = -60;

export class StereoMeter {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private analysers: [AnalyserNode, AnalyserNode] | null = null;
  private monitorGain: GainNode | null = null;
  private buf = new Float32Array(2048);
  private raf = 0;
  private peakHold: [number, number] = [FLOOR_DB, FLOOR_DB];
  private peakHoldAt: [number, number] = [0, 0];
  private clipUntil: [number, number] = [0, 0];
  private last: MeterReading = {
    rmsDb: [FLOOR_DB, FLOOR_DB],
    peakDb: [FLOOR_DB, FLOOR_DB],
    clipped: [false, false],
  };
  private onReading: ((r: MeterReading) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get sampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  get reading(): MeterReading {
    return this.last;
  }

  async attach(stream: MediaStream, onReading?: (r: MeterReading) => void): Promise<void> {
    this.detach();
    this.onReading = onReading ?? null;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);

    // Analyse only the audio tracks; a stream with video confuses nothing but keeps it tidy.
    const audioOnly = new MediaStream(stream.getAudioTracks());
    this.source = ctx.createMediaStreamSource(audioOnly);
    this.splitter = ctx.createChannelSplitter(2);
    const mk = () => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;
      return a;
    };
    this.analysers = [mk(), mk()];
    this.source.connect(this.splitter);
    this.splitter.connect(this.analysers[0], 0);
    this.splitter.connect(this.analysers[1], 1);

    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.source.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    this.loop();
  }

  setMonitor(on: boolean): void {
    if (!this.monitorGain || !this.ctx) return;
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.source?.disconnect();
    this.splitter?.disconnect();
    this.analysers?.forEach((a) => a.disconnect());
    this.monitorGain?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.source = null;
    this.splitter = null;
    this.analysers = null;
    this.monitorGain = null;
    this.draw();
  }

  private measure(): MeterReading {
    if (!this.analysers) return this.last;
    const now = performance.now();
    const rmsDb: [number, number] = [FLOOR_DB, FLOOR_DB];
    const peakDb: [number, number] = [FLOOR_DB, FLOOR_DB];
    const clipped: [boolean, boolean] = [false, false];
    for (let ch = 0; ch < 2; ch++) {
      const a = this.analysers[ch];
      a.getFloatTimeDomainData(this.buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const v = this.buf[i];
        sum += v * v;
        const av = Math.abs(v);
        if (av > peak) peak = av;
      }
      const rms = Math.sqrt(sum / this.buf.length);
      rmsDb[ch] = toDb(rms);
      const pDb = toDb(peak);
      if (peak >= 0.999) this.clipUntil[ch] = now + 1500;
      clipped[ch] = now < this.clipUntil[ch];
      // Peak hold: hold 1.2s, then fall 20 dB/s.
      if (pDb >= this.peakHold[ch]) {
        this.peakHold[ch] = pDb;
        this.peakHoldAt[ch] = now;
      } else if (now - this.peakHoldAt[ch] > 1200) {
        this.peakHold[ch] = Math.max(FLOOR_DB, this.peakHold[ch] - 20 / 60);
      }
      peakDb[ch] = this.peakHold[ch];
    }
    this.last = { rmsDb, peakDb, clipped };
    return this.last;
  }

  private loop = (): void => {
    const r = this.measure();
    this.draw(r);
    this.onReading?.(r);
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(r?: MeterReading): void {
    const c = this.canvas;
    const g = c.getContext("2d");
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600;
    const h = c.clientHeight || 56;
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue("--fg").trim() || "#33ff33";
    const dim = css.getPropertyValue("--fg-dim").trim() || "#1f9a1f";
    const faint = css.getPropertyValue("--fg-faint").trim() || "#0d4d0d";
    const bright = css.getPropertyValue("--fg-bright").trim() || "#b6ffb6";
    const danger = css.getPropertyValue("--danger").trim() || "#ff3b3b";

    const labelW = 18;
    const barX = labelW + 6;
    const barW = w - barX - 6;
    const rowH = h / 2;
    const segs = 48;
    const segW = barW / segs;
    g.font = "12px ui-monospace, Menlo, Consolas, monospace";
    g.textBaseline = "middle";

    for (let ch = 0; ch < 2; ch++) {
      const y = ch * rowH + 4;
      const bh = rowH - 8;
      g.fillStyle = dim;
      g.fillText(ch === 0 ? "L" : "R", 4, y + bh / 2);

      const rms = r ? r.rmsDb[ch] : FLOOR_DB;
      const peak = r ? r.peakDb[ch] : FLOOR_DB;
      const litSegs = Math.round(((rms - FLOOR_DB) / -FLOOR_DB) * segs);
      const peakSeg = Math.round(((peak - FLOOR_DB) / -FLOOR_DB) * segs);

      for (let s = 0; s < segs; s++) {
        const x = barX + s * segW;
        const segDb = FLOOR_DB + (s / segs) * -FLOOR_DB;
        let color = faint;
        if (s < litSegs) color = segDb > -6 ? bright : segDb > -18 ? fg : dim;
        if (s === peakSeg - 1 && peak > FLOOR_DB) color = bright;
        g.fillStyle = color;
        g.fillRect(x + 1, y, Math.max(1, segW - 2), bh);
      }
      if (r?.clipped[ch]) {
        g.fillStyle = danger;
        g.fillRect(barX + barW - 4, y, 4, bh);
      }
    }
  }
}

export function toDb(lin: number): number {
  if (lin <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(lin));
}

export function fmtDb(db: number): string {
  if (db <= FLOOR_DB) return "-inf";
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
}
