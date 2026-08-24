import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createPiTranscribeEventBridge,
  emitPiTranscribeState,
} from "./events.js";
import { registerFileTranscriptionTool } from "./file-transcription.js";
import type { PiTranscribeRuntime } from "./runtime.js";
import { STATUS_WIDGET_KEY } from "./shortcut-core.js";
import { readShortcutForRegistration } from "./startup-shortcut.js";

// Pi awaits extension module evaluation before continuing startup. Keep this
// entry point registration-only and load feature implementations on first use.
export default function piTranscribe(pi: ExtensionAPI): void {
  const registeredShortcut = readShortcutForRegistration();
  let runtimePromise: Promise<PiTranscribeRuntime> | undefined;
  let shuttingDown = false;

  function loadRuntime(): Promise<PiTranscribeRuntime> {
    if (shuttingDown) return Promise.reject(new Error("pi-transcribe is shutting down"));
    if (runtimePromise) return runtimePromise;

    const loading = import("./runtime.js").then(({ createPiTranscribeRuntime }) =>
      createPiTranscribeRuntime(pi, registeredShortcut),
    );
    runtimePromise = loading;
    void loading.catch(() => {
      if (runtimePromise === loading) runtimePromise = undefined;
    });
    return loading;
  }

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    let runtime: PiTranscribeRuntime;
    try {
      runtime = await loadRuntime();
    } catch (error) {
      emitPiTranscribeState(pi.events, "idle");
      throw error;
    }
    await runtime.toggleCapture(ctx);
  }

  const eventBridge = createPiTranscribeEventBridge(pi.events, (ctx) => {
    void toggleCapture(ctx).catch(() => undefined);
  });

  const fileTranscription = registerFileTranscriptionTool(pi, {
    getSettings: async () => (await loadRuntime()).requireConfiguredSettingsForTool(),
    getService: async () => (await loadRuntime()).service,
  });

  pi.registerShortcut(
    registeredShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
    {
      description: "Toggle microphone transcription",
      handler: async (ctx) => {
        // The first press pays deferred module loading before the runtime can
        // show anything; paint feedback synchronously. Later presses reach the
        // memoized runtime in a microtask and it paints its own status.
        if (!runtimePromise && ctx.hasUI) {
          ctx.ui.setWidget(STATUS_WIDGET_KEY, [
            ctx.ui.theme.fg("muted", "Starting microphone…"),
          ]);
        }
        try {
          await toggleCapture(ctx);
        } catch (error) {
          if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
          throw error;
        }
      },
    },
  );

  pi.registerCommand("transcribe", {
    description: "Open pi-transcribe settings",
    handler: async (_args, ctx) => (await loadRuntime()).showSettings(ctx),
  });

  if (process.env.PI_TRANSCRIBE_DEBUG === "1") {
    pi.registerCommand("transcribe-onboarding", {
      description: "Replay pi-transcribe onboarding (debug)",
      handler: async (_args, ctx) => (await loadRuntime()).replayOnboarding(ctx),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    eventBridge.sessionStarted(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    eventBridge.shutdown();
    await fileTranscription.shutdown().catch(() => undefined);
    const loading = runtimePromise;
    if (!loading) return;
    const runtime = await loading.catch(() => undefined);
    await runtime?.shutdown(ctx).catch(() => undefined);
  });
}

export {
  PI_TRANSCRIBE_STATE_EVENT,
  PI_TRANSCRIBE_TOGGLE_EVENT,
  type PiTranscribeState,
  type PiTranscribeStateEvent,
} from "./events.js";
