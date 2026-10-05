import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/internal/server-adapter.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
