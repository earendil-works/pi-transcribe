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
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CATALOG_MODELS,
  catalogModelSearchText,
  canonicalLanguage,
  languageIdentity,
  displayLanguage,
  formatBinarySize,
  modelMatchesLanguage,
  rankCatalogModels,
  type CatalogModel,
} from "./catalog.js";
import { getPreferredRecommendationLanguages } from "./recommendations.js";
import { ModelSelectionController } from "./model-selection-controller.js";
import type { CatalogModelActivation } from "./model-activation.js";
export type { CatalogModelActivation } from "./model-activation.js";
import {
  findIncompleteDownload,
  type CachedCatalogModel,
} from "./models.js";
import type { TranscriptionLanguage } from "./settings.js";
import {
  DownloadPanel,
  LIST_PADDING,
  MIN_VISIBLE_ROWS,
  PANEL_PADDING,
  padToWidth,
  panelBorder,
  paneRowBudget,
  selectedWindow,
  SingleSelectPicker,
  windowSizeForBudget,
  type SingleSelectChoice,
} from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];

const MAX_VISIBLE_LANGUAGES = 9;
const PREFERRED_RECOMMENDATION_LANGUAGES =
  getPreferredRecommendationLanguages(CATALOG_MODELS);
const MAX_VISIBLE_MODELS = 10;

