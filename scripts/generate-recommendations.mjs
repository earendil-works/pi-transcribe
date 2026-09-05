import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const databasePath = resolve(
  process.argv[2] ??
    process.env.MODELS_DB ??
    "../../handy-computer/models.handy.computer/wer.db",
);
const outputPath = resolve(process.argv[3] ?? "catalog/recommendations.json");
const catalog = JSON.parse(await readFile(resolve("catalog/catalog.json"), "utf8"));
const db = new DatabaseSync(databasePath, { readOnly: true });

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const modelNames = new Set(
  all("SELECT model FROM models").map((row) => String(row.model)),
);
const rigs = [
  { id: "accelerated", rig: "ryzen-4750u", backend: "vulkan" },
  { id: "cpu", rig: "ryzen-4750u", backend: "cpu" },
];

const models = {};
for (const catalogModel of catalog.models) {
  if (!modelNames.has(catalogModel.id)) continue;

  const resultQuants = all(
    `SELECT DISTINCT r.quant
       FROM results r JOIN datasets d ON d.dataset = r.dataset
      WHERE r.model = ? AND d.source = 'fleurs'`,
    catalogModel.id,
  ).map((row) => String(row.quant));
  // Rank at Q8_0 like the benchmark site: it is the only quant run on every
  // language, while the lower quants cover a fixed 8-language drift set.
  const accuracyQuant = resultQuants.includes("Q8_0")
    ? "Q8_0"
    : resultQuants.includes(catalogModel.quant)
      ? catalogModel.quant
      : resultQuants[0];
  if (!accuracyQuant) continue;

  const accuracy = {};
  for (const row of all(
    `SELECT d.lang, r.err_pct, r.ci_lo
       FROM results r JOIN datasets d ON d.dataset = r.dataset
      WHERE r.model = ? AND d.source = 'fleurs' AND r.quant = ?
      ORDER BY d.lang`,
    catalogModel.id,
    accuracyQuant,
  )) {
    accuracy[String(row.lang)] = {
      error: Number(row.err_pct),
      ...(row.ci_lo == null ? {} : { ciLower: Number(row.ci_lo) }),
    };
  }

  const performance = {};
  for (const target of rigs) {
    const perfQuants = all(
      `SELECT DISTINCT quant FROM perf
        WHERE model = ? AND rig = ? AND backend = ?`,
      catalogModel.id,
      target.rig,
      target.backend,
    ).map((row) => String(row.quant));
    const perfQuant = perfQuants.includes("Q8_0")
      ? "Q8_0"
      : perfQuants.includes(catalogModel.quant)
        ? catalogModel.quant
        : perfQuants[0];
    if (!perfQuant) continue;
    const row = one(
      `SELECT avg(xrt) AS xrt FROM perf
        WHERE model = ? AND rig = ? AND backend = ? AND quant = ?`,
      catalogModel.id,
      target.rig,
      target.backend,
      perfQuant,
    );
    if (row?.xrt != null) {
      performance[target.id] = Number(Number(row.xrt).toFixed(3));
    }
  }

  models[catalogModel.id] = { accuracy, performance };
}

db.close();
// Keep each accuracy cell and pair of real-time factors on one diff-friendly line.
await writeFile(
  outputPath,
  `${JSON.stringify({
    // See the Methodology comment in src/recommendations.ts for what each
    // constant means; waits are quoted after a 30-second dictation.
    methodology: {
      dictationSeconds: 30,
      freeWaitSeconds: 3,
      waitWeight: 0.5,
      overallMaxWaitSeconds: 5,
      maxLanguageErrorPercent: 20,
      experimentalMaxErrorPercent: 30,
      fastCpuMaxWaitSeconds: 4,
      accurateMaxWaitSeconds: 10,
    },
    models,
  }, null, 2).replace(/\{\n\s+"(?:error|accelerated|cpu)":[^{}]*?\n\s*\}/g, (cell) =>
    JSON.stringify(JSON.parse(cell)).replaceAll(":", ": ").replaceAll(",", ", "),
  )}\n`,
);
console.log(`Wrote ${outputPath} from ${databasePath}`);
