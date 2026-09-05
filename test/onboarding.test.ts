import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Deferred } from "../src/deferred.js";
import {
  CatalogModelPicker,
  LanguagePicker,
  type CatalogModelActivation,
} from "../src/model-picker.js";
import { changeOnboardingModel, runOnboarding } from "../src/onboarding.js";
import { RecommendedModelPicker } from "../src/recommendation-picker.js";
import { findCachedCatalogModel } from "../src/models.js";
import { getCatalogModel } from "../src/catalog.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";
import { isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

type Step = (pane: Component, done: (value: unknown) => void) => void | Promise<void>;

function scriptedContext(steps: Step[]) {
  let index = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        const pane = await factory(
          testTui(24), testTheme(), keybindings() as Parameters<typeof factory>[2],
          (value) => result.resolve(value),
        );
        try {
          const step = steps[index++];
          assert.ok(step, `Unexpected pane: ${pane.constructor.name}`);
          await step(pane, (value) => result.resolve(value));
          return await result.promise;
        } finally {
          pane.dispose?.();
        }
      },
      notify: (message: string) => { assert.fail(`Unexpected notification: ${message}`); },
    },
  } as unknown as ExtensionContext;
  return { ctx, assertFinished: () => assert.equal(index, steps.length) };
}

function isolatedSettings(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-transcribe-onboarding-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

function initialSettings(languages = ["en"]) {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/current-model", {
    preferredLanguages: languages,
    shortcut: "ctrl+alt+z",
    microphone: { type: "device", name: "Test microphone", occurrence: 1 },
    chineseOutput: "traditional-taiwan",
  });
}

/** Exercise the real commit pipeline with tiny cache fixtures, not downloads. */
function selectRecommended(cache: ReturnType<typeof isolatedModelCache>): Step {
  return (pane) => {
    assert.ok(pane instanceof RecommendedModelPicker);
    const body = stripAnsi(pane.render(80).join("\n"));
    assert.match(body, /English.*Mandarin/);
    assert.match(body, /Qwen3-ASR 0\.6B/);
    const internals = pane as unknown as { activate: CatalogModelActivation };
    const activate = internals.activate;
    internals.activate = (model, options) => {
      const fixture = cache(model);
      return activate(fixture, { ...options, cached: findCachedCatalogModel(fixture) });
    };
    pane.handleInput("\x1b[A"); // Expanded pane starts on the first alternative.
    pane.handleInput("\r");
  };
}

for (const entry of ["recommended", "other-models", "single-pick"] as const) {
  test(`Try it changes languages from ${entry}, recomputes picks, and saves them with the model`, async (t) => {
    isolatedSettings(t);
    const cache = isolatedModelCache(t);
    const current = initialSettings(entry === "single-pick" ? ["en", "bs"] : ["en"]);
    await writeSettings(current);
    const steps: Step[] = [];
    if (entry === "other-models") {
      steps.push((pane) => {
        assert.ok(pane instanceof RecommendedModelPicker);
        pane.handleInput("o");
      });
    }
    steps.push(
      (pane) => {
        assert.ok(entry === "recommended"
          ? pane instanceof RecommendedModelPicker
          : pane instanceof CatalogModelPicker);
        pane.handleInput?.("\t");
      },
      (pane, done) => {
        assert.ok(pane instanceof LanguagePicker);
        done({ languages: ["en", "zh"], confirmed: true });
      },
      selectRecommended(cache),
    );
    const script = scriptedContext(steps);
    const result = await changeOnboardingModel(script.ctx, current);
    script.assertFinished();
    assert.ok(result);
    assert.deepEqual(result.preferredLanguages, ["en", "zh"]);
    assert.equal(result.model.id, "Qwen3-ASR-0.6B");
    assert.equal(result.shortcut, current.shortcut);
    assert.deepEqual(result.microphone, current.microphone);
    assert.equal(result.chineseOutput, current.chineseOutput);
    assert.deepEqual((await readSettings()).settings, result);

    // A later visit uses the newly saved languages, not the first-run closure.
    const revisit = scriptedContext([(pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      assert.match(stripAnsi(pane.render(80).join("\n")), /English.*Mandarin/);
      pane.handleInput("\x1b");
    }]);
    assert.equal(await changeOnboardingModel(revisit.ctx, result), undefined);
    revisit.assertFinished();
  });
}

test("cancelling the language picker returns to its model pane without applying edits", async (t) => {
  isolatedSettings(t);
  const current = initialSettings();
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => pane.handleInput?.("\t"),
    (pane, done) => {
      assert.ok(pane instanceof LanguagePicker);
      done({ languages: ["en", "zh"], confirmed: false });
    },
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      assert.doesNotMatch(stripAnsi(pane.render(80).join("\n")), /Mandarin/);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await changeOnboardingModel(script.ctx, current), undefined);
  script.assertFinished();
  assert.deepEqual((await readSettings()).settings, current);
});

test("back after confirming new languages leaves settings unchanged until a model is selected", async (t) => {
  isolatedSettings(t);
  const current = initialSettings();
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => pane.handleInput?.("\t"),
    (_pane, done) => done({ languages: ["en", "zh"], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      assert.match(stripAnsi(pane.render(80).join("\n")), /Mandarin/);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await changeOnboardingModel(script.ctx, current), undefined);
  script.assertFinished();
  assert.deepEqual((await readSettings()).settings, current);
});

test("exiting first-run languages after a committed selection preserves saved settings", async (t) => {
  isolatedSettings(t);
  const cache = isolatedModelCache(t);
  const script = scriptedContext([
    (_pane, done) => done({ languages: ["en"], confirmed: true }),
    async (pane, done) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      // The controller can finish a cached save before honoring pending Back.
      const model = cache(getCatalogModel("parakeet-unified-en-0.6b")!);
      const activation = (pane as unknown as { activate: CatalogModelActivation }).activate;
      await activation(model, {
        cached: findCachedCatalogModel(model), signal: new AbortController().signal,
        onProgress() {},
      });
      done({ type: "back" });
    },
    (_pane, done) => done(undefined),
  ]);
  const configured = await runOnboarding(script.ctx);
  script.assertFinished();
  assert.ok(configured);
  assert.deepEqual((await readSettings()).settings, configured);
});

test("Escape from the initial recommendation still goes back to languages", async () => {
  const script = scriptedContext([
    (_pane, done) => done({ languages: ["en"], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b");
    },
    (pane, done) => {
      assert.ok(pane instanceof LanguagePicker);
      done(undefined);
    },
  ]);
  assert.equal(await runOnboarding(script.ctx), undefined);
  script.assertFinished();
});
