import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getCatalogModel, type CatalogModel } from "../src/catalog.js";
import { YourModelsPicker } from "../src/your-models-picker.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

function cacheModels(
  cache: (model: CatalogModel) => CatalogModel,
  ids: readonly string[],
): void {
  for (const id of ids) cacheCatalogModel(cache, getCatalogModel(id)!);
}

test("your models opens with the current model first", (t) => {
  const cache = isolatedModelCache(t);
  cacheModels(cache, ["parakeet-tdt-0.6b-v3", "canary-1b-v2", "whisper-small"]);
  const picker = new YourModelsPicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    "whisper-small",
    () => undefined,
    () => new Promise(() => undefined),
  );
  t.after(() => picker.dispose());

  const modelLines = picker
    .render(80)
    .map(stripAnsi)
    .filter((line) => /Whisper Small|Parakeet TDT|Canary 1B/.test(line));
  assert.match(modelLines[0]!, /→.*Whisper Small/);
  assert.equal(modelLines.length, 3);
});

test("your models marks models that require manual language selection", (t) => {
  const cache = isolatedModelCache(t);
  cacheModels(cache, ["parakeet-tdt-0.6b-v3", "Qwen3-ASR-1.7B", "canary-1b-v2"]);
  const picker = new YourModelsPicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en", "de"],
    "canary-1b-v2",
    () => undefined,
    () => new Promise(() => undefined),
  );
  t.after(() => picker.dispose());

  const rows = stripAnsi(picker.render(100).join("\n"));
  assert.doesNotMatch(rows, /\b(?:Best|Fast|Accurate)\b/);
  assert.match(rows, /Canary 1B.*manual lang/);
});

test("Tab browses the catalog and Shift+Tab changes languages", (t) => {
  isolatedModelCache(t);
  const results: unknown[] = [];
  const make = () => new YourModelsPicker(
    testTui(),
    testTheme(),
    keybindings(),
    ["en"],
    undefined,
    (result) => results.push(result),
    () => {
      throw new Error("navigation must not activate a model");
    },
  );

  const browse = make();
  t.after(() => browse.dispose());
  assert.match(stripAnsi(browse.render(80).join("\n")), /Browse all models/);
  browse.handleInput("\t");

  const languages = make();
  t.after(() => languages.dispose());
  languages.handleInput("\x1b[Z");

  assert.deepEqual(results, [{ type: "browse" }, { type: "change-languages" }]);
});
