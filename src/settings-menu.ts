import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getAvailableMicrophones, testMicrophonePermission } from "./audio.js";
import { getCatalogModel } from "./catalog.js";
import { chineseOutputSummary, isChineseLanguage } from "./chinese.js";
import {
  chooseTranscriptionLanguage,
  transcriptionLanguageSummary,
} from "./model-picker.js";
import { runModelSelection } from "./onboarding.js";
import { chooseCleanupModel } from "./cleanup-model-picker.js";
import { reviewGlossaryAdditions } from "./glossary-review.js";
import {
  MAX_TOTAL_SUGGESTIONS,
  dedupeCaseInsensitive,
  mergeGlossaryTerms,
  readGlossary,
  readGlossaryFile,
  suggestGlossaryWithLlm,
  writeGlossaryPreservingComments,
  writeGlossaryText,
} from "./glossary.js";
import {
  writeSettings,
  type ChineseOutput,
  type CleanupModelSetting,
  type MicrophoneSetting,
  type TranscribeSettings,
} from "./settings.js";
import { chooseShortcut, displayShortcut } from "./shortcuts.js";
import { showTranscribeProgress } from "./visualizer.js";

const MACOS_MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const SETTING_LABEL_WIDTH = "Transcription language".length;

function settingChoice(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  value: string,
): string {
  return `${theme.fg("muted", label.padEnd(SETTING_LABEL_WIDTH))}  ${value}`;
}

function microphoneSummary(microphone: MicrophoneSetting): string {
  if (microphone.type === "system-default") return "System default";
  const duplicate = microphone.occurrence > 0 ? ` · device ${microphone.occurrence + 1}` : "";
  return `${microphone.name}${duplicate}`;
}

function cleanupModelSummary(setting: CleanupModelSetting): string {
  if (setting.type === "none") return "Off";
  return `${setting.provider}/${setting.id}`;
}

function glossarySummary(glossary: string[]): string {
  if (glossary.length === 0) return "None";
  return glossary.length === 1
    ? glossary[0]!
    : `${glossary[0]} +${glossary.length - 1}`;
}

