import { Loader } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPTURE_SAMPLE_RATE } from "./audio.js";

const WIDGET_KEY = "pi-transcribe-meter";
const UPDATE_MS = 50;
const LEVEL_GAIN = 36;
const DECAY = 0.65;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const BAND_EDGES_HZ = [80, 160, 250, 400, 650, 1000, 1600, 2500, 4000, 6000] as const;

function floorPowerOfTwo(value: number): number {
  return 2 ** Math.floor(Math.log2(value));
}

function radix2Fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let index = 1, reversed = 0; index < n; index += 1) {
    let bit = n >> 1;
    while ((reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      const reTmp = re[index] ?? 0;
      re[index] = re[reversed] ?? 0;
      re[reversed] = reTmp;
      const imTmp = im[index] ?? 0;
      im[index] = im[reversed] ?? 0;
      im[reversed] = imTmp;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let twiddleRe = 1;
      let twiddleIm = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddRe = (re[odd] ?? 0) * twiddleRe - (im[odd] ?? 0) * twiddleIm;
        const oddIm = (re[odd] ?? 0) * twiddleIm + (im[odd] ?? 0) * twiddleRe;
        const evenRe = re[even] ?? 0;
        const evenIm = im[even] ?? 0;
        re[even] = evenRe + oddRe;
        im[even] = evenIm + oddIm;
        re[odd] = evenRe - oddRe;
        im[odd] = evenIm - oddIm;
        const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
        twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
        twiddleRe = nextRe;
      }
    }
  }
}

function bandEnergies(frame: Int16Array, re: Float64Array, im: Float64Array): number[] {
  const n = re.length;
  if (n < 2) return BAND_EDGES_HZ.slice(0, -1).map(() => 0);

  re.fill(0);
  im.fill(0);
  for (let index = 0; index < n; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (n - 1));
    re[index] = ((frame[index] ?? 0) / 32_768) * window;
  }
  radix2Fft(re, im);

  const bands: number[] = [];
  for (let band = 0; band < BAND_EDGES_HZ.length - 1; band += 1) {
    const start = Math.max(1, Math.floor((BAND_EDGES_HZ[band]! * n) / CAPTURE_SAMPLE_RATE));
    const end = Math.min(
      n / 2,
      Math.ceil((BAND_EDGES_HZ[band + 1]! * n) / CAPTURE_SAMPLE_RATE),
    );
    let peak = 0;
    for (let bin = start; bin < end; bin += 1) {
      peak = Math.max(peak, Math.hypot(re[bin] ?? 0, im[bin] ?? 0));
    }
    bands.push(peak / n);
  }
  return bands;
}

function blockForLevel(level: number): string {
  const normalized = Math.min(1, Math.max(0, level) * LEVEL_GAIN);
  const index = Math.min(
    BLOCKS.length - 1,
    Math.round(Math.sqrt(normalized) * (BLOCKS.length - 1)),
  );
  return BLOCKS[index] ?? "▁";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function showTranscribeStatus(
  ctx: ExtensionContext,
  text: string,
  options?: { cancelable?: boolean },
): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  const hint = options?.cancelable ? `  ${theme.fg("dim", "esc to cancel")}` : "";
  ctx.ui.setWidget(WIDGET_KEY, [`${theme.fg("muted", text)}${hint}`]);
}

/** Loader that stops its animation when the widget is disposed (pi's own pattern). */
class ProgressLoader extends Loader {
  dispose(): void {
    this.stop();
  }
}

/**
 * Shows an animated progress widget (pi's Loader component); call the returned
 * function to stop and remove it.
 */
export function showTranscribeProgress(
  ctx: ExtensionContext,
  label: string,
  options?: { cancelable?: boolean },
): () => void {
  if (!ctx.hasUI) return () => undefined;
  const hint = options?.cancelable ? "  esc to cancel" : "";
  ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
    const loader = new ProgressLoader(
      tui,
      (spinner) => theme.fg("muted", spinner),
      (text) => theme.fg("muted", text),
      `${label}${hint}`,
    );
    loader.start();
    return loader;
  });
  return () => ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function clearTranscribeWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/** Left-to-right FFT meter shown above the editor while recording. */
export class RecordingMeter {
  private readonly bands = Array.from({ length: BAND_EDGES_HZ.length - 1 }, () => 0);
  private re: Float64Array | undefined;
  private im: Float64Array | undefined;
  private startedAt = 0;
  private nextPaintAt = 0;
  private lastLine: string | undefined;
  private ctx: ExtensionContext | undefined;
  private modelState: "loading" | "ready" | "failed" = "loading";

  start(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    this.ctx = ctx;
    this.startedAt = Date.now();
    this.bands.fill(0);
    this.re = undefined;
    this.im = undefined;
    this.nextPaintAt = 0;
    this.lastLine = undefined;
    this.modelState = "loading";
    this.paint();
  }

  setModelState(state: "loading" | "ready" | "failed"): void {
    this.modelState = state;
    this.paint();
  }

  push(frame: Int16Array): void {
    if (!this.ctx) return;
    const n = floorPowerOfTwo(frame.length);
    if (!this.re || !this.im || this.re.length !== n) {
      this.re = new Float64Array(n);
      this.im = new Float64Array(n);
    }
    const energies = bandEnergies(frame, this.re, this.im);
    for (let index = 0; index < this.bands.length; index += 1) {
      this.bands[index] = Math.max(energies[index] ?? 0, (this.bands[index] ?? 0) * DECAY);
    }
    const now = Date.now();
    if (now < this.nextPaintAt) return;
    this.nextPaintAt = now + UPDATE_MS;
    this.paint();
  }

  stop(): void {
    this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
    this.ctx = undefined;
    this.lastLine = undefined;
  }

  private paint(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const theme = ctx.ui.theme;
    const parts = [
      theme.fg("accent", this.bands.map(blockForLevel).join("")),
      theme.fg("muted", formatElapsed(Date.now() - this.startedAt)),
    ];
    if (this.modelState === "loading") parts.push(theme.fg("dim", "loading model"));
    if (this.modelState === "failed") parts.push(theme.fg("warning", "model load failed"));
    parts.push(theme.fg("dim", "esc to cancel"));
    const line = parts.join("  ");
    if (line === this.lastLine) return;
    this.lastLine = line;
    ctx.ui.setWidget(WIDGET_KEY, [line]);
  }
}
