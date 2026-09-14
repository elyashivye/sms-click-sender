import { defineConfig } from "vite";

// Electron loads the build from a relative file:// path, so assets must use
// relative URLs instead of absolute "/..." ones.
export default defineConfig({
  base: "./",
  server: {
    // WebUSB requires a secure context; plain http://localhost counts as one.
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
