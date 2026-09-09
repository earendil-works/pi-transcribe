import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CATALOG_MODELS, type CatalogModel } from "../src/catalog.js";
import {
  CatalogModelPicker,
  createTranscriptionLanguagePicker,
  LanguagePicker,
  type CatalogModelPickerResult,
  type CatalogModelPostActivation,
} from "../src/model-picker.js";
import { nextTurn } from "./helpers.js";
import { isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");
const ESC = "\u001b";
const ENTER = "\r";

type ActivationOptions = {
  cached: unknown;
  signal: AbortSignal;
  onProgress: (progress: { downloaded: number; total: number }) => void;
};

function controlledPicker(
  t: TestContext,
  postActivation: CatalogModelPostActivation = "stay",
) {
  isolatedModelCache(t);
  let options: ActivationOptions | undefined;
  let completed: CatalogModelPickerResult | undefined;
  let resolveActivation!: (value: { path: string }) => void;
  let rejectActivation!: (error: unknown) => void;
  const picker = new CatalogModelPicker(
    testTui(24),
    testTheme(),
    keybindings(),
    ["en"],
    undefined,
    (result) => {
      completed = result;
    },
    (_model: CatalogModel, activationOptions: ActivationOptions) => {
      options = activationOptions;
      return new Promise<{ path: string }>((resolve, reject) => {
        resolveActivation = resolve;
        rejectActivation = reject;
      });
    },
    { postActivation },
  );
  t.after(() => picker.dispose());
  return {
    picker,
    resolve: (path: string) => resolveActivation({ path }),
    reject: (error: unknown) => rejectActivation(error),
    signal: () => options!.signal,
    progress: (downloaded: number, total: number) =>
      options!.onProgress({ downloaded, total }),
    result: () => completed,
  };
}

function rendered(picker: CatalogModelPicker): string {
  return stripAnsi(picker.render(100).join("\n"));
}

test("Enter starts a download and Escape cancels it without closing the picker", async (t) => {
  const h = controlledPicker(t);
  assert.match(rendered(h.picker), /enter.*download \d/);

  h.picker.handleInput(ENTER);
  h.progress(1_260_000_000, 3_000_000_000);
  assert.match(rendered(h.picker), /Downloading/);
  assert.match(rendered(h.picker), /42%/);

  h.picker.handleInput(ESC);
  assert.equal(h.signal().aborted, true);
  assert.match(rendered(h.picker), /Stopping/);
  h.reject(new Error("aborted"));
  await nextTurn();

  assert.match(rendered(h.picker), /Download stopped/);
  assert.match(rendered(h.picker), new RegExp(`${CATALOG_MODELS.length} models`));
  assert.equal(h.result(), undefined);
});

test("a completed download returns to the list and marks the selected model", async (t) => {
  const h = controlledPicker(t);
  h.picker.handleInput(ENTER);
  h.resolve("/tmp/model.bin");
  await nextTurn();

  const body = rendered(h.picker);
  assert.match(body, /Downloaded and selected/);
  assert.match(body, /● current/);
});

test("advance policy completes after activation", async (t) => {
  const h = controlledPicker(t, "advance");
  h.picker.handleInput(ENTER);
  h.resolve("/tmp/model.bin");
  await nextTurn();
  assert.deepEqual(h.result(), { type: "complete" });
});

test("language picker exposes Continue as a fixed Tab action", () => {
  let result: unknown;
  const picker = new LanguagePicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    "skip for now",
    (value) => {
      result = value;
    },
  );
  assert.match(stripAnsi(picker.render(80).join("\n")), /tab\s+Continue/i);
  picker.handleInput("\t");
  assert.deepEqual(result, { languages: ["en"], confirmed: true });
});

test("Escape preserves saved languages that are no longer recommended", () => {
  let result: unknown;
  const picker = new LanguagePicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en", "af"],
    "back",
    (value) => {
      result = value;
    },
  );
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
  assert.ok(lines.some((line) => /English\s+en-US/.test(line)));
  assert.ok(!lines.some((line) => line.includes("★")));
  picker.handleInput(ENTER);
  assert.equal(chosen, "auto");
});