/** Shared by the /transcribe menu row. */
async function editGlossaryList(ctx: ExtensionContext): Promise<void> {
  const fileText = await readGlossaryFile(ctx.cwd);
  const prefill = fileText?.trim() ?? "";
  const edited = await ctx.ui.editor(
    "Project terms (one per line, # comments allowed) — cleanup corrects misheard terms to these",
    prefill,
  );
  if (edited === undefined) return;

  const meaningfulLines = edited
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  try {
    // Verbatim round-trip: hand-written # comments are preserved.
    await writeGlossaryText(ctx.cwd, edited.trim());
  } catch (error) {
    ctx.ui.notify(
      `Could not save glossary: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    meaningfulLines.length > 0
      ? `Glossary saved to .pi/transcribe.glossary (${meaningfulLines.length} term${meaningfulLines.length === 1 ? "" : "s"})`
      : "Glossary cleared",
    "info",
  );
}

/** One-shot generator for /transcribe-glossary: writes suggestions to the file. */
export async function generateGlossary(
  ctx: ExtensionContext,
  controller?: AbortController,
): Promise<void> {
  const signal = controller?.signal;
  const current = await readGlossary(ctx.cwd);

  // Esc cancels only the LLM call; the review screen keeps its own Esc.
  const stopListening = ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, "escape")) return;
    controller?.abort();
    ctx.ui.notify("Glossary generation cancelled", "info");
    return { consume: true };
  });
  const stopProgress = showTranscribeProgress(
    ctx,
    "Analyzing project files and current session for glossary terms",
    { cancelable: true },
  );
  let llmTerms: string[];
  try {
    llmTerms = await suggestGlossaryWithLlm(ctx, signal);
  } finally {
    stopProgress();
    stopListening();
  }
  if (signal?.aborted) return;

  // Case-insensitive dedupe: prefer the first (LLM) spelling of a term.
  const candidates = [...llmTerms];
  const capped = dedupeCaseInsensitive(candidates).slice(0, MAX_TOTAL_SUGGESTIONS);
  const merged = mergeGlossaryTerms(current, capped);
  if (merged.length === 0) {
    ctx.ui.notify("No glossary suggestions found; nothing written", "info");
    return;
  }
  const additions = merged.slice(current.length);
  if (additions.length === 0) {
    ctx.ui.notify(`Glossary unchanged (${merged.length} terms) — nothing new found`, "info");
    return;
  }
  // If shutdown aborts the controller while the review is open, resolve it
  // immediately so shutdown does not wait on the review UI. The controller is
  // short-lived, so the abort listener is discarded with it.
  const chosen = await Promise.race([
    reviewGlossaryAdditions(ctx, current.length, additions),
    new Promise<undefined>((resolve) => {
      if (signal?.aborted) resolve(undefined);
      else signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
  ]);
  if (chosen === undefined) {
    ctx.ui.notify("Glossary unchanged — additions not applied", "info");
    return;
  }
  const finalGlossary = mergeGlossaryTerms(current, chosen);
  try {
    await writeGlossaryPreservingComments(ctx.cwd, finalGlossary);
  } catch (error) {
    ctx.ui.notify(
      `Could not save glossary: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    chosen.length > 0
      ? `Glossary updated — ${chosen.length} new term${chosen.length === 1 ? "" : "s"} (${finalGlossary.length} total) in .pi/transcribe.glossary`
      : "Glossary unchanged — no terms selected",
    "info",
  );
}

async function chooseChineseOutput(
  ctx: ExtensionContext,
  current: ChineseOutput,
): Promise<ChineseOutput | undefined> {
  const options: ChineseOutput[] = [
    "simplified",
    "traditional-taiwan",
    "traditional-hong-kong",
  ];
  const selected = await ctx.ui.select(
    `Chinese output · ${chineseOutputSummary(current)}`,
    options.map(chineseOutputSummary),
  );
  return options.find((option) => chineseOutputSummary(option) === selected);
}

function microphonesEqual(left: MicrophoneSetting, right: MicrophoneSetting): boolean {
  return (
    left.type === right.type &&
    (left.type === "system-default" ||
      (right.type === "device" &&
        left.name === right.name &&
        left.occurrence === right.occurrence))
  );
}

async function chooseMicrophone(
  ctx: ExtensionContext,
  current: MicrophoneSetting,
): Promise<MicrophoneSetting | undefined> {
  let devices: string[];
  try {
    devices = getAvailableMicrophones();
  } catch (error) {
    ctx.ui.notify(
      `Could not list microphones: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return undefined;
  }

  const totals = new Map<string, number>();
  for (const name of devices) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const options = devices.map((name) => {
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return {
      label: (totals.get(name) ?? 0) > 1 ? `${name} · device ${occurrence + 1}` : name,
      value: { type: "device", name, occurrence } as const,
    };
  });
  const systemDefault = "Use system default";
  const choice = await ctx.ui.select(
    `Microphone input · ${microphoneSummary(current)}`,
    [systemDefault, ...options.map((option) => option.label)],
  );
  if (!choice) return undefined;
  if (choice === systemDefault) return { type: "system-default" };
  return options.find((option) => option.label === choice)?.value;
}

export async function openMacOSMicrophoneSettings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const result = await pi.exec("open", [MACOS_MICROPHONE_SETTINGS_URL]);
  if (result.code === 0) {
    ctx.ui.notify(
      "Enable microphone access for your terminal app, then return to Pi and try recording. A terminal restart may be required.",
      "info",
    );
  } else {
    ctx.ui.notify(
      "Could not open System Settings. Open Privacy & Security → Microphone manually.",
      "error",
    );
  }
}

export async function offerMacOSPermissionHelp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const openSettings = await ctx.ui.confirm(
    "Microphone access",
    "Microphone capture failed. Open macOS Privacy & Security → Microphone settings?",
  );
  if (openSettings) await openMacOSMicrophoneSettings(pi, ctx);
}

export async function showSettingsMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  registeredShortcut: string,
): Promise<boolean> {
  while (true) {
    const model = getCatalogModel(configured.model.id)!;
    const micResult = await testMicrophonePermission();
    const glossary = await readGlossary(ctx.cwd);
    const theme = ctx.ui.theme;
    let micLine: string;
    if (micResult.status === "granted") {
      micLine = `Microphone: ${theme.fg("success", "✓ Access granted")}`;
    } else if (micResult.status === "denied") {
      micLine = `Microphone: ${theme.fg("error", "✗ Access denied")}`;
    } else if (micResult.status === "not-determined") {
      micLine = `Microphone: ${theme.fg("warning", "⚠ Not yet requested")} — first recording will prompt for access`;
    } else {
      micLine = `Microphone: ${theme.fg("warning", "⚠")} ${micResult.message}`;
    }

    const summary = ["pi-transcribe settings", micLine].join("\n");
    const modelChoice = settingChoice(theme, "Model", model.name);
    const languageChoice = settingChoice(
      theme,
      "Transcription language",
      transcriptionLanguageSummary(configured.transcriptionLanguage, model),
    );
    const chineseOutputChoice = settingChoice(
      theme,
      "Chinese output",
      chineseOutputSummary(configured.chineseOutput),
    );
    const cleanupChoice = settingChoice(
      theme,
      "Cleanup",
      cleanupModelSummary(configured.cleanupModel),
    );
    const glossaryChoice = settingChoice(
      theme,
      "Glossary",
      glossarySummary(glossary),
    );
    const microphoneChoice = settingChoice(
      theme,
      "Microphone",
      microphoneSummary(configured.microphone),
    );
    const shortcutChoice = settingChoice(
      theme,
      "Shortcut",
      displayShortcut(configured.shortcut),
    );
    const showMicFix = micResult.status === "denied";
    const showChineseOutput =
      (configured.transcriptionLanguage !== "auto" &&
        isChineseLanguage(configured.transcriptionLanguage)) ||
      configured.preferredLanguages.some(isChineseLanguage);
    const choices = [
      ...(showMicFix ? ["⚠ Fix: open macOS microphone settings"] : []),
      modelChoice,
      languageChoice,
      ...(showChineseOutput ? [chineseOutputChoice] : []),
      cleanupChoice,
      glossaryChoice,
      microphoneChoice,
      shortcutChoice,
      "Done",
    ];
    const choice = await ctx.ui.select(summary, choices);
    if (!choice || choice === "Done") {
      return configured.shortcut !== registeredShortcut;
    }

    if (choice === "⚠ Fix: open macOS microphone settings") {
      await openMacOSMicrophoneSettings(pi, ctx);
      continue;
    }
    if (choice === modelChoice) {
      const changed = await runModelSelection(ctx, {
        shortcut: configured.shortcut,
        preferredLanguages: configured.preferredLanguages,
        transcriptionLanguage: configured.transcriptionLanguage,
        chineseOutput: configured.chineseOutput,
        currentModelId: configured.model.id,
        microphone: configured.microphone,
        cleanupModel: configured.cleanupModel,
        onPreferredLanguagesChange: async (preferredLanguages) => {
          const updated: TranscribeSettings = { ...configured, preferredLanguages };
          await writeSettings(updated);
          Object.assign(configured, updated);
          ctx.ui.notify("Preferred languages saved", "info");
        },
      });
      if (changed) Object.assign(configured, changed);
      continue;
    }
    if (choice === languageChoice) {
      const transcriptionLanguage = await chooseTranscriptionLanguage(
        ctx,
        model,
        configured.transcriptionLanguage,
        configured.preferredLanguages,
      );
      if (!transcriptionLanguage || transcriptionLanguage === configured.transcriptionLanguage) {
        continue;
      }
      const updated: TranscribeSettings = { ...configured, transcriptionLanguage };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(
        `Transcription language saved as ${transcriptionLanguageSummary(transcriptionLanguage, model)}`,
        "info",
      );
      continue;
    }
    if (choice === chineseOutputChoice) {
      const chineseOutput = await chooseChineseOutput(ctx, configured.chineseOutput);
      if (!chineseOutput || chineseOutput === configured.chineseOutput) continue;

      const updated: TranscribeSettings = { ...configured, chineseOutput };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(`Chinese output saved as ${chineseOutputSummary(chineseOutput)}`, "info");
      continue;
    }
    if (choice === cleanupChoice) {
      const cleanupModel = await chooseCleanupModel(ctx, configured.cleanupModel);
      if (!cleanupModel) continue;
      const updated: TranscribeSettings = { ...configured, cleanupModel };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(
        cleanupModel.type === "none"
          ? "Cleanup disabled: raw transcript is inserted"
          : `Cleanup enabled with ${cleanupModelSummary(cleanupModel)}`,
        "info",
      );
      continue;
    }
    if (choice === glossaryChoice) {
      await editGlossaryList(ctx);
      continue;
    }
    if (choice === microphoneChoice) {
      const microphone = await chooseMicrophone(ctx, configured.microphone);
      if (!microphone || microphonesEqual(microphone, configured.microphone)) continue;

      const updated: TranscribeSettings = { ...configured, microphone };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(`Microphone saved as ${microphoneSummary(microphone)}`, "info");
      continue;
    }
    if (choice === shortcutChoice) {
      const shortcut = await chooseShortcut(ctx);
      if (!shortcut || shortcut === configured.shortcut) continue;

      const updated: TranscribeSettings = { ...configured, shortcut };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(
        `Shortcut saved as ${displayShortcut(shortcut)}. It will apply when the settings menu closes; other open Pi processes must be reloaded separately.`,
        "info",
      );
    }
  }
}