function formatEta(seconds: number): string {
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `~${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `~${hours} h ${minutes % 60} min left`;
}
const TEXT_PADDING = PANEL_PADDING;
// Longest catalog language name is "Norwegian Nynorsk" (17).
const LANGUAGE_NAME_WIDTH = 20;
// Below this the name column stops shrinking and rows are left to wrap.
const MIN_MODEL_NAME_WIDTH = 12;
const TRANSCRIPTION_LANGUAGE_NAME_WIDTH = 28;

function transcriptionLanguageName(
  language: string,
  supportedLanguages: readonly string[],
): string {
  const base = canonicalLanguage(language);
  const variants = supportedLanguages.filter(
    (supported) => canonicalLanguage(supported) === base,
  );
  return displayLanguage(variants.length > 1 ? language : base);
}

export type LanguageSelection = {
  languages: string[];
  /** False when the picker was closed with Esc instead of Continue. */
  confirmed: boolean;
};

export class LanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly selected: Set<string>;
  private readonly available: readonly string[];
  private ordered: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = 0;
  /** Scroll-window rows (rule included); shrinks to fit short terminals. */
  private windowRows = MAX_VISIBLE_LANGUAGES + 1;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    initial: readonly string[],
    private readonly cancelLabel: string,
    private readonly done: (result: LanguageSelection | undefined) => void,
    private readonly onboarding = false,
  ) {
    super();
    // Benchmark filtering controls new choices, not existing preferences.
    // Keep saved languages visible and removable even if their support worsens.
    this.selected = new Set(initial.map(languageIdentity).filter(Boolean));
    this.available = [...new Set([...PREFERRED_RECOMMENDATION_LANGUAGES, ...this.selected])];
    this.reorder();

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg(
          "accent",
          theme.bold(onboarding ? "Set up pi-transcribe · 1 of 3" : "Select the languages you speak"),
        ),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(
      new Text(
        onboarding
          ? "Which languages will you speak to Pi in?"
          : theme.fg("muted", "Used to recommend models"),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          "Don't see yours? No available model benchmarks well enough to recommend yet.",
        ),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    // The search caret sits in the gutter, aligned with the list cursor; its
    // "> " prompt then puts the typed query on the content edge.
    const searchBox = new Box(LIST_PADDING, 0);
    searchBox.addChild(this.search);
    this.addChild(searchBox);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private selectedLanguages(): string[] {
    return this.available.filter((language) =>
      this.selected.has(language),
    );
  }

  // Selected languages are pinned to the top of the list so the current
  // selection is always visible without scrolling.
  private reorder(): void {
    const available = this.available;
    this.ordered = [
      ...available.filter((language) => this.selected.has(language)),
      ...available.filter((language) => !this.selected.has(language)),
    ];
  }

  private continueRowIndex(): number {
    return this.filtered.length;
  }

  private refresh(focusLanguage?: string): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.ordered, query, (language) => `${displayLanguage(language)} ${language}`)
      : this.ordered;
    if (focusLanguage) {
      const index = this.filtered.indexOf(focusLanguage);
      if (index >= 0) this.selectedIndex = index;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.continueRowIndex());
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), LIST_PADDING, 0));
    } else {
      // In the unfiltered list, a rule separates the pinned (selected) group
      // from the rest. It is a real row in the scroll window (null entry), so
      // it scrolls like any other line instead of appearing and disappearing,
      // which would shift the layout below the list.
      const boundary =
        !query && this.selected.size > 0 && this.selected.size < this.filtered.length
          ? this.selected.size
          : -1;
      const rows: (string | null)[] =
        boundary >= 0
          ? [...this.filtered.slice(0, boundary), null, ...this.filtered.slice(boundary)]
          : [...this.filtered];
      const cursorRow =
        boundary >= 0 && this.selectedIndex >= boundary
          ? this.selectedIndex + 1
          : this.selectedIndex;
      // Sized +1 so the window holds the same line count with or without the
      // rule row.
      const [start, end] = selectedWindow(rows, cursorRow, this.windowRows);
      for (let index = start; index < end; index += 1) {
        const language = rows[index]!;
        if (language === null) {
          this.list.addChild(
            new Text(`  ${this.theme.fg("dim", "─".repeat(LANGUAGE_NAME_WIDTH + 6))}`, LIST_PADDING, 0),
          );
          continue;
        }
        const active = index === cursorRow;
        const checked = this.selected.has(language);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const mark = checked ? this.theme.fg("success", "[×]") : this.theme.fg("dim", "[ ]");
        const name = padToWidth(displayLanguage(language), LANGUAGE_NAME_WIDTH);
        this.list.addChild(
          new Text(
            `${prefix}${mark} ${active ? this.theme.fg("accent", name) : name}${this.theme.fg("dim", language)}`,
            LIST_PADDING,
            0,
          ),
        );
      }
    }

    const selected = this.selectedLanguages();
    const onContinue = this.selectedIndex === this.continueRowIndex();
    const continuePrefix = onContinue ? this.theme.fg("accent", "→ ") : "  ";
    const continueAction = ` ${keyText("tui.input.tab")}  Continue `;
    const continueRow = selected.length === 0
      ? this.theme.fg("warning", "Select at least one language to continue")
      : this.theme.inverse(
          onContinue
            ? this.theme.fg("accent", this.theme.bold(continueAction))
            : this.theme.fg("success", continueAction),
        );
    this.list.addChild(new Spacer(1));
    this.list.addChild(new Text(`${continuePrefix}${continueRow}`, LIST_PADDING, 0));

    this.footer.setText(
      `${rawKeyHint("↑↓", "move")}  ${rawKeyHint("space/enter", "select")}  ${keyHint("tui.select.cancel", query ? "clear search" : this.cancelLabel)}`,
    );
    this.tui.requestRender();
  }

  private toggleHighlighted(): void {
    const language = this.filtered[this.selectedIndex];
    if (!language) return;
    const adding = !this.selected.has(language);
    if (adding) this.selected.add(language);
    else this.selected.delete(language);
    this.reorder();
    // A search query is spent once used: clear it so the full list returns.
    this.search.setValue("");
    // Follow a newly selected language so the user sees it land in the pinned
    // group; on deselect stay put — trailing the language to its new spot far
    // down the list is disorienting.
    this.refresh(adding ? language : undefined);
  }

  // The pane replaces the host editor and cannot scroll: when the terminal is
  // short, shrink the window so the title, Continue row, and footer stay on
  // screen.
  override render(width: number): string[] {
    const budget = paneRowBudget(this.tui);
    if (budget !== undefined) {
      const chrome = super.render(width).length - this.list.render(width).length;
      // The spacer and Continue row live inside the list; the scroll window
      // gets the rest, still +1 sized for the rule row.
      const rows = windowSizeForBudget(
        budget - chrome - 2,
        MAX_VISIBLE_LANGUAGES + 1,
        MIN_VISIBLE_ROWS + 1,
      );
      if (rows !== this.windowRows) {
        this.windowRows = rows;
        this.refresh();
      }
    }
    return super.render(width);
  }

  handleInput(data: string): void {
    const lastIndex = this.continueRowIndex();
    if (this.keybindings.matches(data, "tui.input.tab")) {
      const selected = this.selectedLanguages();
      if (selected.length > 0) this.done({ languages: selected, confirmed: true });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? lastIndex : this.selectedIndex - 1;
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === lastIndex ? 0 : this.selectedIndex + 1;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleHighlighted();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.selectedIndex === this.continueRowIndex()) {
        const selected = this.selectedLanguages();
        if (selected.length > 0) this.done({ languages: selected, confirmed: true });
        return;
      }
      // Enter on a language toggles it, so landing Enter never silently
      // confirms a selection the user was not pointing at.
      this.toggleHighlighted();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        // Esc keeps the current selection; only an empty selection reads as
        // "never mind".
        const selected = this.selectedLanguages();
        this.done(
          selected.length > 0 ? { languages: selected, confirmed: false } : undefined,
        );
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

export type CatalogModelPickerResult =
  | { type: "change-languages" }
  | { type: "complete" };

export type CatalogModelPostActivation = "stay" | "advance";

export type CatalogModelPickerOptions = {
  /** What the host does after activation and its settings commit succeed. */
  postActivation?: CatalogModelPostActivation;
  /** The host is reopening this picker after an activation in the same flow. */
  activatedInFlow?: boolean;
};

export class CatalogModelPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly searchBox = new Box(LIST_PADDING, 0);
  private readonly body = new Container();
  private readonly preferredLine = new Text("", TEXT_PADDING, 0);
  private readonly list = new Container();
  private readonly detail = new Text("", TEXT_PADDING, 0);
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly selection: ModelSelectionController<CatalogModelPickerResult | undefined>;
  private get cachedById(): Map<string, CachedCatalogModel> { return this.selection.cachedById; }
  private get mode(): "models" | "downloading" { return this.selection.download ? "downloading" : "models"; }
  private get feedback() { return this.selection.feedback; }
  private get selectedDuringSession(): boolean { return this.selection.selectedDuringSession; }
  private readonly models: CatalogModel[];
  private readonly languageColumns: readonly string[];
  /** Widest model name / formatted size in the catalog; column ceilings. */
  private readonly modelNameWidth: number;
  private readonly modelSizeWidth: number;
  /** Width of the last render; row columns are laid out against it. */
  private renderWidth = 80;
  /** Rows the model window may use; shrinks to fit short terminals. */
  private visibleModels = MAX_VISIBLE_MODELS;
  private filtered: CatalogModel[] = [];
  private selectedIndex = 0;
  private downloadPanel: DownloadPanel | undefined;
  private disposed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && this.mode === "models";
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly preferredLanguages: readonly string[],
    currentModelId: string | undefined,
    private readonly done: (result: CatalogModelPickerResult | undefined) => void,
    private readonly onActivate: CatalogModelActivation,
    options: CatalogModelPickerOptions = {},
  ) {
    super();
    this.selection = new ModelSelectionController<CatalogModelPickerResult | undefined>((...args) => this.onActivate(...args), {
      models: CATALOG_MODELS,
      currentModelId,
      activatedInFlow: options.activatedInFlow,
      advance: options.postActivation === "advance",
      completion: { type: "complete" },
      onChange: () => this.refresh(),
      onExit: (result) => { this.stopSpinner(); this.done(result); },
    });
    this.models = rankCatalogModels(
      CATALOG_MODELS,
      preferredLanguages,
      (model) => this.cachedById.has(model.id),
    );
    this.languageColumns = [...new Set(preferredLanguages.map(languageIdentity))];
    const currentIndex = this.models.findIndex((model) => model.id === currentModelId);
    if (currentIndex > 0) {
      const [current] = this.models.splice(currentIndex, 1);
      if (current) this.models.unshift(current);
    }

    this.modelNameWidth = Math.max(
      ...this.models.map((model) => visibleWidth(model.name)),
    );
    this.modelSizeWidth = Math.max(
      ...this.models.map((model) => visibleWidth(formatBinarySize(model.size))),
    );

    this.searchBox.addChild(this.search);
    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Choose a transcription model")), TEXT_PADDING, 0));
    this.addChild(this.preferredLine);
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));

    this.refresh();
  }

  // One column per preferred language, in preference order: green when the
  // model supports it, dim when it does not.
  private languageMatrix(model: CatalogModel): string {
    return this.languageColumns
      .map((language) =>
        modelMatchesLanguage(model, language)
          ? this.theme.fg("success", language)
          : this.theme.fg("dim", language),
      )
      .join(" ");
  }

  // The ● follows the in-flight selection the moment Enter lands; if that
  // activation fails it falls back to the committed model on its own.
  private displayedModelId(): string | undefined {
    return this.selection.displayedModelId;
  }

  // Column widths depend on the terminal: relay out when the width changes so
  // rows truncate their name column instead of wrapping onto a second line.
  // Short terminals also shrink the list window so the title, Languages line,
  // detail, and footer stay on screen; the downloading panel is short enough
  // to be exempt.
  override render(width: number): string[] {
    if (width !== this.renderWidth) {
      this.renderWidth = width;
      this.refresh();
    }
    const budget = this.mode === "models" ? paneRowBudget(this.tui) : undefined;
    if (budget !== undefined) {
      const total = super.render(width).length;
      const detailLines = this.detail.render(width).length;
      const chrome =
        total - this.list.render(width).length - detailLines + this.detailReserve(width);
      const visible = windowSizeForBudget(budget - chrome, MAX_VISIBLE_MODELS);
      if (visible !== this.visibleModels) {
        this.visibleModels = visible;
        this.refresh();
      }
    }
    return super.render(width);
  }

  // The description is truncated to one line, so only transient feedback can
  // change the detail height; reserving for it keeps the window steady.
  private detailReserve(width: number): number {
    const feedbackLines = this.feedback
      ? new Text(this.feedback.text, TEXT_PADDING, 0).render(width).length
      : 0;
    // One description line plus the features line.
    return 2 + feedbackLines;
  }

  private refresh(): void {
    if (this.disposed) return;
    this.body.clear();
    if (!this.selection.download) this.stopSpinner();
    const preferredAction = this.selectedDuringSession
      ? ""
      : ` · ${keyHint("tui.input.tab", "change")}`;
    const languagesText = truncateToWidth(
      `Languages: ${this.preferredLanguages.map(displayLanguage).join(", ")}`,
      Math.max(24, this.renderWidth - TEXT_PADDING * 2 - visibleWidth(preferredAction)),
      "…",
    );
    this.preferredLine.setText(`${this.theme.fg("muted", languagesText)}${preferredAction}`);
    this.search.focused = this._focused && this.mode === "models";

    if (this.selection.download) {
      this.downloadPanel ??= new DownloadPanel(this.tui, this.theme, this.selection.download);
      this.downloadPanel.update(this.selection.download, this.downloadStats());
      this.body.addChild(this.downloadPanel);
      this.tui.requestRender();
      return;
    }

    this.body.addChild(new Spacer(1));
    this.body.addChild(this.searchBox);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.list);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.detail);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.footer);

    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.models, query, catalogModelSearchText)
      : this.models;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.list.clear();
    const displayedId = this.displayedModelId();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("dim", "  No matching models"), LIST_PADDING, 0));
      this.detail.setText("");
    } else {
      const [start, end] = selectedWindow(this.filtered, this.selectedIndex, this.visibleModels);
      const languagesWidth = visibleWidth(this.languageColumns.join(" "));
      // Everything in a row except the name: Text padding, "→ ● " gutter,
      // column gaps, the "✓ " cell, the size column, and the ★ column.
      const overhead =
        LIST_PADDING * 2 + 4 + 2 + languagesWidth + 2 + 2 + this.modelSizeWidth + 2 + 1;
      const nameWidth = Math.min(
        this.modelNameWidth,
        Math.max(MIN_MODEL_NAME_WIDTH, this.renderWidth - overhead),
      );
      for (let index = start; index < end; index += 1) {
        const model = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const cached = this.cachedById.get(model.id);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const current = model.id === displayedId
          ? this.theme.fg("accent", "●")
          : " ";
        const nameText = padToWidth(model.name, nameWidth);
        const name = active ? this.theme.fg("accent", nameText) : nameText;
        // The ✓ has its own column ahead of the right-aligned size, so neither
        // the mark nor the number shifts with the size's digit count.
        const check = cached ? `${this.theme.fg("success", "✓")} ` : "  ";
        const sizeText = formatBinarySize(model.size).padStart(this.modelSizeWidth);
        const recommended = model.recommended
          ? this.theme.fg("accent", "★")
          : " ";
        this.list.addChild(
          new Text(
            `${prefix}${current} ${name}  ${this.languageMatrix(model)}  ${check}${this.theme.fg("dim", sizeText)}  ${recommended}`,
            LIST_PADDING,
            0,
          ),
        );
      }
      const selected = this.filtered[this.selectedIndex]!;
      const canonicalLanguages = [...new Set(selected.languages.map(canonicalLanguage))];
      const features = [
        canonicalLanguages.length === 1
          ? `${displayLanguage(canonicalLanguages[0]!)} only`
          : `${canonicalLanguages.length} languages`,
        selected.capabilities.languageDetection ? "auto language detection" : undefined,
      ].filter((value): value is string => Boolean(value));
      const feedback = this.feedback
        ? `\n${this.theme.fg(this.feedback.type, this.feedback.text)}`
        : "";
      // One line: the features line below already carries the capabilities a
      // long description would wrap for.
      const description = truncateToWidth(
        selected.description,
        Math.max(24, this.renderWidth - TEXT_PADDING * 2),
        "…",
      );
      this.detail.setText(
        `${description}\n${this.theme.fg("dim", features.join(" · "))}${feedback}`,
      );
    }

    // The scroll position lives in this count, so the list never spends a
    // row on an indicator.
    const shown = query
      ? this.filtered.length === 0
        ? `0/${this.models.length} matching models`
        : `${this.selectedIndex + 1}/${this.filtered.length} matching models`
      : `${this.selectedIndex + 1}/${this.models.length} models`;
    const statusLegend = [
      displayedId
        ? `${this.theme.fg("accent", "●")} ${this.theme.fg("dim", "current")}`
        : undefined,
      `${this.theme.fg("success", "✓")} ${this.theme.fg("dim", "downloaded")}`,
      `${this.theme.fg("accent", "★")} ${this.theme.fg("dim", "recommended")}`,
    ]
      .filter((value): value is string => Boolean(value))
      .join("  ");
    const closeLabel = query ? "clear search" : this.selectedDuringSession ? "back" : "cancel";
    // The confirm key says what it will do for the highlighted model.
    const highlighted = this.filtered[this.selectedIndex];
    const confirmLabel = highlighted && !this.cachedById.has(highlighted.id)
      ? findIncompleteDownload(highlighted)
        ? "resume download"
        : `download ${formatBinarySize(highlighted.size)}`
      : "choose";
    this.footer.setText(
      `${this.theme.fg("dim", shown)}  ${statusLegend}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", confirmLabel)}  ${keyHint("tui.select.cancel", closeLabel)}`,
    );
    this.tui.requestRender();
  }

  private downloadStats(): string {
    const { downloaded, total } = this.selection.download!;
    if (total === 0) return "Preparing download…";
    const parts = [`${formatBinarySize(downloaded)} / ${formatBinarySize(total)}`];
    const speed = this.selection.downloadSpeed;
    if (speed !== undefined && speed > 0) {
      parts.push(`${formatBinarySize(speed)}/s`);
      const remaining = (total - downloaded) / speed;
      if (remaining > 1) parts.push(formatEta(remaining));
    }
    return parts.join(" · ");
  }

  private stopSpinner(): void {
    this.downloadPanel?.dispose();
    this.downloadPanel = undefined;
  }

  handleInput(data: string): void {
    // An exit is waiting on the final save; the picker is already closing.
    if (!this.selection.acceptsInput) return;
    if (this.mode === "downloading") {
      // Downloading is the one modal state: the progress panel is visible, so
      // ignoring everything except cancel cannot read as a dead keyboard.
      // Stopping is cheap: the partial file stays in the cache, and selecting
      // the model again resumes from where it left off.
      if (this.keybindings.matches(data, "tui.select.cancel")) this.selection.cancelDownload();
      return;
    }

    if (this.keybindings.matches(data, "tui.input.tab")) {
      if (!this.selectedDuringSession) this.selection.requestExit({ type: "change-languages" });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (!selected) return;
      // Enter on a model that is not cached starts its download immediately;
      // the detail pane already spells out the size, license, and source.
      this.selection.select(selected);
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
    this.stopSpinner();
    this.selection.dispose();
  }
}

