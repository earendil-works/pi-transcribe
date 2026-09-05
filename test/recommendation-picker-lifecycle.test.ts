import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CATALOG_MODELS } from "../src/catalog.js";
import type { CatalogModelActivation } from "../src/model-activation.js";
import { RecommendedModelPicker, type RecommendedModelResult } from "../src/recommendation-picker.js";
import { nextTurn } from "./helpers.js";
import { isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

function picker(activate: CatalogModelActivation, done: (result: RecommendedModelResult | undefined) => void, tui = testTui(24)) {
  return new RecommendedModelPicker(tui, testTheme(), keybindings(), ["en"],
    [{ model: CATALOG_MODELS[0]!, roles: ["best"], status: "eligible" }], activate, done);
}

test("recommendation keys map to the host's navigation actions", () => {
  for (const [key, type] of [["\t", "change-languages"], ["\x1b", "back"], ["o", "other-models"]] as const) {
    let result: RecommendedModelResult | undefined;
    const pane = picker(async () => { throw new Error("Navigation must not activate a model"); },
      (value) => { result = value; });
    try {
      pane.handleInput(key);
      assert.deepEqual(result, { type });
    } finally { pane.dispose(); }
  }
});

test("Escape during a download cancels without navigating away", async (t) => {
  isolatedModelCache(t);
  let signal: AbortSignal | undefined;
  const tui = testTui(24);
  const pane = picker((_model, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }, () => assert.fail("Download cancellation must keep the picker open"), tui);
  t.after(() => pane.dispose());
  pane.handleInput("\r");
  for (const [width, rows] of [[80, 24], [40, 16], [20, 10]] as const) {
    Object.assign(tui.terminal, { rows });
    const lines = pane.render(width);
    assert.ok(lines.length <= rows - 2 && lines.every((line) => visibleWidth(line) <= width));
    assert.match(stripAnsi(lines.join("\n")), /stop/);
  }
  Object.assign(tui.terminal, { rows: 24 });
  pane.handleInput("\x1b");
  assert.equal(signal?.aborted, true);
  await nextTurn();
  assert.match(stripAnsi(pane.render(80).join("\n")), /Download stopped/);
});
