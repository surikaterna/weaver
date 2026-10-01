import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("tsup"))("esbuild");
const source = fileURLToPath(new URL("../src/", import.meta.url));

export async function loadPrivateSafetyModules() {
  const bundle = await esbuild.build({
    stdin: {
      contents: `export * from "./schema-validation-schema-stability.ts";
export * from "./deep-equal.ts";
export * from "./path.ts";`,
      resolveDir: source,
      sourcefile: "validator-own-data-private-tests.mjs",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

// The callback must be synchronous; assertions and runner output happen after restoration.
export function underNumericTrap(prototype, index, callback) {
  const key = String(index);
  const previous = Object.getOwnPropertyDescriptor(prototype, key);
  let getters = 0;
  let setters = 0;
  let value;
  try {
    Object.defineProperty(prototype, key, {
      configurable: true,
      get() { getters++; return undefined; },
      set(data) {
        setters++;
        Object.defineProperty(this, key, {
          value: data, configurable: true, enumerable: true, writable: true,
        });
      },
    });
    value = callback();
  } finally {
    if (previous === undefined) delete prototype[key];
    else Object.defineProperty(prototype, key, previous);
  }
  return { value, getters, setters };
}

export async function probeCanonicalRoots() {
  const engine = await import("../dist/index.js");
  const schema = {
    type: "object", additionalProperties: false,
    properties: { enabled: {
      type: "boolean", anyOf: [{ type: "boolean", const: true }, { type: "boolean", const: false }],
    } },
  };
  const roots = [
    ["effective", () => engine.validateEffectiveConfiguration(schema, { enabled: true })],
    ["partial", () => engine.validatePartialConfiguration(schema, { enabled: true })],
    ["patch", () => engine.validateConfigurationPatch(schema, "enabled", true)],
  ];
  let safe = true;
  for (const [name, prototype] of [["object", Object.prototype], ["array", Array.prototype]]) {
    for (const index of [0, 1, 700]) {
      for (const [root, invoke] of roots) {
        const { value, getters, setters } = underNumericTrap(prototype, index, invoke);
        console.log(JSON.stringify({ prototype: name, index, root, getters, setters, result: value }));
        safe = getters === 0 && setters === 0 && value.valid && safe;
      }
    }
  }
  return safe;
}
