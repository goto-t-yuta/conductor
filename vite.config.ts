import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  root: path.resolve(__dirname),
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    target: "chrome136",
  },
  server: {
    port: 5179,
    strictPort: true,
  },
});
