import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Dev-server proxy target. Override with VITE_API_HOST when the Marina
// server runs on a non-default port or host (e.g. staging, container).
const apiHost = process.env.VITE_API_HOST ?? "localhost:3300";
const httpTarget = `http://${apiHost}`;
const wsTarget = `ws://${apiHost}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/dashboard/",
  build: {
    outDir: resolve(__dirname, "../dist/dashboard"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Function form (not the object sugar): Vite 8's rolldown bundler
        // expects manualChunks as a function. Splits heavy vendor libs into
        // their own chunks, matched by module path.
        manualChunks(id: string) {
          if (id.includes("node_modules/@tanstack/react-query")) return "vendor-query";
          if (id.includes("node_modules/@xyflow/react")) return "vendor-xyflow";
          if (id.includes("node_modules/@tiptap/")) return "vendor-tiptap";
          if (id.includes("node_modules/react-grid-layout")) return "vendor-grid";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": httpTarget,
      "/assets": httpTarget,
      "/dashboard-ws": { target: wsTarget, ws: true },
      "/ws": { target: wsTarget, ws: true },
      "/canvas-ws": { target: wsTarget, ws: true },
    },
  },
});
