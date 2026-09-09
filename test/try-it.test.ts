import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { formatTryItTiming, needsFasterModel, TryItPane } from "../src/try-it.js";
import type { TranscribeSettings } from "../src/settings.js";
import type { TranscriptionService } from "../src/transcription-service.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

const settings: TranscribeSettings = {
  version: 1,
  backend: { type: "transcribe-cpp" },
  shortcut: "ctrl+alt+z",
  preferredLanguages: ["en"],
  transcriptionLanguage: "en",
  chineseOutput: "simplified",
  microphone: { type: "system-default" },
  model: {
    source: "catalog",
    id: "parakeet-unified-en-0.6b",
    path: "/tmp/model.gguf",
  },
};

function pendingService(): TranscriptionService {
  return {
    reserveDictation: () => ({
      ready: new Promise<void>(() => {}),
      feed() {},
      submit: async () => "",
      cancel() {},
    }),
  } as unknown as TranscriptionService;
}

test("Try It renders its configured controls", async () => {
  const pane = new TryItPane(
    testTui(24),
    testTheme(),
    keybindings(),
    settings,
    pendingService(),
    () => undefined,
  );
  const body = stripAnsi(pane.render(80).join("\n"));
  assert.match(body, /Try it/);
  assert.match(body, /Ctrl\+(Option|Alt)\+Z/);
  assert.match(body, /Ready to listen/);
  await pane.dispose();
});

test("Try It maps the settings shortcuts to host actions", async () => {
  const results: string[] = [];
  for (const [key, action] of [["m", "microphone"], ["s", "shortcut"], ["c", "model"]] as const) {
    const pane = new TryItPane(
      testTui(24),
      testTheme(),
      keybindings(),
      settings,
      pendingService(),
      (result) => results.push(result.action),
    );
    pane.handleInput(key);
    pane.handleInput(key);
    await pane.dispose();
    assert.equal(results.at(-1), action);
  }
});

test("Try It timing is plain data and the speed nudge ignores short takes", () => {
  assert.equal(
    formatTryItTiming(12.34, 1.4, "Qwen3-ASR 0.6B"),
    "12.3 s audio · 1.4 s to transcribe · 8.8× real time · Qwen3-ASR 0.6B",
  );
  assert.equal(needsFasterModel(30, 6), true);
  assert.equal(needsFasterModel(30, 5), false);
  assert.equal(needsFasterModel(3, 2), false);
  assert.equal(needsFasterModel(30, 0.3), false);
});
