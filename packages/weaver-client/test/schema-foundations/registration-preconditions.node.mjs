import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpTransport } from "../../src/http-transport.ts";

const service = {
  serviceId: "svc",
  environment: "dev",
  owner: { name: "team", contact: "team@example.com" },
  schema: { type: "object" },
  fragmentSlots: [],
};
const fragment = {
  serviceId: "svc",
  environment: "dev",
  owner: service.owner,
  schema: { type: "object" },
  providerId: "plugin",
  slotPath: "/plugins",
};

for (const [kind, request] of [["services", service], ["fragments", fragment]]) {
  test(`29r SDK: ${kind} carry revision separately and retain compatibility response`, async (t) => {
    const calls = [];
    const data = {
      success: true,
      isNewSchema: false,
      hasBreakingChanges: true,
      revision: "next-revision",
      compatibility: "unknown",
    };
    const transport = createHttpTransport({
      baseUrl: "http://localhost:3399",
      fetch: async (url, options) => {
        calls.push({ url: String(url), options });
        return Response.json({ data, meta: { revision: data.revision } });
      },
    });
    t.after(() => transport.close());
    assert.deepEqual(await transport.registerSchema(request, { ifRevision: "current-revision" }), data);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://localhost:3399/v1/admin/schemas/${kind}`);
    assert.equal(new Headers(calls[0].options.headers).get("If-Match"), '"current-revision"');
    assert.deepEqual(JSON.parse(calls[0].options.body), request);
    assert.equal("ifRevision" in request, false);
  });
}

test("29r SDK: a stale registration is returned as a conflict and is not retried", async (t) => {
  let calls = 0;
  const error = { code: "REVISION_CONFLICT", message: "Revision is stale" };
  const transport = createHttpTransport({
    baseUrl: "http://localhost:3399",
    retry: { maxAttempts: 3, baseDelay: 0, maxDelay: 0 },
    fetch: async () => {
      calls += 1;
      return Response.json({ data: null, meta: { revision: "new" }, error }, { status: 409 });
    },
  });
  t.after(() => transport.close());
  const result = await transport.registerSchema(service, { ifRevision: "old" });
  assert.equal(result.success, false);
  assert.deepEqual(result.error, error);
  assert.equal(calls, 1);
});

test("29r SDK: invalid preconditions reject before fetch; omission sends no If-Match", async (t) => {
  const calls = [];
  const transport = createHttpTransport({
    baseUrl: "http://localhost:3399",
    fetch: async (_url, options) => {
      calls.push(options);
      return Response.json({
        data: { success: true, isNewSchema: true, hasBreakingChanges: false },
        meta: { revision: "new" },
      });
    },
  });
  t.after(() => transport.close());
  for (const options of [{ ifRevision: "" }, { ifRevision: 12 }, { unknown: true }]) {
    await assert.rejects(transport.registerSchema(service, options));
  }
  assert.equal(calls.length, 0);
  assert.equal((await transport.registerSchema(service)).success, true);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].headers).has("If-Match"), false);
});
