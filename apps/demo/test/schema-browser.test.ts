import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "../src/demo-transport";
import { SCHEMA_FIXTURES } from "../src/registered-schema-fixtures";
import { schemaView } from "../src/ui/schema-browser";

test("fixture registration bodies retain exact separate identities and are cloned", async () => {
  const client = await createWeaverClient({ transport: createDemoTransport() });
  const response = await client.fetchSchemas();
  assert.ok(response);
  assert.deepEqual(
    Object.keys(response.schemas).sort(),
    SCHEMA_FIXTURES.map(({ key }) => key).sort(),
  );
  for (const fixture of SCHEMA_FIXTURES) {
    assert.equal(fixture.key, `${fixture.anchor}:${fixture.environment}`);
    assert.deepEqual(response.schemas[fixture.key], fixture.schema);
    assert.equal(JSON.parse(schemaView(response, fixture.key)).type, "object");
  }
  response.schemas["/app:default"] = { type: "string" };
  assert.deepEqual(
    (await client.fetchSchemas())?.schemas["/app:default"],
    SCHEMA_FIXTURES[0].schema,
  );
  await client.close();
});

test("read-only view distinguishes unsupported, empty, missing, and literal hostile text", () => {
  assert.match(schemaView(null, "/app:default"), /unsupported/);
  assert.match(schemaView({ schemas: {} }, "/app:default"), /empty/);
  assert.match(
    schemaView(
      { schemas: { "/app:prod": { type: "string" } } },
      "/app:default",
    ),
    /No registration/,
  );
  assert.match(
    schemaView(
      {
        schemas: {
          "/app:default": {
            type: "string",
            description: "<script>alert(1)</script>",
          },
        },
      },
      "/app:default",
    ),
    /<script>alert\(1\)<\/script>/,
  );
});