export function defaultSpokenLanguages(): string[] {
  const locale = languageIdentity(Intl.DateTimeFormat().resolvedOptions().locale);
  return PREFERRED_RECOMMENDATION_LANGUAGES.includes(locale) ? [locale] : ["en"];
}

export async function chooseLanguages(
  ctx: ExtensionContext,
  initial: readonly string[] = defaultSpokenLanguages(),
  options: { cancelLabel?: string; onboarding?: boolean } = {},
): Promise<LanguageSelection | undefined> {
  return ctx.ui.custom<LanguageSelection | undefined>((tui, theme, keybindings, done) =>
    new LanguagePicker(
      tui,
      theme,
      keybindings,
      initial,
      options.cancelLabel ?? "close",
      done,
      options.onboarding ?? false,
    ),
  );
}

export async function chooseCatalogModel(
  ctx: ExtensionContext,
  preferredLanguages: readonly string[],
  currentModelId: string | undefined,
  options: {
    onActivate: CatalogModelActivation;
    postActivation?: CatalogModelPostActivation;
    /** A model was already activated earlier in this flow. */
    activatedInFlow?: boolean;
  },
): Promise<CatalogModelPickerResult | undefined> {
  return ctx.ui.custom<CatalogModelPickerResult | undefined>(
    (tui, theme, keybindings, done) =>
      new CatalogModelPicker(
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

export function transcriptionLanguageSummary(
  language: TranscriptionLanguage,
  model: CatalogModel,
): string {
  return language === "auto"
    ? "Auto detect"
    : transcriptionLanguageName(language, model.languages);
}

/** Single-choice picker over a model's transcription languages. */
export function createTranscriptionLanguagePicker(
  tui: TUI,
  theme: UiTheme,
  keybindings: KeybindingsManager,
  model: CatalogModel,
  current: TranscriptionLanguage,
  preferredLanguages: readonly string[],
  done: (language: TranscriptionLanguage | undefined) => void,
): SingleSelectPicker<TranscriptionLanguage> {
  const preferred = new Set(preferredLanguages.map(languageIdentity));
  const isPreferred = (value: TranscriptionLanguage): boolean =>
    value !== "auto" && preferred.has(languageIdentity(value));
  const languages: SingleSelectChoice<TranscriptionLanguage>[] = [
    ...new Set(model.languages),
  ]
    .map((language) => ({
      value: language,
      label: transcriptionLanguageName(language, model.languages),
    }))
    .sort(
      (left, right) =>
        Number(isPreferred(right.value)) - Number(isPreferred(left.value)) ||
        left.label.localeCompare(right.label) ||
        left.value.localeCompare(right.value),
    );
  const choices: SingleSelectChoice<TranscriptionLanguage>[] = [
    ...(model.capabilities.languageDetection
      ? [{ value: "auto", label: "Auto detect" }]
      : []),
    ...languages,
  ];
  return new SingleSelectPicker(
    tui,
    theme,
    keybindings,
    choices,
    current,
    {
      title: "Choose transcription language",
      subtitle: model.capabilities.languageDetection
        ? "Language expected in recordings, or automatic detection."
        : "Language expected in recordings.",
      searchable: true,
      maximumVisible: MAX_VISIBLE_LANGUAGES,
      cancelLabel: "back",
      renderLabel: (choice, active) => {
        const nameText = padToWidth(choice.label, TRANSCRIPTION_LANGUAGE_NAME_WIDTH);
        const name = active ? theme.fg("accent", nameText) : nameText;
        const code = choice.value === "auto" ? "" : theme.fg("dim", choice.value);
        return `${name}  ${code}`;
      },
    },
    done,
  );
}
