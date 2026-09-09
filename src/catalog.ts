import { CATALOG_MODELS_GENERATED } from "./catalog.generated.js";
import { canonicalLanguage, languageIdentity, resolveModelLanguage } from "./languages.js";
export { canonicalLanguage, languageIdentity, resolveModelLanguage } from "./languages.js";

export type CatalogModel = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly repository: string;
  readonly revision: string;
  readonly license: string;
  readonly family: string;
  readonly parameters: string | null;
  readonly languages: readonly string[];
  readonly capabilities: {
    readonly streaming: boolean;
    readonly translate: boolean;
    readonly languageDetection: boolean;
  };
  readonly quant: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
};

export const CATALOG_MODELS: readonly CatalogModel[] = CATALOG_MODELS_GENERATED;

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

export function displayLanguage(language: string): string {
  // ASR catalogs conventionally use zh for Mandarin and list Cantonese as yue.
  // Make that spoken-language distinction explicit without losing the familiar
  // umbrella term users look for.
  if (canonicalLanguage(language) === "zh") return "Mandarin (Chinese)";
  try {
    return languageNames.of(language) ?? language;
  } catch {
    return language;
  }
}

export function modelMatchesLanguage(model: CatalogModel, language: string): boolean {
  return resolveModelLanguage(model, language) !== undefined;
}

function preferredLanguageMatchCount(
  model: CatalogModel,
  preferredLanguages: readonly string[],
): number {
  return [...new Set(preferredLanguages.map(languageIdentity))].filter((language) =>
    modelMatchesLanguage(model, language),
  ).length;
}

// The catalog carries no editorial rank or score: the pickers order measured
// models by benchmark, so names only settle models without one.
export function rankCatalogModels(
  models: readonly CatalogModel[],
  preferredLanguages: readonly string[] = [],
  isDownloaded: (model: CatalogModel) => boolean = () => false,
): CatalogModel[] {
  return [...models].sort(
    (left, right) =>
      preferredLanguageMatchCount(right, preferredLanguages) -
        preferredLanguageMatchCount(left, preferredLanguages) ||
      Number(isDownloaded(right)) - Number(isDownloaded(left)) ||
      left.name.localeCompare(right.name),
  );
}

/**
 * What a catalog search runs against. Languages and capabilities are left
 * out on purpose: the pickers already scope and grade by language, and a
 * long haystack made short queries match nearly everything.
 */
export function catalogModelSearchText(model: CatalogModel): string {
  return [model.id, model.name, model.family, model.parameters ?? ""].join(" ").toLowerCase();
}

export function getCatalogModel(id: string): CatalogModel | undefined {
  return CATALOG_MODELS.find((model) => model.id === id);
}

export function formatBinarySize(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
