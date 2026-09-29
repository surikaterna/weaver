import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeaverError } from "@weaver-conf/config-types";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "../src/demo-transport";
import { SCHEMA_FIXTURES } from "../src/registered-schema-fixtures";
import { createSeededSchemaPages } from "../src/seeded-schema-pages";
import {
  SchemaBrowserController,
  schemaBrowseError,
} from "../src/ui/schema-browser-controller";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("offline fixture still serves two anchors and two detail-free slots", async () => {
  const base = createDemoTransport();
  const page = await base.listRegisteredSchemaIdentityPage();
  assert.deepEqual(
    page.anchors.map(({ path }) => path),
    SCHEMA_FIXTURES.map(({ anchor }) => anchor),
  );
  assert.deepEqual(
    page.slots.map(({ path }) => path),
    ["/app/extensions", "/app/plugins"],
  );
  for (const fixture of SCHEMA_FIXTURES) {
    const detail = await base.getRegisteredSchema(
      fixture.anchor,
      fixture.environment,
    );
    assert.deepEqual(detail.schema, fixture.schema);
    detail.schema.description = "mutated";
    assert.deepEqual(
      (await base.getRegisteredSchema(fixture.anchor, fixture.environment))
        .schema,
      fixture.schema,
    );
  }
  await assert.rejects(
    base.getRegisteredSchema("/app/plugins", "default"),
    /404/,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("closed inspector never fetches; explicit selection fetches exact detail only", async () => {
  const base = createDemoTransport();
  const calls = { page: 0, detail: 0, bulk: 0 };
  const client = await createWeaverClient({
    transport: {
      ...base,
      async listRegisteredSchemaIdentityPage(input) {
        calls.page++;
        return base.listRegisteredSchemaIdentityPage(input);
      },
      async getRegisteredSchema(path, env) {
        calls.detail++;
        return base.getRegisteredSchema(path, env);
      },
      async fetchSchemas() {
        calls.bulk++;
        return base.fetchSchemas();
      },
    },
  });
  const browser = new SchemaBrowserController(client, () => {});
  assert.deepEqual(calls, { page: 0, detail: 0, bulk: 0 });
  browser.open();
  await tick();
  assert.deepEqual(calls, { page: 1, detail: 0, bulk: 0 });
  assert.equal(browser.state.page?.anchors.length, 2);
  assert.equal(browser.state.page?.slots.length, 2);
  assert.equal(browser.state.page?.hasMore, false);
  browser.select({ kind: "service", path: "/app", environment: "default" });
  await tick();
  assert.equal(calls.detail, 1);
  assert.equal(browser.state.detail?.path, "/app");
  browser.setFragments(true);
  browser.select({
    kind: "slot",
    path: "/app/plugins",
    environment: "default",
  });
  assert.equal(browser.state.detail, undefined);
  assert.match(browser.state.status, /another page/);
  browser.select({
    kind: "fragment",
    path: "/app/plugins/demo.notifications",
    environment: "default",
  });
  await tick();
  assert.equal(calls.detail, 2);
  assert.equal(browser.state.detail?.kind, "fragment");
  browser.close();
  assert.equal(browser.state.detail, undefined);
  assert.equal(browser.state.open, false);
  assert.equal(calls.bulk, 0);
  await client.close();
});

test("late page and detail never replace a reset or newer selection", async () => {
  const base = createDemoTransport();
  const page =
    deferred<
      Awaited<ReturnType<typeof base.listRegisteredSchemaIdentityPage>>
    >();
  const detail =
    deferred<Awaited<ReturnType<typeof base.getRegisteredSchema>>>();
  let pages = 0;
  const client = await createWeaverClient({
    transport: {
      ...base,
      async listRegisteredSchemaIdentityPage(input) {
        return ++pages === 1
          ? page.promise
          : base.listRegisteredSchemaIdentityPage(input);
      },
      async getRegisteredSchema() {
        return detail.promise;
      },
    },
  });
  const browser = new SchemaBrowserController(client, () => {});
  browser.open();
  browser.close();
  page.resolve(await base.listRegisteredSchemaIdentityPage());
  await tick();
  assert.equal(browser.state.page, undefined);
  browser.open();
  await tick();
  browser.select({ kind: "service", path: "/app", environment: "default" });
  browser.reset();
  detail.resolve(await base.getRegisteredSchema("/app", "default"));
  await tick();
  assert.equal(browser.state.detail, undefined);
  await client.close();
});

test("filter during pending page keeps one request and accepts its response", async () => {
  const base = createDemoTransport();
  const page =
    deferred<
      Awaited<ReturnType<typeof base.listRegisteredSchemaIdentityPage>>
    >();
  let calls = 0;
  const client = await createWeaverClient({
    transport: {
      ...base,
      async listRegisteredSchemaIdentityPage() {
        calls++;
        return page.promise;
      },
    },
  });
  const browser = new SchemaBrowserController(client, () => {});
  browser.open();
  browser.setFragments(true);
  page.resolve(await base.listRegisteredSchemaIdentityPage());
  await tick();
  assert.equal(calls, 1);
  assert.equal(browser.state.includeFragments, true);
  assert.equal(browser.state.page?.anchors.length, 2);
  browser.close();
  await client.close();
});

test("paged navigation replaces at most 50 entries; stale offers restart, auth retry", async () => {
  const base = createDemoTransport();
  const anchors = Array.from({ length: 152 }, (_, i) => ({
    kind: "service" as const,
    path: `/app/${String(i).padStart(3, "0")}`,
    environment: "default",
  }));
  const pages = createSeededSchemaPages({ anchors, slots: [] });
  let failure: "stale" | "auth" | null = null;
  const client = await createWeaverClient({
    transport: {
      ...base,
      async listRegisteredSchemaIdentityPage(input) {
        if (failure === "stale")
          throw createWeaverError("REVISION_CONFLICT", "stale");
        if (failure === "auth")
          throw createWeaverError("UNAUTHORIZED", "denied");
        return pages.page(input);
      },
    },
  });
  const browser = new SchemaBrowserController(client, () => {});
  browser.open();
  await tick();
  assert.equal(browser.state.page?.anchors.length, 50);
  browser.next();
  await tick();
  assert.equal(browser.state.history.length, 1);
  assert.equal(browser.state.page?.anchors.length, 50);
  browser.back();
  await tick();
  assert.equal(browser.state.page?.anchors[0]?.path, "/app/000");
  failure = "stale";
  browser.next();
  await tick();
  assert.equal(browser.state.error, "stale");
  assert.equal(browser.state.page, undefined);
  browser.setFragments(true);
  assert.equal(browser.state.error, "stale");
  failure = null;
  browser.restart();
  await tick();
  assert.equal(browser.state.page?.anchors.length, 50);
  failure = "auth";
  browser.next();
  await tick();
  assert.equal(browser.state.error, "retry");
  assert.match(browser.state.status, /401/);
  await client.close();
});

test("ordinal cursor retains canonical limit and rejects stale and malformed offsets", () => {
  const anchors = Array.from({ length: 205 }, (_, i) => ({
    kind: "service" as const,
    path: `/service/${String(i).padStart(3, "0")}`,
    environment: "default",
  }));
  const pages = createSeededSchemaPages({ anchors, slots: [] });
  const first = pages.page();
  assert.equal(first.anchors.length, 50);
  assert.equal(first.nextCursor?.length, 55);
  assert.equal(
    pages.page({ cursor: first.nextCursor ?? "" }).anchors.length,
    50,
  );
  assert.equal(pages.page({ limit: 200 }).anchors.length, 200);
  assert.throws(() => pages.page({ limit: 201 }), /limit/);
  assert.throws(
    () => pages.page({ cursor: first.nextCursor ?? "", limit: 5 }),
    /limit/,
  );
  assert.throws(
    () => pages.page({ cursor: `${first.nextCursor}a` }),
    /request/,
  );
  const other = createSeededSchemaPages({ anchors, slots: [] });
  assert.throws(() => other.page({ cursor: first.nextCursor ?? "" }), /stale/);
  pages.publish({ anchors: [], slots: [] });
  assert.throws(() => pages.page({ cursor: first.nextCursor ?? "" }), /stale/);
});

test("auth, unsupported, not found, malformed and network remain contextual", () => {
  for (const [failure, expected] of [
    [createWeaverError("UNAUTHORIZED", "denied"), /401/],
    [createWeaverError("FORBIDDEN", "denied"), /403/],
    [createWeaverError("NOT_FOUND", "missing"), /404/],
    [createWeaverError("UNSUPPORTED_OPERATION", "missing"), /unsupported/],
    [new Error("ZodError: validation"), /Malformed/],
    [new Error("network offline"), /network/],
  ] as const) {
    assert.match(schemaBrowseError(failure), expected);
    assert.doesNotMatch(schemaBrowseError(failure), /Restart/);
  }
});

test("Back history remains bounded after more than ten pages", async () => {
  const base = createDemoTransport();
  const anchors = Array.from({ length: 602 }, (_, i) => ({
    kind: "service" as const,
    path: `/service/${String(i).padStart(3, "0")}`,
    environment: "default",
  }));
  const pages = createSeededSchemaPages({ anchors, slots: [] });
  const client = await createWeaverClient({
    transport: {
      ...base,
      async listRegisteredSchemaIdentityPage(input) {
        return pages.page(input);
      },
    },
  });
  const browser = new SchemaBrowserController(client, () => {});
  browser.open();
  await tick();
  for (let i = 0; i < 11; i++) {
    browser.next();
    await tick();
    assert.equal(browser.state.page?.anchors.length, 50);
  }
  assert.equal(browser.state.history.length, 10);
  assert.equal(browser.state.historyTruncated, true);
  browser.back();
  await tick();
  assert.equal(browser.state.page?.anchors[0]?.path, "/service/500");
  await client.close();
});
