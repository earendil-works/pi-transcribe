import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG_MODELS } from "../src/catalog.js";
import {
  accuracyGrade,
  languageAccuracyGrade,
  modelWaitSeconds,
  speedMeterLevel,
} from "../src/recommendations.js";

test("accuracy letters and modifiers change at the documented proportional boundaries", () => {
  const step = Math.cbrt(2);
  const boundaries: [number, string, string][] = [
    [5 / step ** 2, "A+", "A"],
    [5 / step, "A", "A-"],
    [5, "A-", "B+"],
    [10 / step ** 2, "B+", "B"],
    [10 / step, "B", "B-"],
    [10, "B-", "C+"],
    [20 / step ** 2, "C+", "C"],
    [20 / step, "C", "C-"],
    [20, "C-", "D"],
    [30, "D", "F"],
  ];
  assert.equal(accuracyGrade(0).label, "A+");
  for (const [boundary, below, at] of boundaries) {
    assert.equal(accuracyGrade(boundary - 1e-8).label, below);
    assert.equal(accuracyGrade(boundary).label, at);
  }
  assert.equal(accuracyGrade(150).label, "F");
  assert.equal(
    languageAccuracyGrade({ ...CATALOG_MODELS[0]!, id: "unmeasured" }, "en"),
    undefined,
  );
});

test("speed bars distinguish all six measured levels and unmeasured speed", () => {
  assert.equal(speedMeterLevel(0), 5);
  for (const [index, boundary] of [1.5, 3, 5, 10, 20].entries()) {
    assert.equal(speedMeterLevel(boundary - 1e-8), 5 - index);
    assert.equal(speedMeterLevel(boundary), 4 - index);
  }
  assert.equal(speedMeterLevel(100), 0);
  assert.equal(
    modelWaitSeconds({ ...CATALOG_MODELS[0]!, id: "unmeasured" }),
    undefined,
  );
});
