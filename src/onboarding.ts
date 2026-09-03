import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  chooseCatalogModel,
  chooseLanguages,
  defaultSpokenLanguages,
  type CatalogModelPostActivation,
} from "./model-picker.js";
import { createModelActivation } from "./model-activation.js";
import {
  DEFAULT_MICROPHONE,
  settingsForModel,
  writeSettings,
  type ChineseOutput,
  type MicrophoneSetting,
  type TranscribeSettings,
  type TranscriptionLanguage,
} from "./settings.js";
import { DEFAULT_SHORTCUT } from "./shortcut-core.js";

function requireTui(ctx: ExtensionContext): boolean {
  if (ctx.mode === "tui") return true;
  ctx.ui.notify("Pi Voice configuration requires the interactive TUI", "error");
  return false;
}

type ModelSelectionOptions = {
  shortcut?: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  currentModelId?: string;
  microphone?: MicrophoneSetting;
  /** Persists language changes made before this flow activates a model. */
  onPreferredLanguagesChange?: (languages: string[]) => Promise<void>;
  postActivation?: CatalogModelPostActivation;
};

export async function runModelSelection(
  ctx: ExtensionContext,
  options: ModelSelectionOptions = {},
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let preferredLanguages = [
    ...(options.preferredLanguages ?? defaultSpokenLanguages()),
  ];
  let currentModelId = options.currentModelId;
  let configured: TranscribeSettings | undefined;
  const { activate, waitForCommits } = createModelActivation({
    buildSettings: (model, path) =>
      settingsForModel(model.id, path, {
        shortcut: configured?.shortcut ?? options.shortcut ?? DEFAULT_SHORTCUT,
        preferredLanguages,
        transcriptionLanguage:
          configured?.transcriptionLanguage ?? options.transcriptionLanguage,
        chineseOutput: configured?.chineseOutput ?? options.chineseOutput,
        microphone: configured?.microphone ?? options.microphone ?? DEFAULT_MICROPHONE,
      }),
    onCommitted: (settings) => {
      configured = settings;
      currentModelId = settings.model.id;
    },
  });

  while (true) {
    const selection = await chooseCatalogModel(
      ctx,
      preferredLanguages,
      currentModelId,
      {
        postActivation: options.postActivation,
        // Keep the post-selection state when the picker reopens after a
        // round-trip through the language step.
        activatedInFlow: configured !== undefined,
        onActivate: activate,
      },
    );
    // The picker can close while its last commit is still in flight; wait so
    // configured reflects every selection that will land on disk.
    await waitForCommits();

    if (!selection || selection.type === "complete") return configured;

    // Esc and Continue both keep the selection here; the picker edits live
    // state rather than gating it behind a confirm.
    const changed = await chooseLanguages(ctx, preferredLanguages);
    if (changed) {
      try {
        if (configured) {
          const updated = { ...configured, preferredLanguages: changed.languages };
          await writeSettings(updated);
          configured = updated;
        } else {
          await options.onPreferredLanguagesChange?.(changed.languages);
        }
        preferredLanguages = changed.languages;
      } catch (error) {
        ctx.ui.notify(
          `Could not save preferred languages: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }

    // Reaching the language pane after a commit takes a Tab that landed while
    // the save was in flight. Esc there closes the flow instead of bouncing
    // back to a model pane that no longer offers the language step.
    if (!changed?.confirmed && configured) return configured;
  }
}

export async function runOnboarding(
  ctx: ExtensionContext,
  shortcut = DEFAULT_SHORTCUT,
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let languages = defaultSpokenLanguages();
  while (true) {
    const chosen = await chooseLanguages(ctx, languages, { cancelLabel: "skip for now" });
    // Esc exits onboarding: there are no settings yet for a closed picker's
    // selection to be kept in, so only Continue advances.
    if (!chosen?.confirmed) return undefined;
    languages = chosen.languages;
    const configured = await runModelSelection(ctx, {
      shortcut,
      preferredLanguages: languages,
      postActivation: "advance",
      onPreferredLanguagesChange: async (changed) => {
        languages = changed;
      },
    });
    if (configured) return configured;
    // Cancelling the model picker returns to the language step; only
    // cancelling the language step exits onboarding.
  }
}
