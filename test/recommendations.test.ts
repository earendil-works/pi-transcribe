import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import benchmark from "../catalog/recommendations.json" with { type: "json" };
import { CATALOG_MODELS, getCatalogLanguages } from "../src/catalog.js";
import { hasRecommendedAlternatives, RecommendedModelPicker } from "../src/recommendation-picker.js";
import { EXPERIMENTAL_MAX_ERROR_PERCENT, getPreferredRecommendationLanguages, recommendModels, type ModelRecommendation } from "../src/recommendations.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");
const ALL_ROLES = ["accurate", "best", "fast"];
const languages = getCatalogLanguages();

test("English worked example: Parakeet balances speed and accuracy; Qwen is the accuracy alternative", () => {
  const picks = recommendModels(CATALOG_MODELS, ["en"]);
  assert.equal(picks[0]?.model.id, "parakeet-unified-en-0.6b");
  assert.deepEqual(picks[0]?.roles, ["best", "fast"]);
  assert.equal(picks.find((pick) => pick.roles.includes("accurate"))?.model.id, "Qwen3-ASR-1.7B");
});

test("every role is assigned and usable models never mix with over-floor alternatives", () => {
  for (const language of languages) {
    for (const wanted of [[language], ["en", language]]) {
      const picks = recommendModels(CATALOG_MODELS, wanted);
      assert.deepEqual(picks.flatMap((pick) => pick.roles).sort(), ALL_ROLES, wanted.join("+"));
      if (picks.some((pick) => pick.status === "eligible")) {
        assert.ok(picks.every((pick) => pick.status === "eligible" && !pick.overFloor));
        assert.ok(picks.every((pick) => pick.worstError! < benchmark.methodology.maxLanguageErrorPercent));
      } else {
        assert.equal(picks.length, 1, "Fallbacks carry all roles, not competing recommendations");
      }
    }
  }
});

test("the note band covers exactly the usable picks that reach it", () => {
  const { noteMinErrorPercent, maxLanguageErrorPercent } = benchmark.methodology;
  assert.ok(noteMinErrorPercent < maxLanguageErrorPercent);
  let flagged = 0;
  for (const language of languages) {
    for (const wanted of [[language], ["en", language]]) {
      for (const pick of recommendModels(CATALOG_MODELS, wanted)) {
        const inBand = pick.worstError !== undefined &&
          pick.worstError >= noteMinErrorPercent && pick.worstError < maxLanguageErrorPercent;
        assert.equal(pick.nearFloor ?? false, inBand, `${wanted.join("+")} ${pick.model.id}`);
        if (pick.nearFloor) flagged += 1;
      }
    }
  }
  // A band that describes nothing, or everything, would not be worth stating.
  assert.ok(flagged > 0 && flagged < languages.length);
});

test("aliases produce identical recommendations", () => {
  for (const [alias, canonical] of [["tl", "fil"], ["no", "nb"]] as const) {
    assert.deepEqual(recommendModels(CATALOG_MODELS, ["en", alias]), recommendModels(CATALOG_MODELS, ["en", canonical]));
  }
});

test("fallback statuses and preferred-language visibility follow the methodology", () => {
  const models: Record<string, { accuracy: Record<string, { ciLower?: number }> }> = benchmark.models;
  const preferred = new Set(getPreferredRecommendationLanguages(CATALOG_MODELS));
  for (const language of languages) {
    const pick = recommendModels(CATALOG_MODELS, [language])[0]!;
    if (pick.error === undefined) assert.equal(pick.status, "unbenchmarked");
    else if (pick.overFloor) {
      const lower = models[pick.model.id]?.accuracy[pick.worstLanguage!]?.ciLower;
      const experimental = pick.worstError! < EXPERIMENTAL_MAX_ERROR_PERCENT ||
        (lower !== undefined && lower <= EXPERIMENTAL_MAX_ERROR_PERCENT);
      assert.equal(pick.status, experimental ? "experimental" : "unsupported");
    }
    assert.equal(preferred.has(language), ["eligible", "experimental"].includes(pick.status));
  }
  const unmeasured = { ...CATALOG_MODELS[0]!, id: "unmeasured" };
  assert.equal(recommendModels([unmeasured], ["en"])[0]?.status, "unbenchmarked");
  assert.deepEqual(recommendModels([], ["en"]), []);
});

// UI fixtures describe roles, not the current winners of the benchmark database.
const recommendations: ModelRecommendation[] = ["Balanced", "Quick", "Precise"].map((name, index) => ({
  model: {
    ...CATALOG_MODELS[0]!, id: `test-${name}`, name, languages: ["en", "zh"],
    capabilities: { ...CATALOG_MODELS[0]!.capabilities, languageDetection: true },
  },
  roles: [(["best", "fast", "accurate"] as const)[index]!],
  status: "eligible",
}));
function pane(picks = recommendations, expanded = false, rows = 24) {
  const tui = testTui(rows);
  const picker = new RecommendedModelPicker(tui, testTheme(), keybindings(), ["en", "zh"], picks,
    async () => ({ path: "/tmp/model" }), () => {}, { expanded });
  return { picker, tui, body: () => stripAnsi(picker.render(80).join("\n")) };
}

