import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Key,
  matchesKey,
  Spacer,
  Text,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE_ADDITIONS = 12;

function selectedWindow<T>(
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

/**
 * Review gate for glossary additions: per-term selection (space toggles),
 * all selected by default. Resolves to the chosen additions, or undefined on
 * cancel. The change is append-only by construction, so this is the whole diff.
 */
class GlossaryReviewView extends Container implements Focusable {
  private readonly list = new Container();
  private readonly footer = new Text("", 1, 0);
  private readonly selected = new Set<number>();
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly keybindings: KeybindingsManager,
    private readonly additions: readonly string[],
    private readonly existingCount: number,
    private readonly done: (chosen: readonly string[] | undefined) => void,
  ) {
    super();
    for (let index = 0; index < additions.length; index += 1) this.selected.add(index);
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Review glossary additions")), 1, 0));
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          `${existingCount} curated term${existingCount === 1 ? "" : "s"} unchanged — ${additions.length} new term${additions.length === 1 ? "" : "s"} found`,
        ),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.refresh();
  }

  private refresh(): void {
    this.selectedIndex = Math.min(this.selectedIndex, this.additions.length - 1);
    this.list.clear();
    const [start, end] = selectedWindow(this.additions, this.selectedIndex, MAX_VISIBLE_ADDITIONS);
    for (let index = start; index < end; index += 1) {
      const term = this.additions[index]!;
      const active = index === this.selectedIndex;
      const checked = this.selected.has(index);
      const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
      const mark = checked ? this.theme.fg("success", "✓") : this.theme.fg("dim", "□");
      const label = active ? this.theme.fg("accent", term) : term;
      this.list.addChild(new Text(`${prefix}${mark} ${label}`, 0, 0));
    }
    this.footer.setText(
      `${this.theme.fg("dim", `${this.selected.size} of ${this.additions.length} selected`)}\n${rawKeyHint("↑↓", "navigate")}  ${rawKeyHint("space", "toggle")}  ${keyHint("tui.select.confirm", "apply")}  ${keyHint("tui.select.cancel", "cancel")}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.additions.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.additions.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.additions.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.additions.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.space)) {
      const index = this.selectedIndex;
      if (index < this.additions.length) {
        if (this.selected.has(index)) this.selected.delete(index);
        else this.selected.add(index);
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.additions.filter((_, index) => this.selected.has(index)));
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
  }
}

/** Review gate: resolves to the chosen additions, or undefined if cancelled. */
export async function reviewGlossaryAdditions(
  ctx: ExtensionContext,
  existingCount: number,
  additions: readonly string[],
): Promise<readonly string[] | undefined> {
  if (additions.length === 0) return [];
  return ctx.ui.custom<readonly string[] | undefined>((tui, theme, keybindings, done) =>
    new GlossaryReviewView(tui, theme, keybindings, additions, existingCount, done),
  );
}
