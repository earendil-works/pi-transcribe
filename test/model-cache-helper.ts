import { getRepoFolderName } from "@huggingface/hub";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { CatalogModel } from "../src/catalog.js";

/** Small, isolated cache entries; never touch real models or download files. */
export function isolatedModelCache(t: TestContext): (model: CatalogModel) => CatalogModel {
  const previous = process.env.HF_HUB_CACHE;
  const directory = mkdtempSync(join(tmpdir(), "pi-transcribe-cache-test-"));
  process.env.HF_HUB_CACHE = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return (original) => {
    const model = { ...original, size: 1 };
    const snapshot = join(
      directory,
      getRepoFolderName({ name: model.repository, type: "model" }),
      "snapshots",
      model.revision,
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, model.filename), "x");
    return model;
  };
}

/** A sparse cache entry at the catalog size, visible to production cache probes. */
export function cacheCatalogModel(
  cache: (model: CatalogModel) => CatalogModel,
  model: CatalogModel,
): CatalogModel {
  cache(model);
  truncateSync(
    join(
      process.env.HF_HUB_CACHE!,
      getRepoFolderName({ name: model.repository, type: "model" }),
      "snapshots",
      model.revision,
      model.filename,
    ),
    model.size,
  );
  return model;
}
