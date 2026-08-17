import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import {
  CAPTURE_SAMPLE_RATE,
  MicrophoneCapture,
  MicrophoneUnavailableError,
  testMicrophonePermission,
} from "./audio.js";
import { runModelSelection, runOnboarding } from "./onboarding.js";
import {
  readSettings,
  readShortcutForRegistration,
  type CleanupModelSetting,
  type TranscribeSettings,
} from "./settings.js";
import {
  generateGlossary,
  offerMacOSPermissionHelp,
  openMacOSMicrophoneSettings,
  showSettingsMenu,
} from "./settings-menu.js";
import { displayShortcut } from "./shortcuts.js";
import { TranscribeCppBackend, type TranscriptionBackend } from "./transcription.js";
import {
  clearTranscribeWidget,
  RecordingMeter,
  showTranscribeProgress,
  showTranscribeStatus,
} from "./visualizer.js";
import { cleanupWithLlm } from "./cleanup.js";
import { readGlossary } from "./glossary.js";

type ActiveRecording = {
  capture: MicrophoneCapture;
  backend: TranscriptionBackend;
  preparation: Promise<void>;
  meter: RecordingMeter;
  cleanupModel: CleanupModelSetting;
  glossary: string[];
  editorTextAtStart: string;
};

function captureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHelp =
    process.platform === "darwin" && !(error instanceof MicrophoneUnavailableError)
      ? " Check System Settings → Privacy & Security → Microphone for your terminal app."
      : "";
  return `Microphone capture failed: ${message}${permissionHelp}`;
}

function transcriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Local transcription failed: ${message}`;
}

export default function piTranscribe(pi: ExtensionAPI): void {
  const registeredShortcut = readShortcutForRegistration();
  let recording: ActiveRecording | undefined;
  let operation: Promise<void> | undefined;
  let transcriptionAbort: AbortController | undefined;
  let glossaryAbort: AbortController | undefined;
  let shuttingDown = false;
  let stopListening: (() => void) | undefined;
  let cleanupUnavailableNotified = false;
  let cleanupFailedNotified = false;
  let settings: TranscribeSettings | undefined;
  let settingsLoaded = false;
  let settingsWarningShown = false;

  function rememberSettings(configured: TranscribeSettings): void {
    settings = configured;
    settingsLoaded = true;
  }

  async function configureFirstRun(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    const configured = await runOnboarding(ctx, registeredShortcut);
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function configureModel(
    ctx: ExtensionContext,
    previous: TranscribeSettings,
  ): Promise<TranscribeSettings | undefined> {
    const configured = await runModelSelection(ctx, {
      shortcut: previous.shortcut,
      preferredLanguages: previous.preferredLanguages,
      transcriptionLanguage: previous.transcriptionLanguage,
      chineseOutput: previous.chineseOutput,
      currentModelId: previous.model.id,
      microphone: previous.microphone,
      cleanupModel: previous.cleanupModel,
    });
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function ensureSettings(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    if (!settingsLoaded) {
      const result = await readSettings();
      settingsLoaded = true;
      settings = result.settings;
      if (result.warning && !settingsWarningShown) {
        settingsWarningShown = true;
        ctx.ui.notify(result.warning, "warning");
      }
    }

    if (settings && existsSync(settings.model.path)) return settings;

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
      ctx.ui.notify(
        `Setup complete. Press ${displayShortcut(registeredShortcut)} to start recording and press it again to transcribe. Use /transcribe for settings.`,
        "info",
      );
    }
    return configured;
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
      if (transcriptionAbort) {
        if (transcriptionAbort.signal.aborted) return;
        transcriptionAbort.abort();
        ctx.ui.notify("Transcription cancelled", "info");
        return { consume: true };
      }
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
    try {
      await active.capture.stop();
    } catch {
      // Discarded either way.
    } finally {
      await active.backend.dispose().catch(() => undefined);
      clearCancelListener();
      ctx.ui.notify("Recording discarded", "info");
    }
  }

  async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
    const active = recording!;
    recording = undefined;
    active.meter.stop();
    showTranscribeStatus(ctx, "finishing capture");

    try {
      let pcm: Float32Array;
      try {
        const audio = await active.capture.stop();
        pcm = audio.pcm;
      } catch (error) {
        ctx.ui.notify(captureErrorMessage(error), "error");
        if (!(error instanceof MicrophoneUnavailableError)) {
          await offerMacOSPermissionHelp(pi, ctx);
        }
        return;
      }

      const controller = new AbortController();
      transcriptionAbort = controller;

      try {
        showTranscribeStatus(ctx, "waiting for model", { cancelable: true });
        await active.preparation;

        showTranscribeStatus(ctx, "transcribing", { cancelable: true });
        let text = await active.backend.transcribe(pcm, controller.signal);
        const seconds = pcm.length / CAPTURE_SAMPLE_RATE;

        if (text && active.cleanupModel.type !== "none") {
          let cleanupAttempted = false;
          if (typeof ctx.modelRegistry?.complete !== "function") {
            if (!cleanupUnavailableNotified) {
              cleanupUnavailableNotified = true;
              ctx.ui.notify(
                "Cleanup requires pi 0.84 or newer; inserting the raw transcript",
                "warning",
              );
            }
          } else {
            cleanupAttempted = true;
            const stopProgress = showTranscribeProgress(
              ctx,
              `Cleaning up transcript`,
              { cancelable: true },
            );
            try {
              const cleaned = await cleanupWithLlm(
                ctx,
                text,
                active.editorTextAtStart,
                active.glossary,
                active.cleanupModel,
                controller.signal,
              );
              if (cleaned) {
                text = cleaned;
              } else if (!controller.signal.aborted && !cleanupFailedNotified) {
                cleanupFailedNotified = true;
                ctx.ui.notify("LLM cleanup failed; inserting the raw transcript", "warning");
              }
            } finally {
              stopProgress();
            }
          }

          if (controller.signal.aborted && cleanupAttempted && !shuttingDown) {
            // Esc during cleanup: the dictation is done, only the polish was
            // cancelled — insert the raw transcript rather than losing it.
            // If cleanup actually finished before the abort landed, keep its
            // output. (Shutdown aborts the same signal but must not paste.)
            ctx.ui.pasteToEditor(text);
            ctx.ui.notify("Cleanup cancelled; raw transcript inserted", "info");
          } else if (text && !controller.signal.aborted) {
            ctx.ui.pasteToEditor(text);
            ctx.ui.notify(`Transcribed ${seconds.toFixed(1)}s of audio`, "info");
          } else if (!controller.signal.aborted) {
            ctx.ui.notify(`No speech detected in ${seconds.toFixed(1)}s of audio`, "warning");
          }
        } else if (text && !controller.signal.aborted) {
          ctx.ui.pasteToEditor(text);
          ctx.ui.notify(`Transcribed ${seconds.toFixed(1)}s of audio`, "info");
        } else if (!controller.signal.aborted) {
          ctx.ui.notify(`No speech detected in ${seconds.toFixed(1)}s of audio`, "warning");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          ctx.ui.notify(transcriptionErrorMessage(error), "error");
        }
      } finally {
        if (transcriptionAbort === controller) transcriptionAbort = undefined;
      }
    } finally {
      showTranscribeStatus(ctx, "unloading model");
      try {
        await active.backend.dispose();
      } finally {
        clearCancelListener();
        clearTranscribeWidget(ctx);
      }
    }
  }

  async function startRecording(
    ctx: ExtensionContext,
    configured: TranscribeSettings,
  ): Promise<void> {
    if (process.platform === "darwin") {
      const micStatus = await testMicrophonePermission();
      if (micStatus.status === "denied") {
        const openSettings = await ctx.ui.confirm(
          "Microphone access",
          "Microphone access is denied in System Settings. Open Privacy & Security → Microphone settings?",
        );
        if (openSettings) await openMacOSMicrophoneSettings(pi, ctx);
        return;
      }
    }

    const glossary = await readGlossary(ctx.cwd);
    // One notification per recording session: a transient failure must not
    // silence every later dictation, nor spam each one.
    cleanupUnavailableNotified = false;
    cleanupFailedNotified = false;
    const capture = new MicrophoneCapture(
      configured.microphone.type === "device"
        ? {
            name: configured.microphone.name,
            occurrence: configured.microphone.occurrence,
          }
        : undefined,
    );
    let editorTextAtStart = "";
    try {
      editorTextAtStart = ctx.ui.getEditorText();
    } catch {
      // Editor content is unavailable in some modes; cleanup runs without it.
    }
    const meter = new RecordingMeter();
    capture.onFrame = (frame) => meter.push(frame);
    meter.start(ctx);
    try {
      capture.start();
    } catch (error) {
      meter.stop();
      clearCancelListener();
      ctx.ui.notify(captureErrorMessage(error), "error");
      if (!(error instanceof MicrophoneUnavailableError)) {
        await offerMacOSPermissionHelp(pi, ctx);
      }
      return;
    }

    const backend = new TranscribeCppBackend(
      configured.model.path,
      configured.transcriptionLanguage === "auto"
        ? undefined
        : configured.transcriptionLanguage,
      configured.chineseOutput,
    );
    const preparation = backend.prepare();
    const active: ActiveRecording = {
      capture,
      backend,
      preparation,
      meter,
      cleanupModel: configured.cleanupModel,
      glossary,
      editorTextAtStart,
    };
    recording = active;

    void preparation.then(
      () => {
        if (recording === active) active.meter.setModelState("ready");
      },
      () => {
        if (recording === active) active.meter.setModelState("failed");
      },
    );

    listenForCancel(ctx);
    ctx.ui.notify("Microphone recording started", "info");
  }

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    if (recording) {
      await stopAndTranscribe(ctx);
      return;
    }

    const configured = await ensureSettings(ctx);
    if (configured) await startRecording(ctx, configured);
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

  pi.registerShortcut(
    registeredShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
    {
      description: "Toggle microphone transcription",
      handler: (ctx) => runExclusive(ctx, () => toggleCapture(ctx)),
    },
  );

  pi.registerCommand("transcribe-glossary", {
    description: "Create or regenerate .pi/transcribe.glossary from an LLM analysis of the project",
    handler: async (_args, ctx) => {
      // Same guard as onboarding: custom UIs (review screen, Esc listener) are
      // interactive-only; RPC mode reports hasUI but must not send project
      // data to the LLM it cannot show a review for.
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Glossary generation requires the interactive TUI", "error");
        return;
      }
      if (recording) {
        ctx.ui.notify(
          `Stop recording with ${displayShortcut(registeredShortcut)} before generating the glossary`,
          "warning",
        );
        return;
      }
      const controller = new AbortController();
      glossaryAbort = controller;
      try {
        await runExclusive(ctx, () => generateGlossary(ctx, controller));
      } finally {
        if (glossaryAbort === controller) glossaryAbort = undefined;
      }
    },
  });

  pi.registerCommand("transcribe", {
    description: "Open pi-transcribe settings",
    handler: async (_args, ctx) => {
      if (recording) {
        ctx.ui.notify(
          `Stop recording with ${displayShortcut(registeredShortcut)} before opening settings`,
          "warning",
        );
        return;
      }

      let reload = false;
      await runExclusive(ctx, async () => {
        const configured = await ensureSettings(ctx);
        if (!configured) return;
        reload = await showSettingsMenu(pi, ctx, configured, registeredShortcut);
      });
      if (reload) {
        await ctx.reload();
        return;
      }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    transcriptionAbort?.abort();
    glossaryAbort?.abort();
    await operation?.catch(() => undefined);

    const active = recording;
    recording = undefined;
    clearCancelListener();
    if (active) {
      active.meter.stop();
      await active.capture.stop().catch(() => undefined);
      await active.backend.dispose();
    }
    clearTranscribeWidget(ctx);
  });
}
