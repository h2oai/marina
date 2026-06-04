export default {
  app: {
    name: "Marina",
    identifier: "dev.marina.desktop",
    version: "0.4.2",
  },

  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      dashboard: {
        entrypoint: "src/views/dashboard/index.ts",
      },
    },
    copy: {
      // Dashboard SPA build output
      "dist/dashboard": "views/dashboard/app",
      // World room definitions for the engine (each world's roomsDir lives
      // under worlds/<name>/; room files import only types, so they load at
      // runtime with no bundling deps).
      "../worlds": "resources/worlds",
      // View HTML shell
      "src/views/dashboard/index.html": "views/dashboard/index.html",
      // Tray icons
      "assets/tray-icon.png": "resources/tray-icon.png",
      "assets/tray-icon-active.png": "resources/tray-icon-active.png",
    },
  },

  mac: {
    icon: "assets/icon.icns",
    codeSign: false,
    notarize: false,
  },

  release: {
    baseUrl: "",
  },
};
