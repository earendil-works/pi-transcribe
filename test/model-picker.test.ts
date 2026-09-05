import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CatalogModelPicker,
  createTranscriptionLanguagePicker,
  LanguagePicker,
  type CatalogModelPickerResult,
  type CatalogModelPostActivation,
} from "../src/model-picker.js";
import { getRepoFolderName } from "@huggingface/hub";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_MODELS, type CatalogModel } from "../src/catalog.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

// Keep cache and partial-download probes away from the real Hugging Face cache.
process.env.HF_HUB_CACHE = mkdtempSync(join(tmpdir(), "pi-transcribe-picker-"));

initTheme("dark");

const ESC = "\u001b";
const ENTER = "\r";
const MODELS_SHOWN = `${CATALOG_MODELS.length} models`;

type ActivationOptions = {
  cached: unknown;
  signal: AbortSignal;
  onProgress: (progress: { downloaded: number; total: number }) => void;
};

type PickerInternals = {
  cachedById: Map<string, unknown>;
  mode: string;
  filtered: CatalogModel[];
  refresh: () => void;
};

/** A picker in which no model is cached, with a manually driven activation. */
function controlledPicker(postActivation: CatalogModelPostActivation = "stay"): {
  picker: CatalogModelPicker;
  internals: PickerInternals;
  resolve: (path: string) => void;
  reject: (error: unknown) => void;
  signal: () => AbortSignal;
  progress: (downloaded: number, total: number) => void;
  result: () => CatalogModelPickerResult | undefined;
} {
  let options: ActivationOptions | undefined;
  let completed: CatalogModelPickerResult | undefined;
  let resolveActivation!: (value: { path: string }) => void;
  let rejectActivation!: (error: unknown) => void;
  const picker = new CatalogModelPicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    undefined,
    (result) => {
      completed = result;
    },
    (_model: CatalogModel, activationOptions: ActivationOptions) => {
      options = activationOptions;
      return new Promise<{ path: string }>((resolvePromise, rejectPromise) => {
        resolveActivation = resolvePromise;
        rejectActivation = rejectPromise;
      });
    },
    { postActivation },
  );
  const internals = picker as unknown as PickerInternals;
  // Deterministic regardless of the developer's local Hugging Face cache.
  internals.cachedById.clear();
  internals.refresh();
  return {
    picker,
    internals,
    resolve: (path) => resolveActivation({ path }),
    reject: (error) => rejectActivation(error),
    signal: () => options!.signal,
    progress: (downloaded, total) => options!.onProgress({ downloaded, total }),
    result: () => completed,
  };
}

function rendered(picker: CatalogModelPicker): string {
  return picker.render(100).join("\n");
}

test("enter on an uncached model starts the download immediately", (t) => {
  const { picker, internals, progress } = controlledPicker();
  t.after(() => picker.dispose());
  const body = rendered(picker);
  // The detail pane carries the model facts; the footer carries the action.
  assert.match(body, /English only|\d+ languages/);
  assert.match(body, /enter.*download \d/);
  assert.equal((stripAnsi(body).match(/tab change/gi) ?? []).length, 1);

  picker.handleInput(ENTER);
  assert.equal(internals.mode, "downloading");
  progress(0, 3_000_000_000);
  progress(1_260_000_000, 3_000_000_000);
  const downloading = rendered(picker);
  assert.match(downloading, /Downloading /);
  assert.match(downloading, /█+─+ 42%/);
  assert.match(downloading, /1\.2 GiB \/ 2\.8 GiB/);
  // The list and search are gone while the modal progress view is up.
  assert.ok(!downloading.includes(MODELS_SHOWN));
});

