/** A base code, without changing the identity or the model's exact code. */
export function canonicalLanguage(language: string): string {
  return language.trim().toLowerCase().split("-", 1)[0] ?? "";
}

// Model cards and benchmarks use different ISO codes for these languages.
// This identity is for matching, never a code to send directly to a backend.
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { tl: "fil", no: "nb" };

export function languageIdentity(language: string): string {
  const base = canonicalLanguage(language);
  return LANGUAGE_ALIASES[base] ?? base;
}

/** Return a model's exact code, preserving an explicitly chosen regional variant. */
export function resolveModelLanguage(
  model: { readonly languages: readonly string[] },
  language: string,
): string | undefined {
  const exact = model.languages.find((code) => code.toLowerCase() === language.trim().toLowerCase());
  return exact ?? model.languages.find((code) => languageIdentity(code) === languageIdentity(language));
}
