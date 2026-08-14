import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalLanguage,
  getCatalogModel,
  modelMatchesLanguage,
  modelSupportsLanguage,
  type CatalogModel,
} from "./catalog.js";
import { DEFAULT_SHORTCUT, normalizeShortcut } from "./shortcuts.js";

const SETTINGS_VERSION = 1;

export type MicrophoneSetting =
  | { type: "system-default" }
  | { type: "device"; name: string; occurrence: number };

export const DEFAULT_MICROPHONE: MicrophoneSetting = { type: "system-default" };

export type ChineseOutput = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

function defaultChineseOutput(): ChineseOutput {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const subtags = locale.toLowerCase().split("-");
  if (subtags.includes("hk") || subtags.includes("mo")) return "traditional-hong-kong";
  if (subtags.includes("tw") || subtags.includes("hant")) return "traditional-taiwan";
  return "simplified";
}

/** "auto" asks a capable model to detect the language; otherwise this is a language code. */
export type TranscriptionLanguage = string;

export type TranscribeSettings = {
  version: 1;
  backend: { type: "transcribe-cpp" };
  shortcut: string;
  preferredLanguages: string[];
  transcriptionLanguage: TranscriptionLanguage;
  chineseOutput: ChineseOutput;
  // Local addition (autoSubmit feature): this type is the single source of
  // truth for the On/Off state, persisted in pi-transcribe.json. Every other
  // file only reads or forwards this field.
  autoSubmit: boolean;
  microphone: MicrophoneSetting;
  model: {
    source: "catalog";
    id: string;
    path: string;
  };
};

type SettingsReadResult = {
  settings?: TranscribeSettings;
  warning?: string;
};

function settingsPath(): string {
  return join(getAgentDir(), "pi-transcribe.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLanguages(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((language) => typeof language === "string")) {
    return undefined;
  }
  const languages = [...new Set(value.map(canonicalLanguage).filter(Boolean))];
  return languages.length > 0 ? languages : undefined;
}

function validateChineseOutput(value: unknown): ChineseOutput {
  return value === "simplified" ||
    value === "traditional-taiwan" ||
    value === "traditional-hong-kong"
    ? value
    : defaultChineseOutput();
}

function validateMicrophone(value: unknown): MicrophoneSetting | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "system-default") return { type: "system-default" };
  if (
    value.type !== "device" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Number.isInteger(value.occurrence) ||
    (value.occurrence as number) < 0
  ) {
    return undefined;
  }
  return { type: "device", name: value.name, occurrence: value.occurrence as number };
}

function defaultTranscriptionLanguage(
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (model.capabilities.languageDetection) return "auto";
  const preferred = preferredLanguages.find((language) => modelMatchesLanguage(model, language));
  return (
    model.languages.find(
      (language) => preferred && canonicalLanguage(language) === canonicalLanguage(preferred),
    ) ??
    model.languages[0] ??
    "en"
  );
}

/** Keep an exact model language when possible; otherwise choose a safe default. */
export function transcriptionLanguageForModel(
  value: unknown,
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (typeof value === "string") {
    if (value === "auto" && model.capabilities.languageDetection) return value;
    if (value !== "auto" && modelSupportsLanguage(model, value)) return value;
  }
  return defaultTranscriptionLanguage(model, preferredLanguages);
}

function validateSettings(value: unknown): TranscribeSettings | undefined {
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return undefined;
  if (!isObject(value.backend) || value.backend.type !== "transcribe-cpp") return undefined;
  const shortcut =
    typeof value.shortcut === "string" ? normalizeShortcut(value.shortcut) : undefined;
  if (!shortcut) return undefined;
  if (!isObject(value.model) || value.model.source !== "catalog") return undefined;
  if (typeof value.model.id !== "string") return undefined;
  const model = getCatalogModel(value.model.id);
  if (!model) return undefined;
  if (typeof value.model.path !== "string" || value.model.path.length === 0) return undefined;

  const preferredLanguages = normalizeLanguages(value.preferredLanguages);
  const microphone = validateMicrophone(value.microphone);
  if (!preferredLanguages || !microphone) return undefined;

  return {
    version: SETTINGS_VERSION,
    backend: { type: "transcribe-cpp" },
    shortcut,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      value.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: validateChineseOutput(value.chineseOutput),
    // Backward compatibility: config files written before this feature exists
    // have no autoSubmit key, so a missing/invalid value reads as false
    // instead of failing validation (which would demand re-configuration).
    autoSubmit: typeof value.autoSubmit === "boolean" ? value.autoSubmit : false,
    microphone,
    model: {
      source: "catalog",
      id: value.model.id,
      path: value.model.path,
    },
  };
}

export function readShortcutForRegistration(): string {
  try {
    const settings = validateSettings(JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown);
    return settings?.shortcut ?? DEFAULT_SHORTCUT;
  } catch {
    return DEFAULT_SHORTCUT;
  }
}

export async function readSettings(): Promise<SettingsReadResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    const settings = validateSettings(parsed);
    return settings
      ? { settings }
      : { warning: `Invalid settings in ${settingsPath()}; configuration is required.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning: `Could not read ${settingsPath()}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeSettings(settings: TranscribeSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

type ModelSettingsOptions = {
  shortcut?: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  autoSubmit?: boolean;
  microphone?: MicrophoneSetting;
};

export function settingsForModel(
  modelId: string,
  modelPath: string,
  options: ModelSettingsOptions = {},
): TranscribeSettings {
  const model = getCatalogModel(modelId);
  if (!model) throw new Error(`Unknown catalog model: ${modelId}`);
  const preferredLanguages = [
    ...new Set((options.preferredLanguages ?? ["en"]).map(canonicalLanguage)),
  ];
  return {
    version: SETTINGS_VERSION,
    backend: { type: "transcribe-cpp" },
    shortcut: options.shortcut ?? DEFAULT_SHORTCUT,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      options.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: options.chineseOutput ?? defaultChineseOutput(),
    // settingsForModel() rebuilds the entire settings object from scratch on
    // every model selection; without this line the flag would silently reset
    // to false whenever the user picks a different model.
    autoSubmit: options.autoSubmit ?? false,
    microphone: { ...(options.microphone ?? DEFAULT_MICROPHONE) },
    model: { source: "catalog", id: modelId, path: modelPath },
  };
}
