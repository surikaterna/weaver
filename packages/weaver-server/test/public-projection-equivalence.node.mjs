import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const result = await build({ entryPoints: [fileURLToPath(new URL("../src/core/public-config-inspection.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node" });
const { publicConfigView } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("legacy public projection preserves unregistered values, safe markers, cyclic mounts and array slots", () => {
  const state = { _weaver: { hidden: "internal" }, ordinary: "unregistered",
    admin: "ordinary legacy value", secret: { _weaver: "secret-ref", key: "legacy reference" },
    safe: { _weaver: "mount", source: "ordinary" },
    denied: { _weaver: "mount", source: "_weaver.hidden" },
    a: { _weaver: "mount", source: "b" }, b: { _weaver: "mount", source: "a" },
    list: ["first", { _weaver: "mount", source: "_weaver.hidden" }, "third"] };
  const projected = publicConfigView.entries(state);
  assert.deepEqual(projected, { ordinary: state.ordinary, admin: state.admin, secret: state.secret,
    safe: state.safe, a: state.a, b: state.b, list: ["first", undefined, "third"] });
  assert.equal(Object.hasOwn(projected.list, 1), true);
  assert.equal(publicConfigView.delta({ action: "remove", key: "_weaver.hidden" }, state), null);
  assert.deepEqual(publicConfigView.delta({ action: "set", key: "denied", value: state.denied }, state),
    { action: "set", key: "denied", value: undefined });
  assert.deepEqual(publicConfigView.inspect("ordinary", [{ layer: "base", entries: state }]),
    { key: "ordinary", effectiveValue: "unregistered", effectiveLayer: "base", layerValues: { base: "unregistered" } });
});

test("legacy scopes and inspection keep merged public siblings without a registered-read gate", () => {
  const base = { cfg: { a: "base", sibling: "retained" }, _weaver: { hidden: true } };
  const scoped = { cfg: { a: "scoped" }, alias: { _weaver: "mount", source: "_weaver.hidden" } };
  const observed = publicConfigView.resolveScopes({ scope: scoped }, base, (_entries, state) => state);
  assert.deepEqual(observed, { scope: { cfg: { a: "scoped", sibling: "retained" } } });
  assert.deepEqual(publicConfigView.inspect("cfg", [{ layer: "base", entries: base }, { layer: "scope", entries: scoped }]),
    { key: "cfg", effectiveValue: { a: "scoped", sibling: "retained" }, effectiveLayer: undefined,
      layerValues: { base: { a: "base", sibling: "retained" }, scope: { a: "scoped" } } });
});
