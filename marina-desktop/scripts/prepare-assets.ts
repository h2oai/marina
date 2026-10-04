// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { prepareRooms } from "./prepare-rooms";

const project = resolve(import.meta.dir, "..");
await prepareRooms(project);
// Reuse Marina's existing icon, including its original high-resolution images.
if (process.platform === "darwin") {
  execFileSync("iconutil", [
    "-c",
    "iconset",
    resolve(project, "assets/icon.icns"),
    "-o",
    resolve(project, "assets/icon.iconset"),
  ]);
}
const cache = resolve(project, ".font-cache");
const target = resolve(project, "dist/dashboard/assets");
mkdirSync(cache, { recursive: true });
mkdirSync(target, { recursive: true });
const fonts = {
  "orbitron.woff2": "https://fonts.gstatic.com/s/orbitron/v31/yMJRMIlzdpvBhQQL_Qq7dy0.woff2",
  "share-tech-mono.woff2":
    "https://fonts.gstatic.com/s/sharetechmono/v15/J7aHnp1uDWRBEqV98dVQztYldFcLowEF.woff2",
};
for (const [name, url] of Object.entries(fonts)) {
  const cached = resolve(cache, name);
  if (!existsSync(cached) || statSync(cached).size === 0) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 4)) !== "wOF2")
        throw new Error("Invalid WOFF2 font");
      await Bun.write(cached, bytes);
    } catch (error) {
      console.warn(
        `[desktop] Could not cache ${name}; using system fonts:`,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
  }
  copyFileSync(cached, resolve(target, name));
}
