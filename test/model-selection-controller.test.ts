import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_MODELS } from "../src/catalog.js";
import { Deferred } from "../src/deferred.js";
import type { CatalogModelActivation } from "../src/model-activation.js";
import { ModelSelectionController } from "../src/model-selection-controller.js";
import { nextTurn } from "./helpers.js";

const [first, second] = CATALOG_MODELS;

function harness(cached = true, advance = false) {
  const calls: { options: Parameters<CatalogModelActivation>[1]; result: Deferred<{ path: string }> }[] = [];
  const exits: (string | undefined)[] = [];
  let changes = 0;
  let now = 0;
  const controller = new ModelSelectionController<string | undefined>((_model, options) => {
    const result = new Deferred<{ path: string }>();
    calls.push({ options, result });
    return result.promise;
  }, {
    models: [first!, second!],
    findCached: () => cached ? { path: "/tmp/cached" } : undefined,
    advance,
    completion: "complete",
    onChange: () => { changes++; },
    onExit: (result) => exits.push(result),
    now: () => now,
  });
  return { controller, calls, exits, changes: () => changes, time: (value: number) => { now = value; } };
}

test("superseded commits remain factual even when the latest selection fails", async () => {
  const h = harness();
  h.controller.select(first!);
  h.controller.select(second!);
  assert.equal(h.calls[0]!.options.signal.aborted, true);
  h.calls[0]!.result.resolve({ path: "/tmp/first" });
  await nextTurn();
  assert.equal(h.controller.committedModelId, first!.id);
  assert.equal(h.controller.displayedModelId, second!.id);
  h.calls[1]!.result.reject(new Error("disk full"));
  await nextTurn();
  assert.equal(h.controller.displayedModelId, first!.id);
  assert.match(h.controller.feedback!.text, /disk full/);
  h.controller.dispose();
});

test("reselecting an in-flight model waits for the actual commit", async () => {
  const h = harness(true, true);
  h.controller.select(first!);
  h.controller.select(first!);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.exits, []);
  h.calls[0]!.result.resolve({ path: "/tmp/first" });
  await nextTurn();
  assert.deepEqual(h.exits, []);
  h.calls[1]!.result.resolve({ path: "/tmp/first" });
  await nextTurn();
  assert.deepEqual(h.exits, ["complete"]);
  h.controller.dispose();
});

test("disposed saves still record committed state but never repaint or exit", async () => {
  const h = harness(true, true);
  h.controller.select(first!);
  h.controller.requestExit(undefined);
  h.controller.dispose();
  const before = h.changes();
  assert.equal(h.calls[0]!.options.signal.aborted, false);
  h.calls[0]!.result.resolve({ path: "/tmp/saved" });
  await nextTurn();
  assert.equal(h.controller.committedModelId, first!.id);
  assert.deepEqual(h.exits, []);
  assert.equal(h.changes(), before);
});

test("download progress, speed, stopping, and retry belong to the controller", async () => {
  const h = harness(false);
  h.controller.select(first!);
  h.calls[0]!.options.onProgress({ downloaded: 100, total: 1000 });
  h.time(1000);
  h.calls[0]!.options.onProgress({ downloaded: 600, total: 1000 });
  assert.equal(h.controller.downloadSpeed, 500);
  assert.match(h.controller.download!.message, /Resuming/);
  h.controller.requestExit("back");
  assert.deepEqual(h.exits, []);
  h.controller.cancelDownload();
  h.calls[0]!.options.onProgress({ downloaded: 900, total: 1000 });
  assert.equal(h.controller.download!.downloaded, 600);
  assert.equal(h.controller.download!.message, "Stopping…");
  h.calls[0]!.result.reject(new Error("cancelled"));
  await nextTurn();
  assert.equal(h.controller.download, undefined);
  assert.match(h.controller.feedback!.text, /Download stopped/);
  h.controller.select(first!);
  assert.equal(h.calls.length, 2);
  h.calls[1]!.result.resolve({ path: "/tmp/model" });
  await nextTurn();
  assert.equal(h.controller.committedModelId, first!.id);
  h.controller.dispose();
});

test("a synchronously throwing activation stays in the retryable error state", async () => {
  const controller = new ModelSelectionController(() => { throw new Error("sync failure"); }, {
    models: [], advance: true, completion: "complete", findCached: () => undefined,
    onChange() {}, onExit() { assert.fail("must not exit"); },
  });
  controller.select(first!);
  await nextTurn();
  assert.match(controller.feedback!.text, /sync failure/);
  assert.equal(controller.acceptsInput, true);
  controller.dispose();
});
