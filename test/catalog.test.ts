import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import source from "../catalog/catalog.json" with { type: "json" };
import benchmark from "../catalog/recommendations.json" with { type: "json" };
import { CATALOG_MODELS, getCatalogModel } from "../src/catalog.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";

// Explicit curation decisions, not a rule that automatically cuts frontier losers.
const REMOVED_MODELS = [
  "moonshine-base",
  "moonshine-base-zh",
  "moonshine-streaming-small",
  "moonshine-streaming-medium",
  "moonshine-tiny-ar",
  "moonshine-base-ar",
  "whisper-small.en",
  "whisper-medium.en",
  "whisper-large",
  "parakeet-ctc-1.1b",
  "parakeet-tdt-1.1b",
  "parakeet-rnnt-1.1b",
  "parakeet-tdt_ctc-1.1b",
  "canary-1b",
  "Voxtral-Small-24B-2507",
  "granite-4.0-1b-speech",
  "granite-speech-4.1-2b-nar",
  "granite-speech-4.1-2b-plus",
  // Lowercase output without punctuation: unusable for dictation.
  "parakeet-ctc-0.6b",
  "parakeet-rnnt-0.6b",
  // Superseded by canary-1b-v2: same speed, worse in all four of its languages.
  "canary-1b-flash",
  // Lowercase Cyrillic only: no punctuation, digits, or Latin letters.
  "gigaam-v3-ctc",
  "gigaam-v3-rnnt",
  // Superseded by parakeet-unified-en-0.6b at this app's chunk size.
  "nemotron-speech-streaming-en-0.6b",
  // Moonshine: never a pick, dominated by SenseVoice / Whisper Tiny / Parakeet 110M,
  // and the language variants carry a non-MIT community license.
  "moonshine-tiny",
  "moonshine-streaming-tiny",
  "moonshine-tiny-zh",
  ...["ja", "ko", "uk", "vi"].flatMap((language) => [`moonshine-tiny-${language}`, `moonshine-base-${language}`]),
  // Large v3 is better or equal in every measured language at the same speed.
  "whisper-large-v2",
  // Never a pick; only on the frontier as the fastest usable row by a sliver.
  // Parakeet TDT-CTC 110M and Canary 180M Flash cover the same tier far better.
  "whisper-tiny",
  "whisper-tiny.en",
  "whisper-base",
  "whisper-base.en",
];

test("generated catalog matches its source and benchmarks contain no stale model IDs", () => {
  assert.deepEqual(CATALOG_MODELS, source.models);
  const ids = new Set(CATALOG_MODELS.map((model) => model.id));
  assert.equal(ids.size, CATALOG_MODELS.length);
  for (const id of Object.keys(benchmark.models)) assert.ok(ids.has(id), `Stale benchmark: ${id}`);
});

test("the agreed model variants are absent from both the catalog and benchmarks", () => {
  for (const id of REMOVED_MODELS) {
    assert.equal(getCatalogModel(id), undefined, id);
    assert.equal(Object.hasOwn(benchmark.models, id), false, id);
  }
});

test("curation preserves the chosen Granite representative and requested specialist models", () => {
  assert.deepEqual(CATALOG_MODELS.filter((model) => model.id.startsWith("granite-")).map((model) => model.id),
    ["granite-speech-4.1-2b"]);
  for (const id of [
    "gigaam-v3-e2e-ctc", "gigaam-v3-e2e-rnnt",
    "nemotron-3.5-asr-streaming-0.6b",
    "multitalker-parakeet-streaming-0.6b-v1", "Breeze-ASR-25", "medasr",
    "Voxtral-Mini-3B-2507", "Voxtral-Mini-4B-Realtime-2602",
    "whisper-small", "whisper-medium", "whisper-large-v3", "whisper-large-v3-turbo",
    "canary-180m-flash", "canary-1b-v2", "canary-qwen-2.5b",
    "parakeet-unified-en-0.6b",
    "parakeet-tdt-0.6b-v2", "parakeet-tdt-0.6b-v3", "parakeet-tdt_ctc-110m",
  ]) assert.ok(getCatalogModel(id), `Required retained model: ${id}`);
});

test("saved removed model IDs request reconfiguration without rewriting the user's settings", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-transcribe-retired-model-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const current = settingsForModel("parakeet-unified-en-0.6b", "/tmp/retained-model");
  for (const id of REMOVED_MODELS) {
    const saved = { ...current, model: { ...current.model, id } };
    await writeSettings(saved);
    const result = await readSettings();
    assert.equal(result.settings, undefined, id);
    assert.match(result.warning ?? "", /configuration is required/, id);
    const onDisk: unknown = JSON.parse(await readFile(join(directory, "pi-transcribe.json"), "utf8"));
    assert.deepEqual(onDisk, saved, "Reading an obsolete selection must not change settings on disk");
  }
  await writeSettings(current);
  assert.deepEqual(await readSettings(), { settings: current });
});
