import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { completeText } from "./llm.js";

const MAX_LLM_SUGGESTIONS = 30;
export const MAX_TOTAL_SUGGESTIONS = 50;
const MAX_SESSION_CONTEXT_CHARS = 8000;
const MAX_SESSION_USER_TURNS = 20;
/** Extraction is a multi-round tool loop on a reasoning model; measured at ~3min. */
const GLOSSARY_TIMEOUT_MS = 240_000;

const GLOSSARY_FILE_NAME = "transcribe.glossary";

const GLOSSARY_HEADER = [
  "# Glossary of project terms for pi-transcribe cleanup — one term per line. Hand-edit freely.",
  "# Re-run /transcribe-glossary to regenerate from the project.",
];

export function glossaryFilePath(projectRoot: string): string {
  return join(projectRoot, ".pi", GLOSSARY_FILE_NAME);
}

/** Order-preserving, case-insensitive dedupe (first spelling wins). */
export function dedupeCaseInsensitive(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Merges incoming suggestions into an existing glossary: curated terms keep
 * their spelling and order, new terms append; case-insensitive dedupe.
 */
export function mergeGlossaryTerms(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return dedupeCaseInsensitive([...existing, ...incoming]);
}

/** Parses the project glossary file: one term per line, "#" comments ignored. */
export function parseGlossaryText(text: string): string[] {
  const entries: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    entries.push(line);
  }
  return dedupeCaseInsensitive(entries);
}

export async function readGlossary(projectRoot: string): Promise<string[]> {
  try {
    return parseGlossaryText(await readFile(glossaryFilePath(projectRoot), "utf8"));
  } catch {
    return [];
  }
}

/** Raw file text, for the editor round-trip that preserves hand-written comments. */
export async function readGlossaryFile(projectRoot: string): Promise<string | undefined> {
  try {
    return await readFile(glossaryFilePath(projectRoot), "utf8");
  } catch {
    return undefined;
  }
}

/** Writes the given text verbatim (no header injection); atomic. */
export async function writeGlossaryText(projectRoot: string, text: string): Promise<void> {
  const path = glossaryFilePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Regenerates the glossary file, preserving hand-written `#` comment lines
 * (minus the canned header) so curated notes survive regeneration.
 */
export async function writeGlossaryPreservingComments(
  projectRoot: string,
  terms: string[],
): Promise<void> {
  const raw = await readGlossaryFile(projectRoot);
  const header = new Set(GLOSSARY_HEADER);
  const comments = (raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#") && !header.has(line));
  await writeGlossaryText(projectRoot, [...GLOSSARY_HEADER, ...comments, ...terms].join("\n"));
}

const GLOSSARY_EXTRACTION_INSTRUCTIONS = `You are a glossary extractor for a speech-to-text dictation tool. Your job: return project terms a developer would say out loud that a speech recognizer would likely mishear.

The session conversation in the user message is your primary source: extract candidate terms from what the developer actually said. Then use AT MOST ONE tool call (one ls, or one grep) to confirm those candidates are project terms and to pick up at most two or three obvious additions. Do not explore the codebase broadly.

Exclude file names, paths, field names, class or function names, and code identifiers — they are never dictated, even if they appear in the session.

Output ONLY a JSON array of 5 to 15 strings, ranked by mishear likelihood, exact spelling as written in the project. No prose, no markdown fences, no numbering.`;

/** Extracts the JSON term array from a model reply, tolerating fences and prose. */
export function parseTermList(text: string): string[] {
  const start = text.indexOf("[");
  if (start < 0) return [];
  const end = text.lastIndexOf("]");
  const candidates: string[] = [];
  if (end > start) candidates.push(text.slice(start, end + 1));
  const firstClose = text.indexOf("]", start);
  if (firstClose > start && firstClose !== end) candidates.push(text.slice(start, firstClose + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!Array.isArray(parsed)) continue;
      const terms = [
        ...new Set(
          parsed
            .filter((term): term is string => typeof term === "string")
            .map((term) => term.trim())
            .filter((term) => term.length >= 2 && !/\n|\r/.test(term)),
        ),
      ];
      return terms.slice(0, MAX_LLM_SUGGESTIONS);
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

type SessionEntry = {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

function sessionEntryText(entry: SessionEntry): string | undefined {
  // The glossary reflects what the developer says, so only their own (user)
  // turns are included — assistant replies and tool output are full of code
  // identifiers and file names, which are exactly the terms we do not want.
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const content = entry.message.content;
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const value = block as { type?: string; text?: string };
      if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
    }
  }
  const text = parts.join(" ").trim();
  return text ? `User: ${text}` : undefined;
}

/** Pure session-text builder: the most recent user turns, turn- and char-bounded. */
export function buildSessionContextFromEntries(entries: readonly SessionEntry[]): string {
  const lines: string[] = [];
  let size = 0;
  let userTurns = 0;
  // getBranch() is oldest-first; collect from the tail so truncation keeps the
  // recent conversation (the extraction prompt asks for exactly that).
  for (const entry of [...entries].reverse()) {
    const line = sessionEntryText(entry);
    if (!line) continue;
    userTurns += 1;
    if (userTurns > MAX_SESSION_USER_TURNS) break;
    // Keep as much of the crossing line as fits, instead of dropping it whole.
    const remaining = MAX_SESSION_CONTEXT_CHARS - size;
    if (remaining <= 0) break;
    if (line.length + 1 > remaining) {
      lines.push(line.slice(0, Math.max(0, remaining - 1)));
      break;
    }
    size += line.length + 1;
    lines.push(line);
  }
  lines.reverse(); // restore chronological order for the LLM
  const content = lines.join("\n").trim();
  // Built inline (not via section()) so the char cap is not applied twice from
  // the wrong end.
  return content ? `Recent session conversation\n---\n${content}\n---` : "";
}

function buildSessionContext(ctx: ExtensionContext): string {
  const entries = (ctx.sessionManager.getBranch() ?? []) as SessionEntry[];
  return buildSessionContextFromEntries(entries);
}

/** Read-only project tools the glossary extraction may use to find terms. */
function projectGlossaryTools(cwd: string): ToolDefinition<any, any>[] {
  return [
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
    createReadToolDefinition(cwd),
  ];
}

/**
 * Asks the active LLM to extract the most probable dictation terms from the
 * project. Returns [] on any failure so callers fall back to the heuristic.
 */
export async function suggestGlossaryWithLlm(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string[]> {
  const model = ctx.model;
  if (!model) return [];

  const context =
    buildSessionContext(ctx) ||
    "No session conversation is available; scan the project with your tools.";

  const text = await completeText(ctx, model, GLOSSARY_EXTRACTION_INSTRUCTIONS, context, {
    signal,
    tools: projectGlossaryTools(ctx.cwd),
    timeoutMs: GLOSSARY_TIMEOUT_MS,
  });
  return text ? parseTermList(text) : [];
}
