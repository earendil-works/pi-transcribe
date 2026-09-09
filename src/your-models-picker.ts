import {
  keyHint,
  keyText,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Focusable,
  Input,
  matchesKey,
  Spacer,
  Text,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CATALOG_MODELS,
  displayLanguage,
  languageIdentity,
  type CatalogModel,
} from "./catalog.js";
import type { CatalogModelActivation } from "./model-activation.js";
import {
  MANUAL_LANGUAGE_TAG,
  matchesCatalogSearch,
  modelDetailText,
  modelTableLayout,
  modelTableRow,
} from "./model-cells.js";
import type { CatalogModelPostActivation } from "./model-picker.js";
import { ModelSelectionController } from "./model-selection-controller.js";
import { isRatingsHelpKey, ModelRatingsHelp } from "./model-ratings-help.js";
import { findCachedCatalogModel } from "./models.js";
import { benchmarkModels } from "./recommendations.js";
import {
  DownloadPanel,
  LIST_PADDING,
  PANEL_PADDING,
  panelBorder,
  paneListWindow,
  selectedWindow,
} from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];

export type YourModelsResult =
  | { type: "complete" }
  | { type: "browse" }
  | { type: "change-languages" };

export type YourModelsPickerOptions = {
  postActivation?: CatalogModelPostActivation;
  activatedInFlow?: boolean;
};

/** The downloaded catalog models, for deciding whether this page is worth showing. */
export function downloadedCatalogModels(): CatalogModel[] {
  return CATALOG_MODELS.filter((model) => findCachedCatalogModel(model) !== undefined);
}

const MAX_VISIBLE_ROWS = 16;
const BROWSE_LABEL = "Browse all models";

type Row = { type: "model"; model: CatalogModel };

/**
 * Switching between the models already on disk. Choosing a model is the
 * catalog's job; this page answers the everyday question — which of mine
 * handles the language I'm about to speak — and takes one keystroke to act
 * on it. A fixed Tab action leads to the catalog without posing as a model.
 */
