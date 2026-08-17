import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  cleanupModelsEqual,
  DEFAULT_CLEANUP_MODEL,
  type CleanupModelSetting,
} from "./settings.js";

const MAX_VISIBLE_MODELS = 10;

type CleanupModelChoice = {
  label: string;
  setting: CleanupModelSetting;
  searchText: string;
};

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

/** Searchable, bounded picker for the cleanup LLM model, like the catalog picker. */
class CleanupModelPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", 1, 0);
  private readonly choices: CleanupModelChoice[];
  private filtered: CleanupModelChoice[] = [];
  private selectedIndex = 0;
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
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly keybindings: KeybindingsManager,
    choices: CleanupModelChoice[],
    current: CleanupModelSetting,
    private readonly done: (setting: CleanupModelSetting | undefined) => void,
  ) {
    super();
    this.choices = choices;
    this.filtered = choices;
    this.selectedIndex = Math.max(
      0,
      choices.findIndex((choice) => cleanupModelsEqual(choice.setting, current)),
    );

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Choose cleanup model")), 1, 0));
    this.addChild(new Text(theme.fg("muted", "Type to search."), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.choices, query, (choice) => choice.searchText)
      : this.choices;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
    } else {
      const [start, end] = selectedWindow(this.filtered, this.selectedIndex, MAX_VISIBLE_MODELS);
      for (let index = start; index < end; index += 1) {
        const choice = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const label = active ? this.theme.fg("accent", choice.label) : choice.label;
        this.list.addChild(new Text(`${prefix}${label}`, 0, 0));
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(
            this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`),
            0,
            0,
          ),
        );
      }
    }

    const shown = query
      ? `${this.filtered.length}/${this.choices.length} matching models`
      : `${this.choices.length} models`;
    this.footer.setText(
      `${this.theme.fg("dim", shown)}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "choose")}  ${keyHint("tui.select.cancel", query ? "clear search" : "cancel")}`,
    );
    this.tui.requestRender();
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
      if (selected) this.done(selected.setting);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

export async function chooseCleanupModel(
  ctx: ExtensionContext,
  current: CleanupModelSetting,
): Promise<CleanupModelSetting | undefined> {
  const available = (ctx.modelRegistry?.getAvailable() ?? []).filter(
    (model) => typeof model.provider === "string" && typeof model.id === "string",
  );
  const choices: CleanupModelChoice[] = [
    { label: "Off (raw transcript)", setting: DEFAULT_CLEANUP_MODEL, searchText: "off raw transcript" },
  ];
  const seen = new Set<string>();
  for (const model of available) {
    // Same format as the /model picker: id with provider badge, so models
    // with identical ids on different providers are unambiguous.
    const label = `${model.id} [${model.provider}]`;
    if (seen.has(label)) continue;
    seen.add(label);
    choices.push({
      label,
      setting: { type: "specific", provider: model.provider, id: model.id },
      searchText: `${label} ${model.provider}/${model.id}`,
    });
  }
  // A pinned model that is currently unavailable must still be selectable,
  // otherwise the picker would silently preselect "Off" and disable cleanup.
  if (
    current.type === "specific" &&
    !choices.some(
      (choice) =>
        choice.setting.type === "specific" &&
        choice.setting.provider === current.provider &&
        choice.setting.id === current.id,
    )
  ) {
    choices.splice(1, 0, {
      label: `${current.provider}/${current.id} (unavailable)`,
      setting: current,
      searchText: `${current.provider}/${current.id} unavailable`,
    });
  }

  return ctx.ui.custom<CleanupModelSetting | undefined>(
    (tui, theme, keybindings, done) =>
      new CleanupModelPicker(tui, theme, keybindings, choices, current, done),
  );
}
