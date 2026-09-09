import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import source from "../catalog/catalog.json" with { type: "json" };
import benchmark from "../catalog/recommendations.json" with { type: "json" };
import { CATALOG_MODELS } from "../src/catalog.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";

test("generated catalog matches its source and benchmarks contain no stale model IDs", () => {
  assert.deepEqual(CATALOG_MODELS, source.models);
  const ids = new Set(CATALOG_MODELS.map((model) => model.id));
  assert.equal(ids.size, CATALOG_MODELS.length);
  for (const id of Object.keys(benchmark.models)) {
    assert.ok(ids.has(id), `Stale benchmark: ${id}`);
  }
});

test("an unknown saved model requests reconfiguration without rewriting settings", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-transcribe-retired-model-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const current = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model");
  const saved = { ...current, model: { ...current.model, id: "retired-model" } };
  await writeSettings(saved);

  const result = await readSettings();
  assert.equal(result.settings, undefined);
  assert.match(result.warning ?? "", /configuration is required/);
  const onDisk = JSON.parse(
    await readFile(join(directory, "pi-transcribe.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(onDisk, saved);
});
