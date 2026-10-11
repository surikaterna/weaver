import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionHost } from "./fixtures/session-host.mjs";
import { WritableMemory, writableOptions, commands } from "./fixtures/writable-memory.mjs";
import { principal } from "./fixtures/authority.mjs";
import { registration, viewSchema } from "./fixtures/memory.mjs";

test("schema restaging retains session contributions and expiry never preserves an invalid privileged fallback", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  input.schemas[0].schema = { type: "object", properties: {
    flag: { type: "string" }, cfg: { type: "object", properties: { a: { type: "number" } } },
  } };
  const s = await sessionHost({ provider, input });
  try {
    const info = (await s.activate()).value;
    await s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, value: "temporary" }));
    const schemas = s.controller.forSchemas(s.controller.mint({ ...s.claims, schemaPermissions: ["register"] }));
    const request = structuredClone(s.input.schemas[0]); request.schema.properties.flag.enum = ["temporary"];
    assert.equal((await schemas.register(request)).success, true);
    assert.equal(s.reader.get(["flag"]), "temporary");
    s.clock.time += 100; s.clock.fire(); await s.root.flush();
    assert.equal(s.reader.get(["flag"]), "before");
    assert.equal(s.reader.validate().validation.valid, false);
    assert.deepEqual(s.sessions.list(), []);
  } finally { await s.root.dispose(); }
});

test("invalid view fallback becomes unavailable rather than retaining expired override payload", async () => {
  const provider = new WritableMemory("disk", "base", { alpha: { flag: "base", instances: { one: { flag: "before" } } } });
  const input = writableOptions([provider]); input.layers.push({ kind: "session", layer: "incident" });
  input.schemas = [registration("east", "alpha", viewSchema())];
  const claims = principal(input, { sessionPermissions: ["read", "activate", "deactivate"] });
  claims.grants.push({ ...claims.grants[0], views: ["one"] });
  const s = await sessionHost({ provider, input, claims });
  try {
    const view = s.reader.forView("one"); await view.prepare();
    const info = (await s.activate({ viewId: "one" })).value;
    assert.equal((await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", viewId: "one", layer: "incident", sessionId: info.id, value: "temporary" }))).success, true);
    const schemas = s.controller.forSchemas(s.controller.mint({ ...claims, schemaPermissions: ["register"] }));
    const request = structuredClone(input.schemas[0]); request.schema.properties.flag.enum = ["temporary"];
    assert.equal((await schemas.register(request)).success, true);
    assert.equal(view.get(["flag"]), "temporary");
    assert.equal((await s.sessions.deactivate({ sessionId: info.id })).ok, true);
    assert.throws(() => view.get(["flag"]), { code: "VALIDATION_ERROR" });
    assert.equal(s.reader.get(["flag"]), "base");
  } finally { await s.root.dispose(); }
});
