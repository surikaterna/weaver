import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "/weaver/",
  root: ".",
  build: { outDir: "dist" },
  resolve: {
    alias: {
      "node:fs/promises": resolve(__dirname, "src/stubs/node-fs.ts"),
      "fs/promises": resolve(__dirname, "src/stubs/node-fs.ts"),
      "node:fs": resolve(__dirname, "src/stubs/node-fs-sync.ts"),
      "fs": resolve(__dirname, "src/stubs/node-fs-sync.ts"),
      "node:path": resolve(__dirname, "src/stubs/node-path.ts"),
      "path": resolve(__dirname, "src/stubs/node-path.ts"),
    },
  },
});
