import assert from "node:assert/strict";
import { test } from "node:test";
import { initialized, record } from "./validated-fixtures.mjs";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { createRollbackService } from "../src/core/rollback-service.ts";

test("mic8 rollback uses conditional canonical writes, never provider revert before validation", async () => {
  const fixture = await initialized({ data: { svc: { value: 1 } }, records: [record("svc", { type: "object", required: ["value"], properties: { value: { type: "integer" } }, additionalProperties: false })] });
  const registry = createSchemaRegistry({ configService: fixture.service });
  let historical = { value: 2 };
  fixture.platform.revert = () => assert.fail("raw provider rollback is forbidden");
  const rollback = createRollbackService({ configService: fixture.service, schemaRegistry: registry, resolveValue: async () => historical });
  const request = { layer: "platform", environment: "dev", anchorPath: "/svc", toRevision: "history-v1", expectedRevision: fixture.service.revision, actor: "operator" };
  try {
    const result = await rollback.rollback(request);
    assert.equal(result.success, true);
    assert.equal(result.revision, fixture.service.revision);
    assert.equal(await fixture.service.get("svc.value"), 2);
    assert.equal((await rollback.rollback(request)).error.code, "REVISION_CONFLICT");
    historical = { value: "invalid" };
    const revision = fixture.service.revision;
    assert.equal((await rollback.rollback({ ...request, expectedRevision: revision })).error.code, "VALIDATION_ERROR");
    assert.equal(fixture.service.revision, revision);
    assert.equal(await fixture.service.get("svc.value"), 2);
    assert.equal((await createRollbackService({ configService: fixture.service }).rollback({ ...request, expectedRevision: revision })).error.code, "UNSUPPORTED_AUTHORITY");
    assert.equal((await rollback.rollback({ ...request, anchorPath: "/_weaver", expectedRevision: revision })).error.code, "VALIDATION_ERROR");
  } finally { await fixture.service.close(); }
});
