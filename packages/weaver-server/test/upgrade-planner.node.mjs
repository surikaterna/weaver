import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalInternalJson } from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import {
  planRequest,
  sourceSchema,
  targetSchema,
} from "./upgrade-planner-fixture.mjs";
import { rawRuntimeProviders } from "./upgrade-test-providers.mjs";

test("runtime planner snapshots real FS authority without writes or lifecycle effects", { timeout: 30_000 }, async (t) => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", false)).success, true);
    const provider = rawRuntimeProviders(runtime).find((item) => item.id === "platform");
    const authority = provider.authority;
    const writes = { commit: 0, legacy: 0, flush: 0 };
    const commit = authority.commitLayer.bind(authority);
    t.mock.method(authority, "commitLayer", async (...args) => { writes.commit++; return commit(...args); });
    for (const method of ["write", "remove", "writeLayer", "removeLayer", "flush"])
      if (typeof provider[method] === "function") {
        const original = provider[method].bind(provider);
        t.mock.method(provider, method, async (...args) => { method === "flush" ? writes.flush++ : writes.legacy++; return original(...args); });
      }
    const revision = runtime.configService.revision;
    const request = planRequest(runtime, fixture.request, targetSchema);
    const first = await runtime.planUpgrade(request);
    const second = await runtime.planUpgrade(structuredClone(request));
    assert.deepEqual(first, second);
    assert.equal(first.result.status, "ready");
    assert.deepEqual(writes, { commit: 0, legacy: 0, flush: 0 });
    assert.equal(runtime.configService.revision, revision);
    assert.equal(runtime.state, "ready");
    assert.equal(await runtime.configService.get("svc.added"), undefined);
    assert.equal(canonicalInternalJson(first).includes("secret"), false);
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("runtime planner binds concurrent inventory/revision changes without effects", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    const request = planRequest(runtime, fixture.request, targetSchema);
    request.expectedAuthorityRevision = "authority-v1.stale";
    const result = await runtime.planUpgrade(request);
    assert.equal(result.result.status, "blocked");
    assert.equal(result.result.refusals[0].code, "stale-binding");
    assert.equal(runtime.state, "ready");
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("snapshot final pass detects a cross-provider race", async (t) => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  const input = structuredClone(fixture.request);
  input.generation.providers.push({ id: "second", factory: "fs", options: { filePath: `${fixture.directory}/second/entries.json` } });
  input.generation.layout.layers.push({ name: "second", type: "static", providerId: "second", config: { mergeId: "deep" } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, input, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", false)).success, true);
    const first = rawRuntimeProviders(runtime).find((provider) => provider.id === "platform");
    const second = rawRuntimeProviders(runtime).find((provider) => provider.id === "second");
    const firstInventory = first.authority.inventory.bind(first.authority);
    const secondInventory = second.authority.inventory.bind(second.authority);
    let changed = false;
    t.mock.method(first.authority, "inventory", async () => {
      const value = await firstInventory();
      if (!changed) return value;
      return { ...value, revisions: value.revisions.map((revision) => ({ ...revision, sequence: String(BigInt(revision.sequence) + 1n) })) };
    });
    t.mock.method(second.authority, "inventory", async () => {
      changed = true;
      return secondInventory();
    });
    const result = await runtime.planUpgrade(planRequest(runtime, input, targetSchema));
    assert.equal(result.result.status, "blocked");
    assert.equal(result.result.refusals[0].code, "stale-binding");
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("plan request is detached before snapshot awaits", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", false)).success, true);
    const request = planRequest(runtime, fixture.request, targetSchema);
    const pending = runtime.planUpgrade(request);
    request.target.registrations = {};
    const result = await pending;
    assert.equal(result.result.status, "ready");
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("snapshot collector is not exposed on the public config service", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal("upgradePlanningSnapshot" in runtime.configService, false);
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});
