/**
 * Broadcaster send-level: raw mic → GainNode → MediaStreamDestination.
 * The destination track is what WHIP publishes; browser AGC stays off.
 */

const FLOOR_DB = -60;

export function percentToLinear(percent: number): number {
  return Math.max(0, percent) / 100;
}

export function linearToDb(linear: number): number {
  if (linear <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(linear));
}

export function formatGainReadout(percent: number): string {
  const linear = percentToLinear(percent);
  if (linear <= 0) return "0% / -inf dB";
  const db = linearToDb(linear);
  const sign = db > 0 ? "+" : "";
  return `${Math.round(percent)}% / ${sign}${db.toFixed(1)} dB`;
}

export class SendGain {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private rawAudio: MediaStreamTrack | null = null;
  private processed: MediaStreamTrack | null = null;

  get track(): MediaStreamTrack | null {
    return this.processed;
  }

  async attach(rawAudio: MediaStreamTrack, linearGain: number): Promise<MediaStreamTrack> {
    // Stop the previous raw capture + graph before wiring a new mic track.
    this.detach();
    this.rawAudio = rawAudio;

    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);

    this.source = ctx.createMediaStreamSource(new MediaStream([rawAudio]));
    this.gain = ctx.createGain();
    this.gain.gain.value = Math.max(0, linearGain);
    this.dest = ctx.createMediaStreamDestination();
    // Keep channel count when the device is stereo (destination defaults to stereo).
    this.source.connect(this.gain);
    this.gain.connect(this.dest);

    const [out] = this.dest.stream.getAudioTracks();
    if (!out) throw new Error("send gain produced no audio track");
    if ("contentHint" in out) out.contentHint = "music";
    this.processed = out;
    return out;
  }

  setGain(linear: number): void {
    if (!this.gain || !this.ctx) return;
    this.gain.gain.setTargetAtTime(Math.max(0, linear), this.ctx.currentTime, 0.02);
  }

  /** Tear down the graph. By default also stops the raw capture track. */
  detach(opts: { stopRaw?: boolean } = {}): void {
    const stopRaw = opts.stopRaw !== false;
    this.source?.disconnect();
    this.gain?.disconnect();
    this.dest?.disconnect();
    this.processed?.stop();
    if (stopRaw) this.rawAudio?.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.dest = null;
    this.rawAudio = null;
    this.processed = null;
  }
}