test("recommendations fold and expand in place, keeping the focused choice visible on resize", (t) => {
  const h = pane();
  t.after(() => h.picker.dispose());
  assert.equal(hasRecommendedAlternatives(recommendations), true);
  assert.match(h.body(), /→ Balanced/);
  assert.match(h.body(), /For faster or more accurate transcriptions/);
  assert.doesNotMatch(h.body(), /Quick|Precise/);
  assert.doesNotMatch(h.body(), /Show all models/);
  h.picker.handleInput("\x1b[B");
  h.picker.handleInput("\r");
  assert.match(h.body(), /→ Quick/);
  assert.match(h.body(), /Precise/);
  assert.doesNotMatch(h.body(), /Other options/);
  // Unfolding consumes the only invitation to look further, so the catalog
  // takes its place rather than leaving the pane without a way onward.
  assert.match(h.body(), /Show all models/);
  for (const [width, rows] of [[80, 24], [40, 24], [40, 16], [20, 10], [120, 50]] as const) {
    Object.assign(h.tui.terminal, { rows });
    for (const focused of ["Quick", "Precise", "Show all models", "Balanced"]) {
      const lines = h.picker.render(width);
      assert.ok(lines.length <= rows - 2 && lines.every((line) => visibleWidth(line) <= width));
      assert.ok(stripAnsi(lines.join("\n")).includes(`→ ${focused}`));
      assert.match(stripAnsi(lines.join("\n")), /enter/);
      h.picker.handleInput("\x1b[B");
    }
  }
  const expanded = pane(recommendations, true);
  t.after(() => expanded.picker.dispose());
  assert.match(expanded.body(), /→ Quick/);
});

test("a pick that carries every role still offers the whole catalog", (t) => {
  // Roughly a third of the catalog's languages have one model that is at once
  // the balanced, fastest, and most accurate choice. Nothing unfolds there,
  // so the browse row is the only visible way to explore.
  for (const status of ["eligible", "experimental"] as const) {
    const only = (): ModelRecommendation => ({
      ...recommendations[0]!, roles: ["best", "fast", "accurate"], status, worstLanguage: "zh",
    });
    const h = pane([only()]);
    t.after(() => h.picker.dispose());
    assert.equal(hasRecommendedAlternatives([only()]), false);
    assert.match(h.body(), /→ Balanced/);
    assert.match(h.body(), /Show all models/);
    assert.doesNotMatch(h.body(), /Other options|Browse models anyway/);
    let exit: unknown;
    const reachable = new RecommendedModelPicker(testTui(24), testTheme(), keybindings(), ["en", "zh"],
      [only()], async () => ({ path: "/tmp/model" }), (result) => { exit = result; });
    t.after(() => reachable.dispose());
    reachable.handleInput("\x1b[B");
    assert.match(stripAnsi(reachable.render(80).join("\n")), /→ Show all models/);
    reachable.handleInput("\r");
    assert.deepEqual(exit, { type: "other-models" });
  }
});

test("a shortfall every pick shares is stated once; one that separates them is tagged per row", (t) => {
  const near = (pick: ModelRecommendation): ModelRecommendation =>
    ({ ...pick, nearFloor: true, worstLanguage: "zh", worstError: 18 });

  // Shared by all three, so it belongs to the language: one line, no tags.
  const shared = pane(recommendations.map(near), true, 50);
  t.after(() => shared.picker.dispose());
  assert.match(shared.body(), /Every model here is less accurate in Mandarin \(Chinese\)/);
  assert.doesNotMatch(shared.body(), /Lower accuracy in/);

  // True of the balanced pick alone, so it distinguishes it: tagged once.
  const mixed = pane([near(recommendations[0]!), recommendations[1]!, recommendations[2]!], true, 50);
  t.after(() => mixed.picker.dispose());
  assert.doesNotMatch(mixed.body(), /Every model here is less accurate/);
  assert.equal(mixed.body().match(/Lower accuracy in Mandarin \(Chinese\)\./g)?.length, 1);

  // Folding must not change the story, only how much of it is on screen.
  const folded = pane(recommendations.map(near), false, 50);
  t.after(() => folded.picker.dispose());
  assert.match(folded.body(), /Every model here is less accurate in Mandarin \(Chinese\)/);

  const clean = pane(recommendations, true, 50);
  t.after(() => clean.picker.dispose());
  assert.doesNotMatch(clean.body(), /less accurate|Lower accuracy/);
});

test("fallback panes distinguish experimental recommendations from unsupported or unmeasured models", (t) => {
  for (const status of ["experimental", "unsupported", "unbenchmarked"] as const) {
    const pick = { ...recommendations[0]!, status, worstLanguage: "en" };
    const h = pane([pick]);
    t.after(() => h.picker.dispose());
    assert.equal(hasRecommendedAlternatives([pick]), false);
    if (status === "experimental") {
      assert.match(h.body(), /Experimental:.*best option/);
      assert.match(h.body(), /→ Balanced/);
    } else {
      assert.match(h.body(), /→ Browse models anyway/);
      assert.doesNotMatch(h.body(), /Balanced/);
      assert.ok(h.body().includes(status === "unsupported"
        ? `${EXPERIMENTAL_MAX_ERROR_PERCENT}% benchmark error`
        : "measured accuracy is unavailable"));
    }
    Object.assign(h.tui.terminal, { rows: 16 });
    assert.ok(h.picker.render(40).length <= 14);
  }
});
