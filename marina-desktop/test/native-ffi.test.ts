// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import * as bunFFI from "bun:ffi";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the installed SDK patch without creating OS windows. Keep Bun's
// real pointer/string and callback machinery; substitute only the native DLL
// and window registries, whose constructors require a running desktop app.
const sdk = dirname(fileURLToPath(import.meta.resolve("electrobun/bun")));
let dialogResult: string | null = null;
let trayPointer: bigint | null = 0x20_0000_0000_0001n;
const openFileDialog = mock(() => dialogResult);
let mimeCallback: bunFFI.JSCallback;
let trayCallback: bunFFI.JSCallback;
const c = bunFFI.cc({
  source: new URL("./fixtures/native-ffi.c", import.meta.url),
  symbols: {
    invoke_mime: { args: ["ptr"], returns: "cstring" },
    invoke_tray: { args: ["ptr", "ptr"], returns: "void" },
  },
});
mock.module("bun:ffi", () => ({
  ...bunFFI,
  dlopen: () => ({
    symbols: {
      openFileDialog,
      createTray: (...args: unknown[]) => {
        trayCallback = args[6] as bunFFI.JSCallback;
        return trayPointer;
      },
      setJSUtils: (mime: bunFFI.JSCallback) => {
        mimeCallback = mime;
      },
      setQuitRequestedHandler: () => {},
      setGlobalShortcutCallback: () => {},
      setURLOpenHandler: () => {},
      setAppReopenHandler: () => {},
    },
  }),
}));
for (const name of ["BrowserWindow", "BrowserView", "GpuWindow", "WGPUView", "Tray"]) {
  mock.module(join(sdk, "core", `${name}.ts`), () => ({
    [name]: { getById: () => undefined },
  }));
}
const { ffi } = await import(join(sdk, "proc/native.ts"));
const { default: events } = await import(join(sdk, "events/eventEmitter.ts"));
afterAll(() => {
  c.close();
  mock.restore();
});

describe("Electrobun compatibility with current Bun FFI", () => {
  const dialogOptions = {
    startingFolder: "/tmp",
    allowedFileTypes: "txt",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  };

  test("cancelled file dialogs return an empty selection without throwing", () => {
    dialogResult = null;
    expect(ffi.request.openFileDialog(dialogOptions)).toBe("");
    expect(openFileDialog.mock.calls.length).toBeGreaterThan(0);
  });

  test("selected file paths survive the native string boundary", () => {
    dialogResult = "/tmp/notes.txt";
    expect(ffi.request.openFileDialog(dialogOptions)).toBe("/tmp/notes.txt");
  });

  test("opaque pointers pass through without losing bigint precision", () => {
    const options = { id: 1, title: "Marina", image: "", template: false, width: 16, height: 16 };
    expect(ffi.request.createTray(options)).toBe(trayPointer);
    trayPointer = null;
    expect(() => ffi.request.createTray(options)).toThrow("Failed to create tray");
  });

  test("native MIME callbacks receive and return usable C strings", () => {
    expect(c.symbols.invoke_mime(mimeCallback.ptr!)).toBe("text/plain");
  });

  test("native tray callbacks preserve actions and structured menu data", async () => {
    const received = new Promise<{ data: unknown }>((resolve) =>
      events.once("tray-clicked", resolve),
    );
    const action = ffi.internal.serializeMenuAction("open-memory", { source: "note-17" });
    // The SDK queues this threadsafe callback; keep its C buffer alive until
    // the event has been consumed, as the real native wrapper does.
    const buffer = Buffer.from(`${action}\0`);
    c.symbols.invoke_tray(trayCallback.ptr!, bunFFI.ptr(buffer));
    expect((await received).data).toEqual({
      id: 7,
      action: "open-memory",
      data: { source: "note-17" },
    });
    expect(buffer.at(-1)).toBe(0);
  });
});
