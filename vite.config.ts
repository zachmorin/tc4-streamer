import { defineConfig } from "vite";
import { resolve } from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        viewer: resolve(root, "index.html"),
        goLive: resolve(root, "go-live.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
