import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/contract-derivation.ts",
    "src/json-schema-generator.ts",
    "src/layers.ts",
    "src/scope.ts",
    "src/schema-validation-session.ts",
    "src/zod-schema-generator.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
});
