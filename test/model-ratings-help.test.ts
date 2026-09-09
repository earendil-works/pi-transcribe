import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  TUI,
  type Component,
  type OverlayOptions,
  type Terminal,
} from "@earendil-works/pi-tui";
import { CatalogModelPicker } from "../src/model-picker.js";
import { isRatingsHelpKey } from "../src/model-ratings-help.js";
import { YourModelsPicker } from "../src/your-models-picker.js";
import { isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, stripAnsi, testTheme } from "./ui-helpers.js";

initTheme("dark");
const ESC = "\u001b";

function harness(t: TestContext) {
  let input: (data: string) => void = () => {};
  const noop = () => {};
  const terminal: Terminal = {
    rows: 24,
    columns: 80,
    kittyProtocolActive: false,
    start: (onInput) => {
      input = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
  };
  class InPlaceTui extends TUI {
    override requestRender(): void {}
    override showOverlay(_component: Component, _options?: OverlayOptions): never {
      assert.fail("ratings help must not open an overlay");
    }
  }
  const tui = new InPlaceTui(terminal);
  tui.start();
  t.after(() => tui.stop());
  return { tui, send: (data: string) => input(data) };
}

test("ratings help replaces each model picker in place and restores its state", (t) => {
  isolatedModelCache(t);
  const { tui, send } = harness(t);
  const exits: unknown[] = [];
  const activate = async () => {
    throw new Error("help must not activate a model");
  };
  const pickers = [
    new CatalogModelPicker(
      tui,
      testTheme(),
      keybindings(),
      ["en"],
      undefined,
      (result) => exits.push(result),
      activate,
    ),
    new YourModelsPicker(
      tui,
      testTheme(),
      keybindings(),
      ["en"],
      undefined,
      (result) => exits.push(result),
      activate,
    ),
  ];
  t.after(() => pickers.forEach((picker) => picker.dispose()));

  for (const picker of pickers) {
    tui.addChild(picker);
    tui.setFocus(picker);
    send("q");
    const before = picker.render(80);

    send("?");
    const help = picker.render(80);
    assert.equal(tui.hasOverlay(), false);
    assert.equal(picker.focused, true);
    assert.match(stripAnsi(help.join("\n")), /Model ratings/);
    assert.equal(help.join("\n").includes(CURSOR_MARKER), false);
    send("\r");
    assert.deepEqual(picker.render(80), help, "other input stays inside help");

    send(ESC);
    assert.deepEqual(picker.render(80), before);
    tui.removeChild(picker);
  }
  assert.deepEqual(exits, []);
});

test("the help shortcut accepts typed and Kitty-protocol question marks only", () => {
  for (const data of ["?", `${ESC}[63u`, `${ESC}[63;2u`, `${ESC}[47:63;2u`]) {
    assert.equal(isRatingsHelpKey(data), true, JSON.stringify(data));
  }
  for (const data of ["/", "qwen?", `${ESC}[200~?${ESC}[201~`, `${ESC}[63;5u`]) {
    assert.equal(isRatingsHelpKey(data), false, JSON.stringify(data));
  }
});
