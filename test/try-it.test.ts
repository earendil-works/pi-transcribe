import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FakeCapture, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";
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

test("Try It pane shows the shortcut and microphone and fits a small terminal", () => {
  const pane = new TryItPane(
    testTui(24),
    testTheme(),
    keybindings(),
    settings,
    pendingService(),
    () => undefined,
  );
  const lines = pane.render(80);
  pane.dispose();
  assert.ok(lines.length <= 22);
  const body = stripAnsi(lines.join("\n"));
  assert.match(body, /3 of 3 · Try it/);
  assert.match(body, /Ctrl\+Option\+Z|Ctrl\+Alt\+Z/);
  assert.match(body, /Shortcut: Ctrl\+(Option|Alt)\+Z \(s to change\)/);
  assert.match(body, /Microphone: System default \(m to change\)/);
  assert.match(body, /Model: Parakeet Unified EN 0\.6B \(c to change\)/);
  assert.match(body, /Press Ctrl\+(Option|Alt)\+Z to start recording\. Press it again to stop\./);
  assert.match(body, /Ready to listen/);
  // Below the status sits the read-only preview, framed like Pi's editor.
  assert.match(body, /─{40,}\n\s*\n─{40,}/);
  assert.doesNotMatch(body, /›/);
  // The change keys live beside their settings, not in the footer.
  assert.doesNotMatch(body, /m microphone|s shortcut/);
  // Recording again is the shortcut itself; there is no separate reset key.
  assert.doesNotMatch(body, /try again/);
});

test("Try It pane leaves for the microphone and shortcut pickers", () => {
  const results: string[] = [];
  for (const key of ["m", "s", "c"]) {
    const pane = new TryItPane(
      testTui(24), testTheme(), keybindings(), settings, pendingService(),
      (result) => results.push(result.action),
    );
    pane.handleInput(key);
    pane.handleInput(key); // Closing a pane is idempotent.
    void pane.dispose();
  }
  assert.deepEqual(results, ["microphone", "shortcut", "model"]);
});

const TALK = "\x1b\x1a";

function interactivePane(configured = settings) {
  const service = fakeDictationService();
  const capture = new FakeCapture();
  const tui = testTui(24);
  const terminal = { rows: 24, columns: 80 };
  Object.assign(tui, { terminal });
  const results: string[] = [];
  let time = 0;
  const pane = new TryItPane(tui, testTheme(), keybindings(), configured, service,
    (result) => results.push(result.action),
    { createCapture: () => capture, now: () => time },
  );
  return { pane, service, capture, terminal, results, time: (value: number) => { time = value; } };
}

test("long results stay bounded, scroll fully, and survive narrow/tall resizes", async () => {
  const h = interactivePane({
    ...settings,
    microphone: { type: "device", name: "A very long microphone name ".repeat(20), occurrence: 0 },
  });
  h.capture.pcm = new Float32Array(30 * 16000);
  h.pane.handleInput(TALK);
  await nextTurn();
  assert.equal(h.capture.starts, 1);
  h.pane.handleInput(TALK);
  await nextTurn();
  h.time(6000);
  const transcript = ["FIRST_TOKEN", ...Array.from({ length: 80 }, (_, i) => `Line ${i}: English and 中文 wrapped transcript content.`), "FINAL_TOKEN"].join("\n");
  h.service.reservations[0]!.result.resolve(transcript);
  await nextTurn();
  for (const [columns, rows] of [[80, 24], [40, 16], [120, 50], [20, 10], [80, 24]]) {
    h.terminal.rows = rows!;
    h.terminal.columns = columns!;
    const lines = h.pane.render(columns!);
    assert.ok(lines.length <= rows! - 2, `${columns}x${rows}: ${lines.length} lines`);
    assert.ok(lines.every((line) => visibleWidth(line) <= columns!));
    h.pane.handleInput("\x1b[F"); // End
    assert.match(stripAnsi(h.pane.render(columns!).join("\n")), /FINAL_TOKEN/);
    h.pane.handleInput("\x1b[H"); // Home
    assert.match(stripAnsi(h.pane.render(columns!).join("\n")), /FIRST_TOKEN/);
  }
  assert.match(stripAnsi(h.pane.render(80).join("\n")), /lines.*scroll/);
  h.pane.handleInput("\x1b[6~"); // Page down
  assert.doesNotMatch(stripAnsi(h.pane.render(80).join("\n")), /FIRST_TOKEN/);
  h.pane.handleInput("\r");
  assert.deepEqual(h.results, ["done"]);
  await h.pane.dispose();
});

test("long model errors use the same bounded scrollable preview", async () => {
  const h = interactivePane();
  h.service.reservations[0]!.prepared.reject(new Error("Model failed\n".repeat(100) + "ERROR_TAIL"));
  await nextTurn();
  const lines = h.pane.render(80);
  assert.ok(lines.length <= 22);
  assert.match(stripAnsi(lines.join("\n")), /Could not load the model/);
  h.pane.handleInput("\x1b[F");
  assert.match(stripAnsi(h.pane.render(80).join("\n")), /ERROR_TAIL/);
  h.pane.handleInput("\x1b");
  assert.deepEqual(h.results, ["skip"]);
  await h.pane.dispose();
});

test("Try it discards a take, retries, and never accepts a cancelled result", async () => {
  const h = interactivePane();
  h.pane.handleInput(TALK);
  await nextTurn();
  h.pane.handleInput("\x1b");
  await nextTurn();
  assert.match(stripAnsi(h.pane.render(80).join("\n")), /Ready to listen/);
  h.pane.handleInput(TALK);
  await nextTurn();
  h.pane.handleInput(TALK);
  await nextTurn();
  h.pane.handleInput("\x1b");
  h.service.reservations[1]!.result.resolve("discarded transcript");
  await nextTurn();
  assert.doesNotMatch(stripAnsi(h.pane.render(80).join("\n")), /discarded transcript/);
  assert.equal(h.capture.stops, 2);
  await h.pane.dispose();
});

test("Try It timing line is plain data and the nudge follows the real-time factor", () => {
  assert.equal(
    formatTryItTiming(12.34, 1.4, "Qwen3-ASR 0.6B"),
    "12.3 s audio · 1.4 s to transcribe · 8.8× real time · Qwen3-ASR 0.6B",
  );
  // Below the speed the pick was chosen for, 30 s back within 5 s.
  assert.equal(needsFasterModel(30, 6), true);
  assert.equal(needsFasterModel(30, 5), false);
  assert.equal(needsFasterModel(12, 2.5), true);
  // A short take says nothing: fixed costs dominate.
  assert.equal(needsFasterModel(3, 2), false);
  // A streaming model that kept up finishes almost at once and is never nudged.
  assert.equal(needsFasterModel(30, 0.3), false);
});
