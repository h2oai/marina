// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Injected only into the smoke test's disposable copy of the native bundle.
// Exercise React inputs and the real Electroview RPC adapter, without a test
// endpoint, privileged token, or instrumentation in the distributed app.
(async () => {
  async function until(find, label) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Native UI deadline: ${label}`);
  }
  await until(() => document.querySelector("#root")?.children.length, "React mounted");
  console.log("[native-smoke] React mounted");
  document.querySelector('[aria-label="Dismiss getting-started guide"]')?.click();
  const input = await until(() => document.querySelector("#marina-name-input"), "login form");
  console.log("[native-smoke] Login form ready");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    input,
    "Native UI Resident",
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const connect = await until(
    () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "Connect" && !button.disabled,
      ),
    "Connect button",
  );
  connect.click();
  const command = await until(
    () => document.querySelector("#marina-command-input"),
    "logged-in command input",
  );
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(command, "look");
  command.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => command.value === "look", "command draft");
  command.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(
    () =>
      command.value === "" &&
      document.querySelector('[data-pane-key="webchat"]')?.textContent.includes("Workbench"),
    "look transcript",
  );
  const response = await fetch("http://marina.desktop.invalid/api/world");
  const world = await response.json();
  if (!response.ok || !world.rooms?.length) throw new Error("Native RPC world snapshot missing");
  const headers = { Authorization: `Bearer ${localStorage.getItem("marina_chat_token")}` };
  for (const path of ["/api/routing/overview", "/api/entities/NativeUIResident/preview"]) {
    const result = await fetch(path, { headers });
    if (!result.ok) throw new Error(`Native API ${path}: ${result.status} ${await result.text()}`);
  }
  await until(
    () =>
      document
        .querySelector('[aria-label="My inventory"]')
        ?.textContent.includes("carrying nothing"),
    "resident inventory",
  );
  // Asset library through the native bridge: chunked upload with progress,
  // dedupe, library view, bytes into an element, edit and delete.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const uploadPng = async () => {
    const form = new FormData();
    form.append("file", new File([png], "smoke.png", { type: "image/png" }));
    const progress = [];
    const res = await window.marinaDesktop.sendBody({
      url: "http://marina.desktop.invalid/api/assets",
      method: "POST",
      headers,
      body: form,
      onProgress: (f) => progress.push(f),
    });
    if (progress.at(-1) !== 1) throw new Error(`Native upload progress: ${progress}`);
    return { status: res.status, body: await res.json() };
  };
  const first = await uploadPng();
  if (first.status !== 201) throw new Error(`Native upload: ${first.status}`);
  const again = await uploadPng();
  if (again.status !== 200 || !again.body.deduplicated) throw new Error("Native dedupe missing");
  const library = await (
    await fetch("/api/assets?view=library&type=image&facets=1", { headers })
  ).json();
  if (!library.items?.some((item) => item.id === first.body.id) || !library.facets) {
    throw new Error("Native library view missing the upload");
  }
  const bytes = await fetch(first.body.url, { headers });
  const blobUrl = URL.createObjectURL(await bytes.blob());
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Native asset bytes did not render"));
    img.src = blobUrl;
  });
  if (img.naturalWidth !== 1) throw new Error("Native asset image size");
  const patched = await fetch(`/api/assets/${first.body.id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ caption: "native smoke" }),
  });
  if (!patched.ok || (await patched.json()).caption !== "native smoke") {
    throw new Error("Native asset edit");
  }
  const removed = await fetch(`/api/assets/${first.body.id}`, { method: "DELETE", headers });
  if (!removed.ok) throw new Error(`Native asset delete: ${removed.status}`);
  console.log("[native-smoke] Asset library passed");
  await until(() => !document.getElementById("splash"), "splash dismissed");
  if (document.getElementById("__err")) throw new Error("Native startup error overlay");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
    command,
    "say __MARINA_SMOKE_MARKER__",
  );
  command.dispatchEvent(new Event("input", { bubbles: true }));
  command.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  console.log("[native-smoke] UI and RPC passed");
})().catch((error) => console.error("[native-smoke] UI failed:", error.message));
