import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  root: __dirname,
  server: {
    port: 57326,
    proxy: {
      "/api": "http://127.0.0.1:57325",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});