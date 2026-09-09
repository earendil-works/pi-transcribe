import { readFileSync } from "node:fs";
import { rawKeyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { gradeStyle } from "./model-cells.js";
import { PANEL_PADDING, panelBorder, paneRowBudget } from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];

/** Match the typed character, including Kitty's explicit shifted key report. */
export function isRatingsHelpKey(data: string): boolean {
  return matchesKey(data, "?") || decodeKittyPrintable(data) === "?";
}

/**
 * An in-place help view owned by the picker. The picker stays mounted and routes
 * rendering/input here while open; no overlay, focus transfer, or navigation.
 * Copy lives in model-ratings-help.md and is read again on each opening.
 */
export class ModelRatingsHelp implements Component {
  private markdown: Markdown | undefined;
  private title = "Model ratings";
  private offset = 0;
  private pageSize = 1;
  private lineCount = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keys: KeybindingsManager,
    private readonly catalog: boolean,
  ) {}

  get isOpen(): boolean { return this.markdown !== undefined; }

  open(): void {
    if (this.isOpen) return;
    const source = readFileSync(new URL("./model-ratings-help.md", import.meta.url), "utf8")
      .replace(/<!-- catalog-only -->([\s\S]*?)<!-- \/catalog-only -->/g,
        (_block, content: string) => this.catalog ? content : "");
    // A document title is optional; plain section headings work without one.
    this.title = source.match(/^# (.+)$/m)?.[1] ?? "Model ratings";
    const theme = this.theme;
    this.markdown = new Markdown(source.replace(/^# .+\r?\n/m, "").trim(), PANEL_PADDING, 0, {
      heading: (text) => theme.fg("accent", theme.bold(text)),
      link: (text) => theme.fg("mdLink", text),
      linkUrl: (text) => theme.fg("mdLinkUrl", text),
      code: (text) => theme.fg("mdCode", text),
      codeBlock: (text) => theme.fg("mdCodeBlock", text),
      codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
      quote: (text) => theme.fg("mdQuote", text),
      quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
      hr: (text) => theme.fg("mdHr", text),
      listBullet: (text) => theme.fg("mdListBullet", text),
      bold: (text) => {
        // Match the grade letters in "A — Very few mistakes" so the help
        // uses the same visual language as the model columns. Keep the
        // explanation itself bold but uncoloured.
        const grade = text.match(/^([ABCDF])(?=\s+—)/)?.[1];
        if (!grade) return theme.bold(text);
        return gradeStyle(theme, grade as "A" | "B" | "C" | "D" | "F", theme.bold(grade)) +
          theme.bold(text.slice(grade.length));
      },
      italic: (text) => theme.italic(text),
      strikethrough: (text) => theme.strikethrough(text),
      underline: (text) => theme.underline(text),
    });
    this.offset = 0;
    this.tui.requestRender();
  }

  close(): void {
    if (!this.isOpen) return;
    this.markdown = undefined;
    this.tui.requestRender();
  }

  invalidate(): void { this.markdown?.invalidate(); }

  render(width: number): string[] {
    if (width < 1 || !this.markdown) return [];
    const budget = Math.max(1, paneRowBudget(this.tui) ?? 24);
    const row = (text: string) => truncateToWidth(`${" ".repeat(PANEL_PADDING)}${text}`, width, "");
    const border = panelBorder(this.theme).render(width);
    // Match the model pages' full-width horizontal rules and left alignment.
    // On tiny terminals, drop decoration before sacrificing text or Back.
    const framed = budget >= 6;
    const spaced = budget >= 10;
    const header = [
      ...(framed ? border : []),
      ...(spaced ? [""] : []),
      ...(budget >= 3 ? [row(this.theme.fg("accent", this.theme.bold(this.title)))] : []),
      ...(spaced ? [""] : []),
    ];
    const footerRows = 1 + (spaced ? 2 : 0) + (framed ? border.length : 0);
    this.pageSize = Math.max(0, budget - header.length - footerRows);
    const lines = this.markdown.render(width);
    this.lineCount = lines.length;
    this.offset = Math.max(0, Math.min(this.offset, lines.length - this.pageSize));
    const page = lines.slice(this.offset, this.offset + this.pageSize);

    const scrollable = lines.length > this.pageSize;
    const scroll = scrollable ? `${rawKeyHint("↑↓", "scroll")}  ` : "";
    const more = [this.offset > 0 ? "↑ above" : "", this.offset + this.pageSize < lines.length ? "↓ more" : ""]
      .filter(Boolean).join(" · ");
    const firstBackKey = this.keys.getKeys("tui.select.cancel")[0] ?? "unbound";
    const back = rawKeyHint(`q/${firstBackKey}`, "back to models");
    const hints = [
      `${scroll}${more ? `${this.theme.fg("dim", more)}  ` : ""}${back}`,
      `${scroll}${back}`,
      back,
      rawKeyHint(`q/${firstBackKey}`, "back"),
      rawKeyHint("q", "back"),
    ];
    const footer = hints.find((hint) => visibleWidth(hint) <= width - PANEL_PADDING * 2) ?? hints[hints.length - 1]!;
    return [
      ...header,
      ...page,
      ...(spaced ? [""] : []),
      row(footer),
      ...(spaced ? [""] : []),
      ...(framed ? border : []),
    ];
  }

  handleInput(data: string): void {
    if (
      this.keys.matches(data, "tui.select.cancel") ||
      matchesKey(data, "q") ||
      decodeKittyPrintable(data) === "q"
    ) {
      this.close();
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) this.offset--;
    else if (this.keys.matches(data, "tui.select.down")) this.offset++;
    // Keep a little context across pages, particularly section headings.
    else if (this.keys.matches(data, "tui.select.pageUp")) this.offset -= Math.max(1, this.pageSize - 2);
    else if (this.keys.matches(data, "tui.select.pageDown")) this.offset += Math.max(1, this.pageSize - 2);
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = this.lineCount - this.pageSize;
    else return; // In particular, Enter and typing never reach the model list.
    this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize));
    this.tui.requestRender();
  }
}
