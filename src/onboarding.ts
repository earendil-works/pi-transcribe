import {
  BorderedLoader,
  DynamicBorder,
  keyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader,
  Container,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatBinarySize } from "./catalog.js";
import {
  chooseCatalogModel,
  chooseLanguages,
  defaultSpokenLanguages,
} from "./model-picker.js";
import {
  downloadCatalogModel,
  findCachedCatalogModel,
  verifyCatalogModel,
} from "./models.js";
import {
  DEFAULT_MICROPHONE,
  settingsForModel,
  writeSettings,
  type ChineseOutput,
  type CleanupModelSetting,
  type MicrophoneSetting,
  type TranscribeSettings,
  type TranscriptionLanguage,
} from "./settings.js";
import { DEFAULT_SHORTCUT } from "./shortcuts.js";

type UiTheme = ExtensionContext["ui"]["theme"];

class DownloadLoader extends Container {
  private readonly loader: CancellableLoader;

  constructor(tui: TUI, theme: UiTheme, message: string) {
    super();
    const border = (text: string) => theme.fg("border", text);
    this.loader = new CancellableLoader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("muted", text),
      message,
    );
    this.addChild(new DynamicBorder(border));
    this.addChild(this.loader);
    this.addChild(new Spacer(1));
    this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(border));
  }

  get signal(): AbortSignal {
    return this.loader.signal;
  }

  set onAbort(callback: (() => void) | undefined) {
    this.loader.onAbort = callback;
  }

  setMessage(message: string): void {
    this.loader.setMessage(message);
  }

  handleInput(data: string): void {
    this.loader.handleInput(data);
  }

  dispose(): void {
    this.loader.dispose();
  }
}

function requireTui(ctx: ExtensionContext): boolean {
  if (ctx.mode === "tui") return true;
  ctx.ui.notify("pi-transcribe configuration requires the interactive TUI", "error");
  return false;
}

type ModelSelectionOptions = {
  shortcut?: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  currentModelId?: string;
  microphone?: MicrophoneSetting;
  cleanupModel?: CleanupModelSetting;
  onPreferredLanguagesChange?: (languages: string[]) => Promise<void>;
};

export async function runModelSelection(
  ctx: ExtensionContext,
  options: ModelSelectionOptions = {},
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let preferredLanguages = [
    ...(options.preferredLanguages ?? defaultSpokenLanguages()),
  ];
  while (true) {
    const selection = await chooseCatalogModel(
      ctx,
      preferredLanguages,
      options.currentModelId,
    );
    if (!selection) return undefined;
    if (selection.type === "change-languages") {
      const changed = await chooseLanguages(ctx, preferredLanguages);
      if (changed) {
        try {
          await options.onPreferredLanguagesChange?.(changed);
          preferredLanguages = changed;
        } catch (error) {
          ctx.ui.notify(
            `Could not save preferred languages: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
      continue;
    }

    const model = selection.model;
    const cached = findCachedCatalogModel(model);
    if (!cached) {
      const confirmed = await ctx.ui.confirm(
        model.name,
        [
          `Download ${formatBinarySize(model.size)} (${model.quant}) from Hugging Face?`,
          `License: ${model.license}`,
          "Audio never leaves this machine.",
        ].join("\n"),
      );
      if (!confirmed) return undefined;
    }

    let prepared: { path: string } | { error: unknown } | { cancelled: true };
    prepared = await ctx.ui.custom<
      { path: string } | { error: unknown } | { cancelled: true }
    >((tui, theme, _keybindings, done) => {
      const detail = `${model.quant} · ${formatBinarySize(model.size)}`;
      const loader = cached
        ? new BorderedLoader(tui, theme, `Verifying ${model.name} · ${detail}`)
        : new DownloadLoader(tui, theme, `Downloading ${model.name} · ${detail}`);
      loader.onAbort = () => {
        if (loader instanceof DownloadLoader) loader.setMessage(`Cancelling ${model.name}`);
      };

      void (async () => {
        try {
          let path: string;
          if (cached) {
            path = cached.path;
          } else {
            path = await downloadCatalogModel(model, {
              signal: loader.signal,
              onProgress: ({ downloaded, total }) => {
                const percent = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
                const message = `Downloading ${model.name} · ${formatBinarySize(downloaded)} / ${formatBinarySize(total)} · ${percent}%`;
                if (loader instanceof DownloadLoader) loader.setMessage(message);
              },
            });
          }

          if (loader.signal.aborted) {
            done({ cancelled: true });
            return;
          }
          if (loader instanceof DownloadLoader) {
            loader.setMessage(`Verifying ${model.name} · ${detail}`);
          }
          await verifyCatalogModel(path, model, loader.signal);
          done({ path });
        } catch (error) {
          done(loader.signal.aborted ? { cancelled: true } : { error });
        }
      })();
      return loader;
    });

    if ("cancelled" in prepared) continue;

    if ("error" in prepared) {
      ctx.ui.notify(
        `Could not prepare ${model.name}: ${prepared.error instanceof Error ? prepared.error.message : String(prepared.error)}`,
        "error",
      );
      // Return to model selection so a transient failure does not close setup.
      continue;
    }

    try {
      const settings = settingsForModel(model.id, prepared.path, {
        shortcut: options.shortcut ?? DEFAULT_SHORTCUT,
        preferredLanguages,
        transcriptionLanguage: options.transcriptionLanguage,
        chineseOutput: options.chineseOutput,
        microphone: options.microphone ?? DEFAULT_MICROPHONE,
        cleanupModel: options.cleanupModel,
      });
      await writeSettings(settings);
      ctx.ui.notify(`${model.name} is ready for local transcription`, "info");
      return settings;
    } catch (error) {
      ctx.ui.notify(
        `Could not save ${model.name}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      continue;
    }
  }
}

export async function runOnboarding(
  ctx: ExtensionContext,
  shortcut = DEFAULT_SHORTCUT,
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  const preferredLanguages = await chooseLanguages(ctx);
  if (!preferredLanguages) return undefined;
  return runModelSelection(ctx, { shortcut, preferredLanguages });
}
