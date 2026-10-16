// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";

/** Terminal device for deterministic keyboard/reflow and live-service replay qualification. */
export class InvestigationScreen implements Terminal {
  columns = 110;
  rows = 30;
  kittyProtocolActive = false;
  output = "";
  stops = 0;
  private buffer = new StdinBuffer();
  resize = () => {};
  start(input: (text: string) => void, resize: () => void) {
    this.resize = resize;
    this.buffer.on("data", input);
    this.buffer.on("paste", (text) => input(`\x1b[200~${text}\x1b[201~`));
  }
  send(text: string) {
    this.buffer.process(text);
  }
  stop() {
    this.stops++;
    this.buffer.destroy();
  }
  async drainInput() {}
  write(text: string) {
    this.output += text;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgramStatus() {}
  setProgress() {}
}