test("esc during a download stops it immediately and keeps progress", async (t) => {
  const { picker, internals, signal, progress, reject } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  progress(1_000_000_000, 3_000_000_000);
  assert.match(rendered(picker), /stop \(keeps progress\)/);

  picker.handleInput(ESC);
  assert.equal(signal().aborted, true);
  assert.match(rendered(picker), /Stopping…/);

  // The aborted activation rejects; the picker returns to the list and
  // explains that the progress was kept.
  reject(new Error("aborted"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(internals.mode, "models");
  const body = rendered(picker);
  assert.ok(body.includes(MODELS_SHOWN));
  assert.match(body, /Download stopped — progress saved/);
});

test("a finished download reports success and marks the model downloaded", async (t) => {
  const { picker, internals, resolve } = controlledPicker();
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  resolve("/tmp/model.bin");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(internals.mode, "models");
  const body = rendered(picker);
  assert.match(body, /✓ Downloaded and selected /);
  assert.match(body, /● current/);
  assert.ok(internals.cachedById.size > 0);
});

test("advance post-activation policy completes immediately", async (t) => {
  const { picker, resolve, result } = controlledPicker("advance");
  t.after(() => picker.dispose());
  picker.handleInput(ENTER);
  resolve("/tmp/model.bin");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(result(), { type: "complete" });
});

test("advance policy also skips an extra pane for a downloaded model", async (t) => {
  const { picker, internals, resolve, result } = controlledPicker("advance");
  t.after(() => picker.dispose());
  const highlighted = internals.filtered[0]!;
  internals.cachedById.set(highlighted.id, { path: "/tmp/model.bin" });
  internals.refresh();

  picker.handleInput(ENTER);
  resolve("/tmp/model.bin");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(result(), { type: "complete" });
  assert.doesNotMatch(stripAnsi(rendered(picker)), /Model ready/);
});

test("model rows never overflow the render width", (t) => {
  const { picker, internals } = controlledPicker();
  t.after(() => picker.dispose());
  // Downloaded models carry the widest rows (checkmark plus size column);
  // mark a few before measuring.
  for (const model of internals.filtered.slice(0, 3)) {
    internals.cachedById.set(model.id, { path: "x" });
  }
  internals.refresh();
  for (const width of [80, 100]) {
    for (const line of picker.render(width)) {
      assert.ok(visibleWidth(line) <= width, `overflowing line at width ${width}: ${line}`);
    }
  }
});

test("language picker shows tab-to-continue inline on the action row", () => {
  const picker = new LanguagePicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    "skip for now",
    () => undefined,
  );

  const actionLine = picker.render(80).map(stripAnsi).find((line) => /tab\s+Continue/i.test(line));
  assert.ok(actionLine);
  assert.doesNotMatch(actionLine, /move|select|skip for now/);
});

test("opening preferred languages and pressing Escape preserves saved unbenchmarked languages", () => {
  let result: { languages: string[]; confirmed: boolean } | undefined;
  const picker = new LanguagePicker(testTui(), testTheme(), keybindings(), ["en", "af"], "back", (value) => { result = value; });
  assert.match(stripAnsi(picker.render(80).join("\n")), /Afrikaans/);
  picker.handleInput(ESC);
  assert.deepEqual(result, { languages: ["en", "af"], confirmed: false });
});

test("transcription language picker keeps auto detect and language codes", () => {
  const model = CATALOG_MODELS.find(
    (candidate) => candidate.capabilities.languageDetection && candidate.languages.length > 5,
  )!;
  let chosen: string | undefined;
  const picker = createTranscriptionLanguagePicker(
    testTui(),
    testTheme(),
    keybindings(),
    model,
    "auto",
    ["en"],
    (language) => {
      chosen = language;
    },
  );
  const lines = picker.render(80);
  assert.ok(lines.some((line) => line.includes("→ ● Auto detect")));
  // Multiple English variants keep their regional labels and codes.
  assert.ok(lines.some((line) => /English\s+en-US/.test(line)));
  // Preferred languages still sort first but carry no star marker.
  assert.ok(!lines.some((line) => line.includes("★")));
  picker.handleInput(ENTER);
  assert.equal(chosen, "auto");
});

test("only an exact-hash partial switches the footer to resume", (t) => {
  const { picker, internals } = controlledPicker();
  t.after(() => picker.dispose());
  const highlighted = internals.filtered[0]!;
  const blobsDirectory = join(
    process.env.HF_HUB_CACHE!,
    getRepoFolderName({ name: highlighted.repository, type: "model" }),
    "blobs",
  );
  mkdirSync(blobsDirectory, { recursive: true });

  // A stale partial from another revision must not promise a resume.
  const stalePath = join(blobsDirectory, `${"0".repeat(64)}.incomplete`);
  writeFileSync(stalePath, Buffer.alloc(1024, 1));
  t.after(() => rmSync(stalePath, { force: true }));
  internals.refresh();
  assert.match(rendered(picker), /download \d/);
  assert.doesNotMatch(rendered(picker), /resume download/);

  const partialPath = join(blobsDirectory, `${highlighted.sha256}.incomplete`);
  writeFileSync(partialPath, Buffer.alloc(1024, 1));
  t.after(() => rmSync(partialPath, { force: true }));
  internals.refresh();
  assert.match(rendered(picker), /resume download/);
});

const DOWN = `${ESC}[B`;

test("model picker fits an 80x24 terminal at every scroll position", (t) => {
  const picker = new CatalogModelPicker(
    testTui(24),
    testTheme(),
    keybindings(),
    ["en"],
    undefined,
    () => {},
    () => new Promise<{ path: string }>(() => {}),
    {},
  );
  t.after(() => picker.dispose());
  for (let step = 0; step < CATALOG_MODELS.length; step += 1) {
    const lines = picker.render(80);
    assert.ok(lines.length <= 22, `pane is ${lines.length} rows at step ${step}`);
    picker.handleInput(DOWN);
  }
  // The chrome survives even alongside the longest wrapped description.
  assert.match(stripAnsi(picker.render(80).join("\n")), /Choose a transcription model/);
});

test("model picker keeps the full window on tall terminals", (t) => {
  const build = (rows?: number) =>
    new CatalogModelPicker(
      testTui(rows),
      testTheme(),
      keybindings(),
      ["en"],
      undefined,
      () => {},
      () => new Promise<{ path: string }>(() => {}),
      {},
    );
  const tall = build(50);
  const unsized = build();
  t.after(() => {
    tall.dispose();
    unsized.dispose();
  });
  assert.equal(tall.render(80).length, unsized.render(80).length);
});

test("language picker fits an 80x24 terminal", () => {
  const picker = new LanguagePicker(
    testTui(24),
    testTheme(),
    keybindings(),
    ["en"],
    "close",
    () => {},
  );
  const lines = picker.render(80);
  assert.ok(lines.length <= 22, `pane is ${lines.length} rows`);
  const body = stripAnsi(lines.join("\n"));
  assert.match(body, /Select the languages you speak/);
  assert.match(body, /Continue/);
});

test("transcription language picker fits an 80x24 terminal", () => {
  const model = CATALOG_MODELS.find(
    (candidate) =>
      candidate.capabilities.languageDetection && candidate.languages.length > 20,
  )!;
  const picker = createTranscriptionLanguagePicker(
    testTui(24),
    testTheme(),
    keybindings(),
    model,
    "auto",
    ["en"],
    () => {},
  );
  const lines = picker.render(80);
  assert.ok(lines.length <= 22, `pane is ${lines.length} rows`);
});
