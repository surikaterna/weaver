import assert from "node:assert/strict";
import { test } from "node:test";
import { registryProjectionReaderSchema } from "../dist/index.js";
import { createRegistryAdapter } from "../dist/internal/server-adapter.js";
import { fragment, service } from "./fixtures/requests.mjs";

test("candidate projection is narrow, detached, and unpublished until commit", () => {
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev" });
  const prepared = adapter.prepare(service());
  assert.equal(prepared.result.success, true);
  assert.equal(adapter.revision, 0);
  assert.deepEqual(Object.keys(prepared.preview).sort(), [
    "listRegisteredSchemaIdentities", "resolveAnchor",
  ]);
  assert.equal(Object.isFrozen(prepared.preview), true);
  assert.equal(registryProjectionReaderSchema.safeParse(prepared.preview).success, true);
  assert.equal(registryProjectionReaderSchema.safeParse({ resolveAnchor: 1 }).success, false);
  assert.equal(adapter.reader.resolveAnchor("/svc"), null);
  const preview = prepared.preview.resolveAnchor("/svc/name");
  assert.equal(preview.path, "/svc");
  preview.metadata.owner.name = "not the owner";
  prepared.candidate.schemas.clear();
  const identities = prepared.preview.listRegisteredSchemaIdentities();
  identities.anchors.length = 0;
  identities.slots[0].path = "/changed";
  assert.equal(prepared.preview.listRegisteredSchemaIdentities().anchors.length, 1);
  assert.equal(prepared.preview.listRegisteredSchemaIdentities().slots[0].path, "/svc/plugins");
  prepared.publish();
  assert.equal(adapter.revision, 1);
  assert.equal(adapter.reader.resolveAnchor("/svc").metadata.owner.name, "owner");
  assert.deepEqual(adapter.reader.listRegisteredSchemaIdentities(), prepared.preview.listRegisteredSchemaIdentities());
  adapter.snapshot().schemas.clear();
  assert.notEqual(adapter.reader.resolveAnchor("/svc"), null);
});

test("preview preparation leaves committed pagination intact; publication alone advances revision", () => {
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev", schemaIdentityMaxPageSize: 1 });
  adapter.prepare(service()).publish();
  const page = adapter.reader.listRegisteredSchemaIdentityPage({ limit: 1 });
  const rejected = adapter.prepare(fragment("missing"));
  assert.equal(rejected.result.success, false);
  assert.equal(rejected.preview, undefined);
  const prepared = adapter.prepare(service("next"));
  assert.equal(prepared.preview.resolveAnchor("/svc", "next").environment, "next");
  assert.equal(adapter.reader.resolveAnchor("/svc", "next"), null);
  assert.equal(adapter.revision, 1);
  assert.doesNotThrow(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor: page.nextCursor }));
  prepared.publish();
  assert.equal(adapter.revision, 2);
  assert.throws(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor: page.nextCursor }), { code: "REVISION_CONFLICT" });
  assert.throws(() => prepared.publish(), { code: "REVISION_CONFLICT" });
  assert.equal(adapter.revision, 2);
  adapter.prepare(service("next")).publish();
  assert.equal(adapter.revision, 3);
});
