import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(here, "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(here, "..", "dist-desktop", "renderer"),
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: path.resolve(here, "renderer", "src", "test-setup.ts"),
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
  },
});
