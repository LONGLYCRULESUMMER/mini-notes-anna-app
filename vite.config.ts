import { defineConfig } from "vite";

// The Anna App SDK is served by the host (harness or production) at an
// absolute path inside the iframe origin. It must stay an external,
// unbundled import — Vite must not try to resolve it at build time.
const ANNA_SDK = "/static/anna-apps/_sdk/latest/index.js";

export default defineConfig({
  // Relative base so the bundle works when served under
  // /anna-apps/<slug>/dev/ by the local harness.
  base: "./",
  build: {
    outDir: "bundle",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      external: [ANNA_SDK],
    },
  },
});
