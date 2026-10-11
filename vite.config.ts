import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = process.cwd();

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(projectRoot, "popup/index.html"),
        youtubeContentScript: resolve(
          projectRoot,
          "src/content/youtubeContentScript.ts",
        ),
        pageBridge: resolve(projectRoot, "src/content/pageBridge.ts"),
        serviceWorker: resolve(projectRoot, "src/background/serviceWorker.ts"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
