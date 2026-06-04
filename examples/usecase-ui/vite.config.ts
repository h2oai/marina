import { resolve } from "node:path";

const marinaTarget = process.env.MARINA_HTTP_URL ?? "http://localhost:3300";

export default {
  base: "/",
  build: {
    outDir: resolve(__dirname, "../../dist/usecase-ui"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": marinaTarget,
    },
  },
};
