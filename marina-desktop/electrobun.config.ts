// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import type { ElectrobunConfig } from "electrobun";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default {
  app: {
    name: "Marina",
    identifier: "dev.marina.desktop",
    version,
  },

  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    mac: {
      icons: "assets/icon.iconset",
      codesign: Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
      notarize: Boolean(
        process.env.ELECTROBUN_DEVELOPER_ID &&
          process.env.APPLE_ID &&
          process.env.APPLE_TEAM_ID &&
          process.env.APPLE_PASSWORD,
      ),
    },
    linux: { icon: "assets/icon.png" },
    win: { icon: "assets/icon.png" },
    views: {
      dashboard: {
        entrypoint: "src/views/dashboard/index.ts",
      },
    },
    copy: {
      // Dashboard SPA build output
      "dist/dashboard": "views/dashboard/app",
      // External room modules with their runtime dependencies bundled.
      "dist/rooms": "resources/worlds",
      // View HTML shell
      "src/views/dashboard/index.html": "views/dashboard/index.html",
      // Tray icons
      "assets/tray-icon.png": "resources/tray-icon.png",
      "assets/tray-icon-active.png": "resources/tray-icon-active.png",
      "../LICENSE": "LICENSE",
      "../NOTICE": "NOTICE",
    },
  },

  release: {
    baseUrl: "",
    generatePatch: false,
  },
  scripts: {
    postBuild: "scripts/package-runtime.ts",
  },
} satisfies ElectrobunConfig;
