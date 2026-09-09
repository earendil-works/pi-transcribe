import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Loader,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatBinarySize } from "./catalog.js";
import type { DownloadState } from "./model-selection-controller.js";

type UiTheme = ExtensionContext["ui"]["theme"];

export const PANEL_PADDING = 1;
export const LIST_PADDING = 1;

export function panelBorder(theme: UiTheme): DynamicBorder {
  return new DynamicBorder((text: string) => theme.fg("border", text));
}

/** The rule Pi's editor draws above and below its text. */
export function editorBorder(theme: UiTheme): DynamicBorder {
  return new DynamicBorder((text: string) => theme.fg("borderMuted", text));
}

export type SingleSelectChoice<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export function selectedWindow<T>(
  items: readonly T[],
  selected: number,
  maximum: number,
): [number, number] {
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maximum / 2), items.length - maximum),
  );
  return [start, Math.min(start + maximum, items.length)];
}

/** Rows the host renders below an editor-mounted pane (its two footer lines). */
const RESERVED_HOST_ROWS = 2;
/** Below this a list stops shrinking and the pane is left to overflow. */
export const MIN_VISIBLE_ROWS = 3;

/** Rows available to a pane, or undefined when the terminal size is unknown. */
export function paneRowBudget(tui: TUI): number | undefined {
  const rows = (tui as Partial<TUI>).terminal?.rows;
  return typeof rows === "number" && rows > 0
    ? rows - RESERVED_HOST_ROWS
    : undefined;
}

/** Window size that fits a list into a budget of rows. */
export function windowSizeForBudget(
  budget: number,
  maximum: number,
  minimum = MIN_VISIBLE_ROWS,
): number {
  return Math.max(minimum, Math.min(maximum, budget));
}

/** Compute a list window while reserving the pane's non-list content. */
export function paneListWindow(
  tui: TUI,
  renderedRows: number,
  listRows: number,
  detailRows: number,
  reservedDetailRows: number,
  maximum: number,
): number | undefined {
  const budget = paneRowBudget(tui);
  if (budget === undefined) return undefined;
  const chrome = renderedRows - listRows - detailRows + reservedDetailRows;
  return windowSizeForBudget(budget - chrome, maximum);
}

export function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** Shared download presentation; the picker owns and disposes its spinner. */
export class DownloadPanel {
  private readonly spinner: Loader;
  private state: DownloadState;
  private stats: string | undefined;

  constructor(tui: TUI, private readonly theme: UiTheme, state: DownloadState) {
    this.state = state;
    this.spinner = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), state.message);
  }

  update(state: DownloadState, stats?: string): void {
    this.state = state;
    this.stats = stats;
    this.spinner.setMessage(state.message);
  }

  render(width: number, maxRows = Infinity): string[] {
    const { model, downloaded, total } = this.state;
    const text = (value: string) => new Text(value, PANEL_PADDING, 0).render(width);
    const ratio = total > 0 ? Math.max(0, Math.min(1, downloaded / total)) : 0;
    const barWidth = Math.max(1, Math.min(36, width - PANEL_PADDING * 2 - 5));
    const filled = Math.round(ratio * barWidth);
    const bar = this.theme.fg("accent", "█".repeat(filled)) + this.theme.fg("dim", "─".repeat(barWidth - filled));
    const title = this.theme.fg("accent", this.theme.bold(`Downloading ${model.name}`));
    const progress = `${bar}${total > 0 ? this.theme.fg("dim", ` ${Math.floor(ratio * 100)}%`) : ""}`;
    const stats = this.theme.fg("muted", this.stats ?? (total > 0
      ? `${formatBinarySize(downloaded)} / ${formatBinarySize(total)}` : "Preparing download…"));
    const privacy = this.theme.fg("dim", "Models run locally — audio never leaves this machine.");
    const hint = keyHint("tui.select.cancel", "stop (keeps progress)");
    const activity = this.spinner.render(width);
    const lines = ["", ...text(title), ...activity, ...text(progress), ...text(stats), ...text(privacy), "", ...text(hint)];
    if (lines.length <= maxRows) return lines;
    // Small terminals keep the current operation and cancel key visible.
    const compact = [title, activity[1]?.trim() ?? this.state.message, progress, stats, privacy]
      .slice(0, Math.max(0, maxRows - 1));
    return [...compact, keyHint("tui.select.cancel", "stop")].map((line) => truncateToWidth(` ${line}`, width));
  }

  invalidate(): void { this.spinner.invalidate(); }
  dispose(): void { this.spinner.stop(); }
}

