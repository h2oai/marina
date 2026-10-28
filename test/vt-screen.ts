// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal terminal screen for tests: enough VT100 to replay what the
 * interactive CLIs write (text, CR/LF, cursor moves, save/restore, erase) and
 * read back the page a person would see. Colours and OSC strings are dropped.
 * Rows that scroll off the top are kept, so `text()` is the whole session.
 */

export class VtScreen {
  private lines: string[][];
  private scrolled: string[] = [];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };

  constructor(
    public cols: number,
    readonly rows: number,
  ) {
    this.lines = Array.from({ length: rows }, () => []);
  }

  write(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        i = this.escape(data, i);
        continue;
      }
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") {
        // A tty's output processing (onlcr) sends LF as CR LF.
        this.col = 0;
        this.lineFeed();
      } else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch === "\t") this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch >= " " && ch !== "\x7f") this.put(ch);
    }
  }

  /** The visible page, right-trimmed rows. */
  screen(): string[] {
    return this.lines.map((l) => l.join("").trimEnd());
  }

  /** Everything written: scrolled-off rows, then the page. */
  text(): string {
    return [...this.scrolled, ...this.screen()].join("\n");
  }

  /**
   * Narrow the window as a reflowing terminal does: a row wider than the new
   * width rewraps onto more rows, the cursor stays with its text, and rows
   * above it scroll off the top.
   */
  narrow(cols: number): void {
    const rows: string[][] = [];
    let cursor = 0;
    this.lines.forEach((line, r) => {
      if (r === this.row) cursor = rows.length + Math.floor(Math.min(this.col, line.length) / cols);
      const parts = Math.max(1, Math.ceil(line.length / cols));
      for (let i = 0; i < parts; i++) rows.push(line.slice(i * cols, (i + 1) * cols));
    });
    this.col = Math.min(this.col % cols, cols - 1);
    // Empty rows at the bottom absorb the growth before anything scrolls.
    while (rows.length > cursor + 1 && !rows.at(-1)!.length) rows.pop();
    // Keep the cursor's row on the page: what no longer fits goes to scrollback.
    const drop = Math.max(0, cursor - (this.rows - 1), rows.length - this.rows);
    const top = Math.min(drop, cursor);
    this.scrolled.push(...rows.splice(0, top).map((l) => l.join("").trimEnd()));
    this.lines = rows.slice(0, this.rows);
    while (this.lines.length < this.rows) this.lines.push([]);
    this.row = cursor - top;
    this.cols = cols;
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    const line = this.lines[this.row]!;
    while (line.length < this.col) line.push(" ");
    line[this.col++] = ch;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) this.row++;
    else {
      this.scrolled.push(this.lines.shift()!.join("").trimEnd());
      this.lines.push([]);
    }
  }

  private escape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === "7" || next === "8") {
      if (next === "7") this.saved = { row: this.row, col: this.col };
      else ({ row: this.row, col: this.col } = this.saved);
      return start + 1;
    }
    if (next === "]") {
      // OSC: skip to BEL or ST.
      const bel = data.indexOf("\x07", start);
      const st = data.indexOf("\x1b\\", start);
      const ends = [bel, st >= 0 ? st + 1 : -1].filter((e) => e >= 0);
      return ends.length ? Math.min(...ends) : data.length;
    }
    if (next !== "[") return start + 1;
    let i = start + 2;
    let params = "";
    while (i < data.length && /[0-9;?]/.test(data[i]!)) params += data[i++];
    const final = data[i];
    const n = (fallback = 1) => {
      const v = Number.parseInt(params.replace("?", ""), 10);
      return Number.isFinite(v) ? v : fallback;
    };
    const clamp = (r: number) => Math.min(this.rows - 1, Math.max(0, r));
    switch (final) {
      case "A":
        this.row = clamp(this.row - n());
        break;
      case "B":
        this.row = clamp(this.row + n());
        break;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + n());
        break;
      case "D":
        this.col = Math.max(0, this.col - n());
        break;
      case "G":
        this.col = Math.max(0, n() - 1);
        break;
      case "H": {
        const [r, c] = params.split(";").map((p) => Number.parseInt(p, 10));
        this.row = clamp((r || 1) - 1);
        this.col = Math.max(0, (c || 1) - 1);
        break;
      }
      case "J":
        if (n(0) === 0) {
          this.lines[this.row]!.length = Math.min(this.lines[this.row]!.length, this.col);
          for (let r = this.row + 1; r < this.rows; r++) this.lines[r] = [];
        } else if (n(0) >= 2) this.lines = Array.from({ length: this.rows }, () => []);
        break;
      case "K": {
        const line = this.lines[this.row]!;
        const mode = n(0);
        if (mode === 0) line.length = Math.min(line.length, this.col);
        else if (mode === 2) this.lines[this.row] = [];
        else for (let c = 0; c <= this.col && c < line.length; c++) line[c] = " ";
        break;
      }
      case "s":
        this.saved = { row: this.row, col: this.col };
        break;
      case "u":
        ({ row: this.row, col: this.col } = this.saved);
        break;
    }
    return i;
  }
}
