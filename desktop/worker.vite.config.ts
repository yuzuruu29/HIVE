import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  environments: {
    client: { consumer: "server", keepProcessEnv: true },
    ssr: { consumer: "server", keepProcessEnv: true },
  },
  build: {
    target: "node22",
    outDir: "dist/desktop/electron",
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: "src/desktop/electron/worker.ts",
      external: (id) => id === "electron" || id.startsWith("node:") || builtinModules.includes(id),
      output: { format: "es", entryFileNames: "worker.mjs", inlineDynamicImports: true },
    },
  },
});
