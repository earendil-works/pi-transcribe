import type { CatalogModel } from "./catalog.js";
import { downloadCatalogModel, findCachedCatalogModel, type CachedCatalogModel } from "./models.js";
import { writeSettings, type TranscribeSettings } from "./settings.js";

export type CatalogModelActivation = (
  model: CatalogModel,
  options: {
    cached: CachedCatalogModel | undefined;
    signal: AbortSignal;
    onProgress: (progress: { downloaded: number; total: number }) => void;
  },
) => Promise<{ path: string }>;

/**
 * The download-then-save pipeline behind the model picker, shared by
 * onboarding and the settings menu. Back-to-back selections can outrun their
 * settings writes; commits run in selection order, so the file always ends on
 * the user's last choice.
 */
export function createModelActivation(options: {
  buildSettings: (model: CatalogModel, path: string) => TranscribeSettings;
  onCommitted: (settings: TranscribeSettings) => void;
}): {
  activate: CatalogModelActivation;
  /** Resolves once every commit enqueued so far has landed (or failed). */
  waitForCommits: () => Promise<void>;
} {
  let commitQueue: Promise<void> = Promise.resolve();

  const activate: CatalogModelActivation = async (
    model,
    { cached, signal, onProgress },
  ) => {
    let path: string;
    if (cached) {
      // The picker listed the cache when it opened; re-check so settings
      // never point at a file that has since been evicted. Integrity is
      // covered by the download-time hash and the size check here.
      const stillCached = findCachedCatalogModel(model);
      if (!stillCached) {
        throw new Error(
          "the downloaded file is missing; select the model again to re-download it",
        );
      }
      path = stillCached.path;
    } else {
      path = await downloadCatalogModel(model, { signal, onProgress });
    }

    const commit = commitQueue.then(async () => {
      // Skip the write when this selection was superseded or its download
      // was cancelled while the commit sat in the queue.
      signal.throwIfAborted();
      let settings: TranscribeSettings;
      try {
        settings = options.buildSettings(model, path);
        await writeSettings(settings);
      } catch (error) {
        throw new Error(
          `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      options.onCommitted(settings);
    });
    commitQueue = commit.then(
      () => undefined,
      () => undefined,
    );
    await commit;
    return { path };
  };

  return { activate, waitForCommits: () => commitQueue };
}
