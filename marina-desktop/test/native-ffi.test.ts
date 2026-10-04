// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import * as bunFFI from "bun:ffi";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the pinned v2 devkit without creating OS windows. Keep Bun's
// real pointer/string and callback machinery; substitute only the native DLL
// and window registries, whose constructors require a running desktop app.
const sdk = fileURLToPath(new URL("../.hutch/devkit/api/sdks/main/", import.meta.url));
let dialogResult: string | null = null;
// V2 owns native pointers in the core and exposes numeric object IDs to JS.
let trayId = 7;
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
        trayCallback = args[5] as bunFFI.JSCallback;
        return trayId;
      },
      setJSUtils: (mime: bunFFI.JSCallback) => {
        mimeCallback = mime;
      },
      setQuitRequestedHandler: () => {},
      setGlobalShortcutCallback: () => {},
      setURLOpenHandler: () => {},
      setAppReopenHandler: () => {},
      setRuntimeCallbacksAsync: () => {},
      getHostMessageWakeupReadFD: () => -1,
      popQueuedHostMessageBatch: () => null,
    },
  }),
}));
for (const name of ["BrowserWindow", "BrowserView", "GpuWindow", "WGPUView", "Tray"]) {
  mock.module(join(sdk, "core", `${name}.ts`), () => ({
    [name]: { getById: () => undefined },
    ...(name === "BrowserView" ? { emitWebviewTagBrowserViewCreated: () => {} } : {}),
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
    expect(JSON.parse(ffi.request.openFileDialog(dialogOptions))).toEqual([]);
    expect(openFileDialog.mock.calls.length).toBeGreaterThan(0);
  });

  test("selected file paths survive the native string boundary", () => {
    dialogResult = JSON.stringify(["/tmp/notes.txt"]);
    expect(JSON.parse(ffi.request.openFileDialog(dialogOptions))).toEqual(["/tmp/notes.txt"]);
  });

  test("native tray IDs pass through and failed creation is rejected", () => {
    const options = { id: 1, title: "Marina", image: "", template: false, width: 16, height: 16 };
    expect(ffi.request.createTray(options)).toBe(trayId);
    trayId = 0;
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
