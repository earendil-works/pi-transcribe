import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { displayLanguage, getCatalogModel } from "./catalog.js";
import { DictationController } from "./dictation-controller.js";
import type { TranscribeSettings } from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { TranscriptionService } from "./transcription-service.js";
import type { RecordingMeter } from "./visualizer.js";

type ActiveRecording = {
  dictation: DictationController;
  meter: RecordingMeter;
};

export type PiTranscribeRuntime = {
  readonly service: TranscriptionService;
  requireConfiguredSettingsForTool(): Promise<TranscribeSettings>;
  toggleCapture(ctx: ExtensionContext): Promise<void>;
  showSettings(ctx: ExtensionCommandContext): Promise<void>;
  replayOnboarding(ctx: ExtensionCommandContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
};

function isMicrophoneUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === "MicrophoneUnavailableError";
}

function captureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHelp =
    process.platform === "darwin" && !isMicrophoneUnavailableError(error)
      ? " Check System Settings → Privacy & Security → Microphone for your terminal app."
      : "";
  return `Microphone capture failed: ${message}${permissionHelp}`;
}

function transcriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Local transcription failed: ${message}`;
}

export function createPiTranscribeRuntime(
  pi: ExtensionAPI,
  registeredShortcut: string,
): PiTranscribeRuntime {
  let recording: ActiveRecording | undefined;
  let operation: Promise<void> | undefined;
  let dictation: DictationController | undefined;
  let shuttingDown = false;
  let stopListening: (() => void) | undefined;
  let settings: TranscribeSettings | undefined;
  let settingsLoaded = false;
  let settingsReadWarning: string | undefined;
  let settingsWarningShown = false;
  let audioModulePromise: Promise<typeof import("./audio.js")> | undefined;
  let visualizerModulePromise: Promise<typeof import("./visualizer.js")> | undefined;
  const transcriptionService = new TranscriptionService();

  function loadAudio(): Promise<typeof import("./audio.js")> {
    return (audioModulePromise ??= import("./audio.js"));
  }

  function loadVisualizer(): Promise<typeof import("./visualizer.js")> {
    return (visualizerModulePromise ??= import("./visualizer.js"));
  }

  async function reportCaptureError(ctx: ExtensionContext, error: unknown): Promise<void> {
    ctx.ui.notify(captureErrorMessage(error), "error");
    if (!isMicrophoneUnavailableError(error)) {
      const { offerMacOSPermissionHelp } = await import("./settings-menu.js");
      await offerMacOSPermissionHelp(pi, ctx);
    }
  }

  function rememberSettings(configured: TranscribeSettings): void {
    settings = configured;
    settingsLoaded = true;
    settingsReadWarning = undefined;
  }

  async function loadSettingsOnce(): Promise<void> {
    if (settingsLoaded) return;
    const { readSettings } = await import("./settings.js");
    const result = await readSettings();
    settingsLoaded = true;
    settings = result.settings;
    settingsReadWarning = result.warning;
  }

  async function configureFirstRun(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    const { runOnboarding } = await import("./onboarding.js");
    const configured = await runOnboarding(ctx, registeredShortcut);
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function configureModel(
    ctx: ExtensionContext,
    previous: TranscribeSettings,
  ): Promise<TranscribeSettings | undefined> {
    const { runModelSelection } = await import("./onboarding.js");
    const configured = await runModelSelection(ctx, {
      shortcut: previous.shortcut,
      preferredLanguages: previous.preferredLanguages,
      transcriptionLanguage: previous.transcriptionLanguage,
      chineseOutput: previous.chineseOutput,
      currentModelId: previous.model.id,
      microphone: previous.microphone,
      postActivation: "advance",
    });
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function ensureSettings(
    ctx: ExtensionContext,
  ): Promise<{ configured?: TranscribeSettings; completedFirstRun: boolean }> {
    await loadSettingsOnce();
    if (settingsReadWarning && !settingsWarningShown) {
      settingsWarningShown = true;
      ctx.ui.notify(settingsReadWarning, "warning");
    }

    if (settings && existsSync(settings.model.path)) {
      return { configured: settings, completedFirstRun: false };
    }

    const previous = settings;
    if (settings) {
      ctx.ui.notify(
        `Configured model file is missing: ${settings.model.path}. Choose a model again; nothing will be downloaded without confirmation.`,
        "warning",
      );
      settings = undefined;
    }

    const configured = previous
      ? await configureModel(ctx, previous)
      : await configureFirstRun(ctx);
    if (configured) {
      const model = getCatalogModel(configured.model.id);
      const languages = configured.preferredLanguages.map(displayLanguage).join(", ");
      // Pi binds shortcuts at extension load. The command path reloads on its
      // own; the shortcut path cannot, so say what it takes to use a new one.
      const talk = configured.shortcut === registeredShortcut
        ? `${displayShortcut(configured.shortcut)} to talk`
        : `run /reload, then ${displayShortcut(configured.shortcut)} to talk`;
      ctx.ui.notify(
        `✓ pi-transcribe ready · ${talk}\n${languages} · ${model?.name ?? configured.model.id} · /transcribe for settings`,
        "info",
      );
    }
    return { configured, completedFirstRun: previous === undefined && configured !== undefined };
  }

  async function requireConfiguredSettingsForTool(): Promise<TranscribeSettings> {
    await loadSettingsOnce();
    if (settingsReadWarning) {
      throw new Error(
        `${settingsReadWarning} Ask the user to run /transcribe in Pi's interactive TUI to configure a local model, then retry transcribe_file.`,
      );
    }
    if (!settings) {
      throw new Error(
        "pi-transcribe is not configured. Ask the user to run /transcribe in Pi's interactive TUI once to choose and download a local model, then retry transcribe_file.",
      );
    }
    if (!existsSync(settings.model.path)) {
      throw new Error(
        `The configured transcription model is missing: ${settings.model.path}. Ask the user to run /transcribe and choose a model again, then retry transcribe_file.`,
      );
    }
    return settings;
  }

  function listenForCancel(ctx: ExtensionContext): void {
    stopListening?.();
    if (!ctx.hasUI) return;
    stopListening = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape")) return;
      if (recording) {
        void runExclusive(ctx, () => cancelRecording(ctx));
        return { consume: true };
      }
      if (dictation?.state.phase === "transcribing") {
        void dictation.cancel();
        ctx.ui.notify("Transcription cancelled", "info");
        return { consume: true };
      }
      if (dictation?.state.phase === "cancelling") return { consume: true };
    });
  }

  function clearCancelListener(): void {
    stopListening?.();
    stopListening = undefined;
  }

  async function cancelRecording(ctx: ExtensionContext): Promise<void> {
    const active = recording;
    if (!active) return;
    recording = undefined;
    active.meter.stop();
    await active.dictation.dispose();
    if (dictation === active.dictation) dictation = undefined;
    clearCancelListener();
    if (!shuttingDown) ctx.ui.notify("Recording discarded", "info");
  }

  async function reportDictationError(ctx: ExtensionContext, controller: DictationController): Promise<void> {
    const state = controller.state;
    if (state.phase !== "error" || shuttingDown) return;
    if (state.stage === "capture") await reportCaptureError(ctx, state.cause);
    else ctx.ui.notify(transcriptionErrorMessage(state.cause), "error");
  }

  async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
    const { clearTranscribeWidget, showTranscribeStatus } = await loadVisualizer();
    const active = recording!;
    recording = undefined;
    active.meter.stop({ clearWidget: false });
    showTranscribeStatus(ctx, "Transcribing…", { cancelable: true });
    try {
      const result = await active.dictation.stop();
      if (shuttingDown) return;
      if (!result) {
        await reportDictationError(ctx, active.dictation);
      } else if (result.text) {
        ctx.ui.pasteToEditor(result.text);
        ctx.ui.notify(`Transcribed ${result.speechSeconds.toFixed(1)}s of audio`, "info");
      } else {
        ctx.ui.notify(`No speech detected in ${result.speechSeconds.toFixed(1)}s of audio`, "warning");
      }
    } finally {
      await active.dictation.dispose();
      if (dictation === active.dictation) dictation = undefined;
      clearCancelListener();
      clearTranscribeWidget(ctx);
    }
  }

  async function startRecording(
    ctx: ExtensionContext,
    configured: TranscribeSettings,
  ): Promise<void> {
    const { createMicrophoneCapture, testMicrophonePermission } = await loadAudio();
    if (process.platform === "darwin") {
      const micStatus = await testMicrophonePermission();
      if (micStatus.status === "denied") {
        const openSettings = await ctx.ui.confirm(
          "Microphone access",
          "Microphone access is denied in System Settings. Open Privacy & Security → Microphone settings?",
        );
        if (openSettings) {
          const { openMacOSMicrophoneSettings } = await import("./settings-menu.js");
          await openMacOSMicrophoneSettings(pi, ctx);
        }
        return;
      }
    }
    const { RecordingMeter } = await loadVisualizer();
    if (shuttingDown) return;
    const meter = new RecordingMeter();
    const controller = new DictationController(transcriptionService, {
      createCapture: createMicrophoneCapture,
      onFrame: (frame) => meter.push(frame),
      onChange: () => meter.setModelState(controller.modelState),
    });
    dictation = controller;
    try {
      // Paint startup feedback before opening the native device blocks the loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (shuttingDown) return;
      await controller.start(configured);
      if (controller.state.phase !== "listening") {
        await reportDictationError(ctx, controller);
        return;
      }
      meter.start(ctx);
      meter.setModelState(controller.modelState);
      recording = { dictation: controller, meter };
      listenForCancel(ctx);
      ctx.ui.notify("Microphone recording started", "info");
    } catch (error) {
      recording = undefined;
      meter.stop();
      clearCancelListener();
      ctx.ui.notify(`Recording failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (recording?.dictation !== controller) {
        await controller.dispose();
        if (dictation === controller) dictation = undefined;
      }
    }
  }

  async function toggleCaptureTask(ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;
    if (recording) {
      await stopAndTranscribe(ctx);
      return;
    }

    // First-press module loading and microphone initialization take a
    // noticeable moment; show feedback until the recording meter takes over.
    // Static text on the shared widget slot: an animated spinner repaints every
    // frame, and the meter replaces plain lines without a component swap.
    const { clearTranscribeWidget, showTranscribeStatus } = await loadVisualizer();
    await loadSettingsOnce();
    if (settings && existsSync(settings.model.path)) {
      showTranscribeStatus(ctx, "Starting microphone…");
    } else {
      // Setup panes replace only the editor, so a status line set here or by
      // the first-press handler in index.ts would sit above every setup step.
      clearTranscribeWidget(ctx);
    }

    const { configured, completedFirstRun } = await ensureSettings(ctx);
    if (configured && !completedFirstRun) await startRecording(ctx, configured);
    // The meter shares the widget slot and has replaced the spinner when
    // recording began; clear the spinner only when recording never started.
    if (!recording) clearTranscribeWidget(ctx);
  }

  function runExclusive(
    ctx: ExtensionContext,
    task: () => Promise<void>,
  ): Promise<void> {
    if (operation) {
      ctx.ui.notify("A pi-transcribe operation is already in progress", "warning");
      return operation;
    }

    const nextOperation = task().finally(() => {
      if (operation === nextOperation) operation = undefined;
    });
    operation = nextOperation;
    return nextOperation;
  }

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    await runExclusive(ctx, () => toggleCaptureTask(ctx));
  }

  async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
    if (recording) {
      ctx.ui.notify(
        `Stop recording with ${displayShortcut(registeredShortcut)} before opening settings`,
        "warning",
      );
      return;
    }

    let reload = false;
    await runExclusive(ctx, async () => {
      await loadSettingsOnce();
      const hadConfiguration = Boolean(settings && existsSync(settings.model.path));
      const { configured } = await ensureSettings(ctx);
      if (!configured) return;
      if (!hadConfiguration) {
        // First-run setup ends on its Ready message rather than falling
        // straight through into the regular settings menu.
        reload = configured.shortcut !== registeredShortcut;
        return;
      }
      const { showSettingsMenu } = await import("./settings-menu.js");
      reload = await showSettingsMenu(pi, ctx, configured, registeredShortcut);
    });
    if (reload) {
      await ctx.reload();
    }
  }

  async function replayOnboarding(ctx: ExtensionCommandContext): Promise<void> {
    if (recording) {
      ctx.ui.notify(
        `Stop recording with ${displayShortcut(registeredShortcut)} before replaying onboarding`,
        "warning",
      );
      return;
    }

    await runExclusive(ctx, async () => {
      await loadSettingsOnce();
      const { runOnboarding } = await import("./onboarding.js");
      const configured = await runOnboarding(
        ctx,
        settings?.shortcut ?? registeredShortcut,
      );
      if (!configured) return;
      rememberSettings(configured);
      ctx.ui.notify("Onboarding replay complete", "info");
    });
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    shuttingDown = true;
    const disposal = dictation?.dispose();
    recording?.meter.stop();
    clearCancelListener();
    await Promise.all([
      disposal,
      operation?.catch(() => undefined),
      transcriptionService.shutdown().catch(() => undefined),
    ]);
    recording = undefined;
    dictation = undefined;
    if (visualizerModulePromise) {
      const visualizer = await visualizerModulePromise.catch(() => undefined);
      visualizer?.clearTranscribeWidget(ctx);
    }
  }

  return {
    service: transcriptionService,
    requireConfiguredSettingsForTool,
    toggleCapture,
    showSettings,
    replayOnboarding,
    shutdown,
  };
}
