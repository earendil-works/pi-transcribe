import { Key, matchesKey, Text, truncateToWidth, type KeybindingsManager } from "@earendil-works/pi-tui";

/** A bounded read-only view. Clipping never changes the underlying transcript. */
export class TranscriptPreview {
  private content = "";
  private text = new Text("", 1, 0);
  private offset = 0;
  private lineCount = 1;
  private pageSize = 1;

  setText(content: string): void {
    if (this.content === content) return;
    this.content = content;
    this.text.setText(content);
    this.offset = 0;
  }

  invalidate(): void { this.text.invalidate(); }

  render(width: number, height: number, muted: (text: string) => string): string[] {
    const rows = Math.max(1, height);
    const lines = this.content ? this.text.render(width) : [" ".repeat(width)];
    this.lineCount = lines.length;
    const clipped = lines.length > rows;
    this.pageSize = Math.max(1, rows - (clipped && rows > 1 ? 1 : 0));
    this.offset = Math.max(0, Math.min(this.offset, lines.length - this.pageSize));
    const visible = lines.slice(this.offset, this.offset + this.pageSize);
    if (clipped && rows > 1) {
      visible.push(truncateToWidth(
        muted(` ${this.offset + 1}–${this.offset + visible.length} / ${lines.length} lines · ↑↓ / PgUp PgDn scroll`), width,
      ));
    }
    return visible;
  }

  handleInput(data: string, keys: KeybindingsManager): boolean {
    if (this.lineCount <= this.pageSize) return false;
    let offset = this.offset;
    if (keys.matches(data, "tui.select.up")) offset--;
    else if (keys.matches(data, "tui.select.down")) offset++;
    else if (matchesKey(data, Key.pageUp)) offset -= this.pageSize;
    else if (matchesKey(data, Key.pageDown)) offset += this.pageSize;
    else if (matchesKey(data, Key.home)) offset = 0;
    else if (matchesKey(data, Key.end)) offset = this.lineCount - this.pageSize;
    else return false;
    this.offset = Math.max(0, Math.min(offset, this.lineCount - this.pageSize));
    return true;
  }
}