/** Pi-native single-choice picker with optional fuzzy search and current-value marker. */
export class SingleSelectPicker<T extends string> extends Container implements Focusable {
  private readonly search = new Input();
  private readonly titleText: Text;
  private readonly subtitleText: Text | undefined;
  private readonly list = new Container();
  private readonly detail = new Text("", PANEL_PADDING, 0);
  private readonly footer = new Text("", PANEL_PADDING, 0);
  private filtered: SingleSelectChoice<T>[];
  private selectedIndex: number;
  /** Rows the list window may use; shrinks to fit short terminals. */
  private visibleLimit: number;
  /** Width of the last render; row labels are laid out against it. */
  private renderWidth = 80;
  /** Lines of the longest description at the cached width. */
  private detailReserve = 0;
  private detailReserveWidth = -1;
  private readonly hasDescriptions: boolean;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && Boolean(this.options.searchable);
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly choices: readonly SingleSelectChoice<T>[],
    private readonly current: T | undefined,
    private readonly options: {
      title: string;
      subtitle?: string;
      searchable?: boolean;
      maximumVisible?: number;
      cancelLabel?: string;
      /** Extra footer legend, appended after the ● current marker. */
      legend?: string;
      /** Custom row body after the cursor and ● markers; handles its own active styling. */
      renderLabel?: (choice: SingleSelectChoice<T>, active: boolean, width: number) => string;
    },
    private readonly done: (value: T | undefined) => void,
  ) {
    super();
    this.visibleLimit = options.maximumVisible ?? 10;
    this.hasDescriptions = choices.some((choice) => choice.description);
    this.filtered = [...choices];
    this.selectedIndex = Math.max(
      0,
      this.filtered.findIndex((choice) => choice.value === current),
    );

    this.titleText = new Text(
      theme.fg("accent", theme.bold(options.title)),
      PANEL_PADDING,
      0,
    );
    this.subtitleText = options.subtitle
      ? new Text(theme.fg("muted", options.subtitle), PANEL_PADDING, 0)
      : undefined;

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(this.titleText);
    if (this.subtitleText) this.addChild(this.subtitleText);
    this.addChild(new Spacer(1));
    if (options.searchable) {
      const searchBox = new Box(LIST_PADDING, 0);
      searchBox.addChild(this.search);
      this.addChild(searchBox);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    if (this.hasDescriptions) {
      this.addChild(this.detail);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter([...this.choices], query, (choice) =>
          `${choice.label} ${choice.value} ${choice.description ?? ""}`,
        )
      : [...this.choices];
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(
        new Text(this.theme.fg("muted", "  No matching choices"), LIST_PADDING, 0),
      );
      this.detail.setText("");
    } else {
      const maximum = this.visibleLimit;
      const [start, end] = selectedWindow(
        this.filtered,
        this.selectedIndex,
        maximum,
      );
      for (let index = start; index < end; index += 1) {
        const choice = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const current = this.current === undefined
          ? ""
          : choice.value === this.current
            ? this.theme.fg("accent", "● ")
            : "  ";
        const label = this.options.renderLabel
          ? this.options.renderLabel(choice, active, this.renderWidth)
          : active
            ? this.theme.fg("accent", choice.label)
            : choice.label;
        this.list.addChild(new Text(`${prefix}${current}${label}`, LIST_PADDING, 0));
      }
      this.detail.setText(
        this.filtered[this.selectedIndex]?.description
          ? this.theme.fg("dim", this.filtered[this.selectedIndex]!.description!)
          : "",
      );
    }

    // When the list is clipped the scroll position lives in this count, so
    // the list itself never spends a row on an indicator.
    const clipped = this.filtered.length > this.visibleLimit;
    const shown = query
      ? clipped
        ? `${this.selectedIndex + 1}/${this.filtered.length} matching choices`
        : `${this.filtered.length}/${this.choices.length} matching choices`
      : clipped
        ? `${this.selectedIndex + 1}/${this.choices.length} choices`
        : `${this.choices.length} choices`;
    const legend = [
      this.current === undefined
        ? undefined
        : `${this.theme.fg("accent", "●")} ${this.theme.fg("dim", "current")}`,
      this.options.legend,
    ]
      .filter((value): value is string => Boolean(value))
      .join("  ");
    this.footer.setText(
      `${this.theme.fg("dim", shown)}${legend ? `  ${legend}` : ""}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", query ? "clear search" : (this.options.cancelLabel ?? "back"))}`,
    );
    this.tui.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
    this.titleText.setText(
      this.theme.fg("accent", this.theme.bold(this.options.title)),
    );
    if (this.subtitleText && this.options.subtitle) {
      this.subtitleText.setText(this.theme.fg("muted", this.options.subtitle));
    }
    this.refresh();
  }

  // The pane replaces the host editor and cannot scroll: when the terminal
  // is short, shrink the list window so the title and footer stay on screen.
  override render(width: number): string[] {
    if (width !== this.renderWidth) {
      this.renderWidth = width;
      this.refresh();
    }
    const limit = paneListWindow(
      this.tui,
      super.render(width).length,
      this.list.render(width).length,
      this.detail.render(width).length,
      this.maxDetailLines(width),
      this.options.maximumVisible ?? 10,
    );
    if (limit !== undefined && limit !== this.visibleLimit) {
      this.visibleLimit = limit;
      this.refresh();
    }
    return super.render(width);
  }

  // Sizing against the longest description keeps the window height steady
  // while the highlight moves across short and wrapping descriptions.
  private maxDetailLines(width: number): number {
    if (!this.hasDescriptions) return 0;
    if (this.detailReserveWidth !== width) {
      this.detailReserveWidth = width;
      const probe = new Text("", PANEL_PADDING, 0);
      this.detailReserve = Math.max(
        ...this.choices.map((choice) => {
          if (!choice.description) return 1;
          probe.setText(choice.description);
          return probe.render(width).length;
        }),
      );
    }
    return this.detailReserve;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = Math.max(
          0,
          this.choices.findIndex((choice) => choice.value === this.current),
        );
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    if (this.options.searchable) {
      this.search.handleInput(data);
      this.selectedIndex = 0;
      this.refresh();
    }
  }
}
