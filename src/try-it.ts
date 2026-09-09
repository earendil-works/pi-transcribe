import { keyHint, rawKeyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  Text,
  truncateToWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { createMicrophoneCapture } from "./audio.js";
import { getCatalogModel } from "./catalog.js";
import { DictationController, type DictationControllerOptions } from "./dictation-controller.js";
import { microphoneSummary } from "./microphone-picker.js";
import { COMFORTABLE_REAL_TIME_FACTOR } from "./recommendations.js";
import type { TranscribeSettings } from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { TranscriptionService } from "./transcription-service.js";
import { TranscriptPreview } from "./transcript-preview.js";
import { editorBorder, PANEL_PADDING, panelBorder, paneRowBudget } from "./ui-components.js";
import { METER_UPDATE_MS, renderMeterLine, SpectrumAnalyzer } from "./visualizer.js";

type UiTheme = ExtensionContext["ui"]["theme"];

export type TryItResult =
  | { action: "done" }
  | { action: "skip" }
  | { action: "shortcut" }
  | { action: "microphone" }
  | { action: "model" };

/** Shorter takes are dominated by fixed costs and say little about speed. */
const MIN_SPEECH_SECONDS_TO_JUDGE = 5;

export function realTimeFactor(speechSeconds: number, transcribeSeconds: number): number {
  return speechSeconds / Math.max(transcribeSeconds, 0.05);
}

export function formatTryItTiming(
  speechSeconds: number,
  transcribeSeconds: number,
  modelName: string,
): string {
  const factor = realTimeFactor(speechSeconds, transcribeSeconds);
  return `${speechSeconds.toFixed(1)} s audio · ${transcribeSeconds.toFixed(1)} s to transcribe · ${factor.toFixed(1)}× real time · ${modelName}`;
}

export function needsFasterModel(speechSeconds: number, transcribeSeconds: number): boolean {
  return (
    speechSeconds >= MIN_SPEECH_SECONDS_TO_JUDGE &&
    realTimeFactor(speechSeconds, transcribeSeconds) < COMFORTABLE_REAL_TIME_FACTOR
  );
}

/** Presentation and navigation only; native resources belong to the controller. */
export class TryItPane implements Component {
  private readonly dictation: DictationController;
  private readonly analyzer = new SpectrumAnalyzer();
  private readonly preview = new TranscriptPreview();
  private nextPaintAt = 0;
  private disposed = false;
  private closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly settings: TranscribeSettings,
    service: Pick<TranscriptionService, "reserveDictation">,
    private readonly done: (result: TryItResult) => void,
    options: Pick<DictationControllerOptions, "createCapture" | "now"> = { createCapture: createMicrophoneCapture },
  ) {
    this.dictation = new DictationController(service, {
      ...options,
      onChange: () => this.refresh(),
      onFrame: (frame) => {
        this.analyzer.push(frame);
        const now = Date.now();
        if (now < this.nextPaintAt) return;
        this.nextPaintAt = now + METER_UPDATE_MS;
        this.refresh();
      },
    });
    this.dictation.prepare(settings);
  }

  private refresh(): void {
    if (!this.closed && !this.disposed) this.tui.requestRender();
  }

  invalidate(): void {
    this.preview.invalidate();
    this.refresh();
  }

  render(width: number): string[] {
    const state = this.dictation.state;
    const shortcut = displayShortcut(this.settings.shortcut);
    const modelName = getCatalogModel(this.settings.model.id)?.name ?? this.settings.model.id;
    const title = "Set up pi-transcribe · 3 of 3 · Try it";
    const fg = (color: Parameters<UiTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
    const text = (value: string) => new Text(value, PANEL_PADDING, 0).render(width);
    const line = (value: string) => truncateToWidth(` ${value}`, width);
    let status: string;
    let content = "";
    let nudge = "";
    if (state.phase === "listening") {
      status = renderMeterLine(this.theme, {
        bands: this.analyzer.bands, elapsedMs: this.dictation.elapsedMs,
        modelState: this.dictation.modelState,
      });
    } else if (state.phase === "transcribing") {
      status = fg("accent", "Transcribing…");
    } else if (state.phase === "starting") {
      status = fg("muted", "Starting microphone…");
    } else if (state.phase === "cancelling") {
      status = fg("muted", "Cancelling…");
    } else if (state.phase === "result") {
      const { text: transcript, speechSeconds, transcribeSeconds } = state.result;
      status = fg("muted", formatTryItTiming(speechSeconds, transcribeSeconds, modelName));
      content = transcript || fg("muted", "No speech detected");
      if (needsFasterModel(speechSeconds, transcribeSeconds)) {
        nudge = fg("warning", "Slow on this machine? Press c to try another model.");
      }
    } else if (state.phase === "error") {
      status = fg("error", state.stage === "model" ? "Could not load the model" : state.stage === "capture" ? "Microphone capture failed" : "Transcription failed");
      const message = state.cause instanceof Error ? state.cause.message : String(state.cause);
      content = fg("error", message);
      if (state.stage === "capture" && process.platform === "darwin") {
        content += "\nCheck System Settings → Privacy & Security → Microphone for your terminal app.";
      }
    } else {
      status = fg("muted", "Ready to listen");
    }
    this.preview.setText(content);

    let hints: string;
    if (state.phase === "listening") {
      hints = `${rawKeyHint(shortcut, "stop")}  ${keyHint("tui.select.cancel", "discard")}`;
    } else if (
      state.phase === "transcribing" ||
      state.phase === "starting" ||
      state.phase === "cancelling"
    ) {
      hints = keyHint("tui.select.cancel", "cancel");
    } else if (state.phase === "result") {
      hints = `${keyHint("tui.select.confirm", "looks good")}  ${rawKeyHint(shortcut, "try again")}`;
    } else {
      hints = `${rawKeyHint(shortcut, state.phase === "error" ? "try again" : "record")}  ${keyHint("tui.select.cancel", "skip")}`;
    }

    const setting = (label: string, value: string, key: string, compact: boolean) => {
      const suffix = ` (${key} to change)`;
      const body = compact
        ? truncateToWidth(`${label}: ${value}`, Math.max(1, width - 2 - suffix.length))
        : `${label}: ${value}`;
      return fg("muted", body) + fg("dim", suffix);
    };
    const header = (compact: boolean): string[] => {
      const render = compact ? (value: string) => [line(value)] : text;
      return [
        ...panelBorder(this.theme).render(width),
        ...(compact ? [] : [""]),
        ...render(fg("accent", this.theme.bold(title))),
        ...(!compact && process.platform === "darwin"
          ? text(fg("muted", "macOS will ask for microphone access the first time. Your terminal may need to be restarted.")) : []),
        ...(compact ? [] : [""]),
        ...render(setting("Shortcut", shortcut, "s", compact)),
        ...render(setting("Microphone", microphoneSummary(this.settings.microphone), "m", compact)),
        ...render(setting("Model", modelName, "c", compact)),
        ...(compact ? [] : [""]),
        ...render(compact ? `${shortcut} starts/stops recording` : `Press ${shortcut} to start recording. Press it again to stop.`),
        ...(compact ? [] : [""]),
        ...render(status),
        ...(nudge ? render(nudge) : []),
      ];
    };
    const budget = Math.max(1, paneRowBudget(this.tui) ?? 32);
    let top = header(false);
    let bottom = ["", ...text(hints), "", ...panelBorder(this.theme).render(width)];
    // Reserve a useful preview, not merely whatever is left after wrapped metadata.
    const previewReserve = state.phase === "result" || state.phase === "error" ? 5 : 3;
    if (top.length + bottom.length + previewReserve > budget) {
      top = header(true);
      bottom = [...text(hints), ...panelBorder(this.theme).render(width)];
    }
    if (top.length + bottom.length + 3 > budget) {
      // Tiny terminals: drop optional metadata, never the result or action keys.
      top = [line(fg("accent", title)), line(status)];
    }
    const rule = budget >= 6 ? editorBorder(this.theme).render(width) : [];
    bottom = bottom.slice(0, Math.max(0, budget - rule.length * 2 - 1));
    top = top.slice(0, Math.max(0, budget - bottom.length - rule.length * 2 - 1));
    const available = Math.max(1, budget - top.length - bottom.length - rule.length * 2);
    return [
      ...top, ...rule,
      ...this.preview.render(width, available, (value) => fg("dim", value)),
      ...rule, ...bottom,
    ];
  }

  private start(): void {
    this.preview.setText("");
    this.analyzer.reset();
    this.nextPaintAt = 0;
    void this.dictation.start(this.settings);
  }

  private leave(result: TryItResult): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    void this.dictation.dispose();
    this.done(result);
  }
  handleInput(data: string): void {
    if (this.closed || this.disposed) return;
    const phase = this.dictation.state.phase;
    if (matchesKey(data, this.settings.shortcut as Parameters<typeof matchesKey>[1])) {
      if (phase === "listening") {
        void this.dictation.stop();
      } else if (["idle", "ready", "result", "error"].includes(phase)) {
        this.start();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (["starting", "listening", "transcribing", "cancelling"].includes(phase)) {
        void this.dictation.cancel();
      } else {
        this.leave({ action: phase === "result" ? "done" : "skip" });
      }
      return;
    }
    if (!["idle", "ready", "result", "error"].includes(phase)) return;
    if ((phase === "result" || phase === "error") && this.preview.handleInput(data, this.keybindings)) {
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (phase === "result") this.leave({ action: "done" });
      return;
    }
    if (data.toLowerCase() === "m") {
      this.leave({ action: "microphone" });
    } else if (data.toLowerCase() === "s") {
      this.leave({ action: "shortcut" });
    } else if (data.toLowerCase() === "c") {
      this.leave({ action: "model" });
    }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.dictation.dispose();
  }
}

export async function tryVoice(ctx: ExtensionContext, settings: TranscribeSettings): Promise<TryItResult | undefined> {
  const service = new TranscriptionService();
  let pane: TryItPane | undefined;
  try {
    return await ctx.ui.custom<TryItResult>((tui, theme, keybindings, done) =>
      (pane = new TryItPane(tui, theme, keybindings, settings, service, done)),
    );
  } finally {
    await pane?.dispose();
    await service.shutdown();
  }
}