export class YourModelsPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly searchBox = new Box(LIST_PADDING, 0);
  private readonly body = new Container();
  private readonly header = new Text("", LIST_PADDING, 0);
  private readonly list = new Container();
  private readonly detail = new Text("", PANEL_PADDING, 0);
  private readonly browseAction: Text;
  private readonly footer = new Text("", PANEL_PADDING, 0);
  private readonly ratingsHelp: ModelRatingsHelp;
  private readonly selection: ModelSelectionController<YourModelsResult | undefined>;
  private readonly languageColumns: readonly string[];
  private readonly models: readonly CatalogModel[];
  private readonly manual: ReadonlySet<string>;
  private readonly modelNameWidth: number;
  private renderWidth = 80;
  /** Rows the list window may use; shrinks to fit short terminals. */
  private visibleRows = MAX_VISIBLE_ROWS;
  private selectedIndex = 0;
  private downloadPanel: DownloadPanel | undefined;
  private disposed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && !this.selection.download && !this.ratingsHelp.isOpen;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly preferredLanguages: readonly string[],
    currentModelId: string | undefined,
    private readonly done: (result: YourModelsResult | undefined) => void,
    private readonly onActivate: CatalogModelActivation,
    options: YourModelsPickerOptions = {},
  ) {
    super();
    this.ratingsHelp = new ModelRatingsHelp(tui, theme, keybindings, false);
    this.selection = new ModelSelectionController<YourModelsResult | undefined>(
      (...args) => this.onActivate(...args),
      {
        models: CATALOG_MODELS,
        currentModelId,
        activatedInFlow: options.activatedInFlow,
        advance: options.postActivation === "advance",
        completion: { type: "complete" },
        onChange: () => this.refresh(),
        onExit: (result) => {
          this.ratingsHelp.close();
          this.downloadPanel?.dispose();
          this.done(result);
        },
      },
    );
    this.languageColumns = [...new Set(preferredLanguages.map(languageIdentity))];
    const benchmarks = this.languageColumns.length
      ? benchmarkModels(CATALOG_MODELS, this.languageColumns)
      : new Map();
    // The current model leads so the cursor opens on it; the rest run most
    // accurate first on the chosen languages, and models without a
    // benchmark for them keep the catalog order, after those.
    const downloaded = CATALOG_MODELS.filter((model) =>
      this.selection.cachedById.has(model.id),
    );
    const error = (model: CatalogModel) =>
      benchmarks.get(model.id)?.error ?? Number.POSITIVE_INFINITY;
    const isCurrent = (model: CatalogModel) => model.id === currentModelId;
    this.models = [...downloaded].sort(
      (left, right) =>
        Number(isCurrent(right)) - Number(isCurrent(left)) ||
        error(left) - error(right),
    );
    this.manual = new Set(
      [...benchmarks].filter(([, benchmark]) => benchmark.manual).map(([id]) => id),
    );
    this.modelNameWidth = Math.max(
      12,
      ...this.models.map((model) => visibleWidth(model.name)),
    );
    const currentIndex = this.models.findIndex((model) => model.id === currentModelId);
    this.selectedIndex = Math.max(0, currentIndex);

    this.browseAction = new Text("", PANEL_PADDING, 0);
    this.updateBrowseAction();
    this.searchBox.addChild(this.search);
    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Your models")), PANEL_PADDING, 0));
    this.addChild(
      new Text(
        `${theme.fg("muted", `Languages: ${preferredLanguages.map(displayLanguage).join(", ")}`)} · ${rawKeyHint("shift+tab", "change")}`,
        PANEL_PADDING,
        0,
      ),
    );
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private rows(): Row[] {
    const query = this.search.getValue().trim();
    const models = query
      ? this.models.filter((model) => matchesCatalogSearch(model, query))
      : this.models;
    return models.map((model): Row => ({ type: "model", model }));
  }

  private updateBrowseAction(): void {
    const label = ` ${keyText("tui.input.tab")}  ${BROWSE_LABEL} `;
    this.browseAction.setText(
      this.theme.inverse(this.theme.fg("accent", this.theme.bold(label))),
    );
  }

  override invalidate(): void {
    super.invalidate();
    this.ratingsHelp.invalidate();
    this.updateBrowseAction();
  }

  // Column widths depend on the terminal: relay out when the width changes so
  // rows truncate their name column instead of wrapping onto a second line.
  // Short terminals also shrink the list window so the title, Languages line,
  // detail, and footer stay on screen; the downloading panel is short enough
  // to be exempt.
  override render(width: number): string[] {
    if (this.ratingsHelp.isOpen) return this.ratingsHelp.render(width);
    if (width !== this.renderWidth) {
      this.renderWidth = width;
      this.refresh();
    }
    const visible = this.selection.download
      ? undefined
      : paneListWindow(
          this.tui,
          super.render(width).length,
          this.list.render(width).length,
          this.detail.render(width).length,
          this.detailReserve(width),
          MAX_VISIBLE_ROWS,
        );
    if (visible !== undefined && visible !== this.visibleRows) {
      this.visibleRows = visible;
      this.refresh();
    }
    return super.render(width);
  }

  // The description is truncated to one line, so only transient feedback can
  // change the detail height; reserving for it keeps the window steady.
  private detailReserve(width: number): number {
    const feedbackLines = this.selection.feedback
      ? new Text(this.selection.feedback.text, PANEL_PADDING, 0).render(width).length
      : 0;
    // One description line plus the features line.
    return 2 + feedbackLines;
  }

  private refresh(): void {
    if (this.disposed) return;
    this.body.clear();
    if (this.selection.download) {
      this.downloadPanel ??= new DownloadPanel(this.tui, this.theme, this.selection.download);
      this.downloadPanel.update(this.selection.download, "");
      this.body.addChild(this.downloadPanel);
      this.tui.requestRender();
      return;
    }
    this.downloadPanel?.dispose();
    this.downloadPanel = undefined;
    this.search.focused = this._focused && !this.ratingsHelp.isOpen;

    this.body.addChild(new Spacer(1));
    this.body.addChild(this.searchBox);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.header);
    this.body.addChild(this.list);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.detail);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.browseAction);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.footer);

    const rows = this.rows();
    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    const displayedId = this.selection.displayedModelId;
    const table = modelTableLayout(
      this.theme,
      this.renderWidth,
      this.modelNameWidth,
      this.languageColumns,
    );
    this.header.setText(table.header);
    this.list.clear();
    const [start, end] = selectedWindow(rows, this.selectedIndex, this.visibleRows);
    for (let index = start; index < end; index += 1) {
      const row = rows[index]!;
      const active = index === this.selectedIndex;
      const model = row.model;
      const tag = this.manual.has(model.id)
        ? this.theme.fg("dim", MANUAL_LANGUAGE_TAG)
        : "";
      this.list.addChild(
        new Text(
          modelTableRow(this.theme, model, this.languageColumns, table, {
            active,
            current: model.id === displayedId,
            tag,
          }),
          LIST_PADDING,
          0,
        ),
      );
    }

    const selected = rows[this.selectedIndex];
    const feedback = this.selection.feedback
      ? `\n${this.theme.fg(this.selection.feedback.type, this.selection.feedback.text)}`
      : "";
    if (selected) {
      this.detail.setText(
        modelDetailText(
          this.theme,
          selected.model,
          this.renderWidth,
          PANEL_PADDING,
          this.selection.feedback,
          true,
        ),
      );
    } else {
      this.detail.setText(
        `${this.theme.fg("muted", "No downloaded models match your search.")}${feedback}`,
      );
    }

    const confirmLabel = "choose";
    const closeLabel = this.search.getValue()
      ? "clear search"
      : this.selection.selectedDuringSession
        ? "back"
        : "close";
    this.footer.setText(
      `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", confirmLabel)}  ${keyHint("tui.select.cancel", closeLabel)}  ${rawKeyHint("?", "rating guide")}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (!this.selection.acceptsInput) return;
    if (this.ratingsHelp.isOpen) {
      this.ratingsHelp.handleInput(data);
      this.focused = this._focused;
      return;
    }
    if (this.selection.download) {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.selection.cancelDownload();
      }
      return;
    }
    if (isRatingsHelpKey(data)) {
      this.ratingsHelp.open();
      this.focused = this._focused;
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.selection.requestExit({ type: "change-languages" });
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.selection.requestExit({ type: "browse" });
      return;
    }
    const rows = this.rows();
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (rows.length) {
        this.selectedIndex = (this.selectedIndex + rows.length - 1) % rows.length;
      }
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (rows.length) {
        this.selectedIndex = (this.selectedIndex + 1) % rows.length;
      }
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const row = rows[this.selectedIndex];
      if (row) {
        this.selection.select(row.model);
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        this.selection.requestExit(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.ratingsHelp.close();
    this.downloadPanel?.dispose();
    this.selection.dispose();
  }
}

export async function chooseYourModel(
  ctx: ExtensionContext,
  preferredLanguages: readonly string[],
  currentModelId: string | undefined,
  options: {
    onActivate: CatalogModelActivation;
    postActivation?: CatalogModelPostActivation;
    activatedInFlow?: boolean;
  },
): Promise<YourModelsResult | undefined> {
  return ctx.ui.custom<YourModelsResult | undefined>(
    (tui, theme, keybindings, done) =>
      new YourModelsPicker(
        tui,
        theme,
        keybindings,
        preferredLanguages,
        currentModelId,
        done,
        options.onActivate,
        {
          postActivation: options.postActivation,
          activatedInFlow: options.activatedInFlow,
        },
      ),
  );
}
