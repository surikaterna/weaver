import { build } from "esbuild";

export async function sourceModule(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
