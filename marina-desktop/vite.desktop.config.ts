import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Desktop-specific Vite config for the dashboard SPA.
 *
 * Differences from dashboard/vite.config.ts:
 * - base: "./" for relative asset paths (loaded from views:// protocol)
 * - Output to desktop/dist/dashboard/ (copied into the Electrobun bundle)
 * - No dev server proxy needed (RPC shim handles API routing)
 */
export default defineConfig({
  root: resolve(__dirname, "../dashboard"),
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/dashboard"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Stable filenames for the HTML shell to reference
        entryFileNames: "index.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "../dashboard/src"),
    },
  },
});
