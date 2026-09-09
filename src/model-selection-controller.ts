import type { CatalogModel } from "./catalog.js";
import type { CatalogModelActivation } from "./model-activation.js";
import { findCachedCatalogModel, type CachedCatalogModel } from "./models.js";

export type DownloadState = {
  readonly model: CatalogModel;
  readonly downloaded: number;
  readonly total: number;
  readonly message: string;
};

type Activation = {
  model: CatalogModel;
  controller: AbortController;
  cached: CachedCatalogModel | undefined;
};

/** UI-independent selection lifecycle shared by the recommended and full pickers. */
export class ModelSelectionController<R> {
  readonly cachedById = new Map<string, CachedCatalogModel>();
  committedModelId: string | undefined;
  selectedDuringSession: boolean;
  download: DownloadState | undefined;
  feedback: { type: "success" | "error" | "muted"; text: string } | undefined;
  private target: Activation | undefined;
  private pendingExit: { result: R } | undefined;
  private closed = false;
  private disposed = false;
  private samples: { time: number; bytes: number }[] = [];
  private readonly findCached: typeof findCachedCatalogModel;
  private readonly now: () => number;

  constructor(
    private readonly activate: CatalogModelActivation,
    private readonly options: {
      models: readonly CatalogModel[];
      currentModelId?: string;
      activatedInFlow?: boolean;
      advance: boolean;
      completion: R;
      onChange: () => void;
      onExit: (result: R) => void;
      findCached?: typeof findCachedCatalogModel;
      now?: () => number;
    },
  ) {
    this.findCached = options.findCached ?? findCachedCatalogModel;
    this.now = options.now ?? Date.now;
    this.committedModelId = options.currentModelId;
    this.selectedDuringSession = options.activatedInFlow ?? false;
    for (const model of options.models) {
      const cached = this.findCached(model);
      if (cached) this.cachedById.set(model.id, cached);
    }
  }

  get acceptsInput(): boolean {
    return !this.closed && !this.disposed && !this.pendingExit;
  }

  get displayedModelId(): string | undefined {
    return this.target?.model.id ?? this.committedModelId;
  }

  get downloadSpeed(): number | undefined {
    const samples = this.samples.filter((sample) => this.now() - sample.time <= 5000);
    if (samples.length < 2) return undefined;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const elapsed = last.time - first.time;
    return elapsed >= 500 ? (last.bytes - first.bytes) * 1000 / elapsed : undefined;
  }

  private changed(): void {
    if (this.closed || this.disposed) return;
    // A rendering failure must not prevent the download/save from running.
    try { this.options.onChange(); } catch { /* Presentation is not part of the commit. */ }
  }

  private finish(result: R): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    this.pendingExit = undefined;
    try { this.options.onExit(result); } catch { /* Never reinterpret a committed save as a failure. */ }
  }

  /** Cached saves finish before navigation; download cancellation is explicit. */
  requestExit(result: R): void {
    if (!this.acceptsInput || this.download) return;
    if (this.target) this.pendingExit = { result };
    else this.finish(result);
  }

  select(model: CatalogModel): void {
    if (!this.acceptsInput || this.download) return;
    const cached = this.cachedById.get(model.id);
    if (!this.target && cached && model.id === this.committedModelId &&
        (this.selectedDuringSession || !this.options.advance)) {
      this.selectedDuringSession = true;
      if (this.options.advance) this.finish(this.options.completion);
      else this.changed();
      return;
    }

    this.target?.controller.abort();
    const target: Activation = { model, cached, controller: new AbortController() };
    this.target = target;
    this.feedback = undefined;
    this.samples = [];
    this.download = cached ? undefined : {
      model, downloaded: 0, total: 0, message: "Connecting to Hugging Face…",
    };
    this.changed();

    // Catch synchronous implementations too. The real pipeline reports only
    // after its ordered settings commit, not merely after the download.
    let work: Promise<{ path: string }>;
    try {
      work = this.activate(model, {
        cached,
        signal: target.controller.signal,
        onProgress: ({ downloaded, total }) => {
          if (this.disposed || this.closed || this.target !== target || target.controller.signal.aborted) return;
          if (!this.download) return;
          const firstReport = this.download.total === 0 && total > 0;
          this.download = {
            model, downloaded, total,
            message: firstReport
              ? downloaded > 0 ? "Resuming download from Hugging Face…" : "Downloading from Hugging Face…"
              : this.download.message,
          };
          this.samples.push({ time: this.now(), bytes: downloaded });
          if (this.samples.length > 64) this.samples.shift();
          this.changed();
        },
      });
    } catch (error) {
      work = Promise.reject(error);
    }
    void work.then(
      ({ path }) => {
        // A superseded save may already have committed. Record that fact even
        // after disposal; only presentation and navigation ignore stale work.
        this.cachedById.set(model.id, { path });
        this.committedModelId = model.id;
        this.selectedDuringSession = true;
        if (this.target !== target) { this.changed(); return; }
        this.target = undefined;
        this.download = undefined;
        this.feedback = cached ? undefined : {
          type: "success", text: `✓ Downloaded and selected ${model.name}`,
        };
        if (this.pendingExit) this.finish(this.pendingExit.result);
        else if (this.options.advance) this.finish(this.options.completion);
        else this.changed();
      },
      (error: unknown) => {
        const cached = this.findCached(model);
        if (cached) this.cachedById.set(model.id, cached);
        else this.cachedById.delete(model.id);
        if (this.target !== target) { this.changed(); return; }
        this.target = undefined;
        this.pendingExit = undefined;
        this.download = undefined;
        this.feedback = target.controller.signal.aborted
          ? { type: "muted", text: "Download stopped — progress saved. Select the model again to resume." }
          : { type: "error", text: `Could not select ${model.name}: ${error instanceof Error ? error.message : String(error)}` };
        this.changed();
      },
    );
  }

  cancelDownload(): void {
    if (!this.acceptsInput || !this.download) return;
    this.target?.controller.abort();
    this.download = { ...this.download, message: "Stopping…" };
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    // Selecting a cached model is a save, not a cancellable download.
    if (this.download) this.target?.controller.abort();
  }
}
