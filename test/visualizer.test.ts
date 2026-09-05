import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMeterLine, SpectrumAnalyzer } from "../src/visualizer.js";
import { stripAnsi, testTheme } from "./ui-helpers.js";

test("meter line carries the bands, elapsed time, model state, and hint", () => {
  const silent = new SpectrumAnalyzer();
  const line = stripAnsi(
    renderMeterLine(testTheme(), {
      bands: silent.bands,
      elapsedMs: 65_000,
      modelState: "loading",
      hint: "esc to cancel",
    }),
  );
  assert.equal(line, `${"▁".repeat(silent.bands.length)}  1:05  loading model  esc to cancel`);
});

test("analyzer levels rise on a tone and decay on silence", () => {
  const analyzer = new SpectrumAnalyzer();
  const tone = new Int16Array(512);
  for (let index = 0; index < tone.length; index += 1) {
    // 1 kHz at the 16 kHz capture rate.
    tone[index] = Math.round(Math.sin((2 * Math.PI * index) / 16) * 16_000);
  }
  analyzer.push(tone);
  const peak = Math.max(...analyzer.bands);
  assert.ok(peak > 0);
  analyzer.push(new Int16Array(512));
  assert.ok(Math.max(...analyzer.bands) < peak);
  analyzer.reset();
  assert.ok(analyzer.bands.every((band) => band === 0));
});
