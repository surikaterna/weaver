import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeaverError } from "@weaver-conf/config-types";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "../src/demo-transport";
import { SCHEMA_FIXTURES } from "../src/registered-schema-fixtures";
import { createSeededSchemaPages } from "../src/seeded-schema-pages";
import { renderSchemaBrowser } from "../src/ui/schema-browser";

class ElementStub {
  children: ElementStub[] = [];
  textContent = "";
  value = "";
  type = "";
  checked = false;
  disabled = false;
  selectedIndex = 0;
  listeners = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  append(...children: (ElementStub | string)[]) {
    this.children.push(
      ...children.filter(
        (child): child is ElementStub => child instanceof ElementStub,
      ),
    );
  }
  replaceChildren(...children: ElementStub[]) {
    this.children = children;
  }
  setAttribute() {}
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  dispatch(name: string) {
    this.listeners.get(name)?.();
  }
  get options() {
    return this.children;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the two meaningful offline anchors and two declared slots retain exact cloned detail", async () => {
  const transport = createDemoTransport();
  const page = await transport.listRegisteredSchemaIdentityPage();
  assert.deepEqual(
    page.anchors.map(({ path }) => path),
    SCHEMA_FIXTURES.map(({ anchor }) => anchor),
  );
  assert.deepEqual(
    page.slots.map(({ path }) => path),
    ["/app/extensions", "/app/plugins"],
  );
  for (const fixture of SCHEMA_FIXTURES) {
    const detail = await transport.getRegisteredSchema(
      fixture.anchor,
      fixture.environment,
    );
    assert.deepEqual(detail.schema, fixture.schema);
    detail.schema.description = "mutated";
    assert.deepEqual(
      (await transport.getRegisteredSchema(fixture.anchor, fixture.environment))
        .schema,
      fixture.schema,
    );
  }
  await assert.rejects(
    transport.getRegisteredSchema("/app/extensions", "default"),
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

test("offline ordinal pages default to 50, cap at 200, reject noncanonical/stale cursors", async () => {
  const base = createDemoTransport();
  const first = await base.listRegisteredSchemaIdentityPage();
  assert.equal(first.anchors.length, 2);
  assert.equal(first.slots.length, 2);
  assert.equal(first.nextCursor, null);
  const anchors = Array.from({ length: 205 }, (_, i) => ({
    kind: i % 2 ? ("fragment" as const) : ("service" as const),
    path: `/service/${String(i).padStart(3, "0")}`,
    environment: i % 3 ? "default" : "staging",
  }));
  const pages = createSeededSchemaPages({
    anchors,
    slots: [
      {
        kind: "slot",
        path: "/service/001",
        environment: "default",
        accepts: "object",
      },
    ],
  });
  const one = pages.page();
  assert.equal(one.anchors.length + one.slots.length, 50);
  assert.equal(one.nextCursor?.length, 55);
  const two = pages.page({ cursor: one.nextCursor ?? "" });
  assert.equal(two.anchors.length + two.slots.length, 50);
  assert.notDeepEqual(one.anchors, two.anchors);
  const large = pages.page({ limit: 200 });
  assert.equal(large.anchors.length + large.slots.length, 200);
  assert.throws(() => pages.page({ limit: 201 }), /limit/);
  assert.throws(() => pages.page({ cursor: `${one.nextCursor}a` }), /request/);
  assert.throws(
    () => pages.page({ cursor: one.nextCursor ?? "", limit: 5 }),
    /limit/,
  );
  const bytes = Buffer.from(one.nextCursor ?? "", "base64url");
  bytes.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 33);
  assert.throws(
    () => pages.page({ cursor: bytes.toString("base64url") }),
    /cursor/,
  );
  for (const [position, value, pattern] of [
    [0, 2, /cursor/],
    [17, 42, /stale/],
    [25, 0, /limit/],
    [33, 0, /offset/],
    [33, 206, /offset/],
  ] as const) {
    const changed = Buffer.from(one.nextCursor ?? "", "base64url");
    if (position === 0) changed[0] = value;
    else changed.writeBigUInt64BE(BigInt(value), position);
    assert.throws(
      () => pages.page({ cursor: changed.toString("base64url") }),
      pattern,
    );
  }
  const other = createSeededSchemaPages({ anchors, slots: [] });
  assert.throws(() => other.page({ cursor: one.nextCursor ?? "" }), /stale/);
  pages.publish({ anchors: [], slots: [] });
  assert.throws(() => pages.page({ cursor: one.nextCursor ?? "" }), /stale/);
  assert.deepEqual(pages.page(), {
    anchors: [],
    slots: [],
    nextCursor: null,
    hasMore: false,
  });
});

test("browser requests only current page, replaces options, ignores stale page/detail and restarts", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new ElementStub(tag) },
  });
  try {
    const base = createDemoTransport();
    const anchors = Array.from({ length: 52 }, (_, i) => ({
      kind: "service" as const,
      path: `/service/${String(i).padStart(3, "0")}`,
      environment: "default",
    }));
    anchors[0] = { kind: "service", path: "/app", environment: "default" };
    const pages = createSeededSchemaPages({
      anchors,
      slots: [
        {
          kind: "slot",
          path: "/z/slot",
          environment: "default",
          accepts: "object",
        },
      ],
    });
    const slow =
      deferred<Awaited<ReturnType<typeof base.getRegisteredSchema>>>();
    const calls = { page: 0, detail: 0, bulk: 0, legacy: 0 };
    const client = await createWeaverClient({
      transport: {
        ...base,
        async listRegisteredSchemaIdentityPage(input) {
          calls.page++;
          return pages.page(input);
        },
        async getRegisteredSchema(path, env) {
          calls.detail++;
          return calls.detail === 1
            ? slow.promise
            : base.getRegisteredSchema(path, env);
        },
        async fetchSchemas() {
          calls.bulk++;
          return base.fetchSchemas();
        },
        async listRegisteredSchemaIdentities() {
          calls.legacy++;
          return base.listRegisteredSchemaIdentities();
        },
      },
    });
    const container = new ElementStub("section");
    renderSchemaBrowser(container as unknown as HTMLElement, client);
    await tick();
    const [, , label, select, next, restart, identity, status, pre] =
      container.children;
    assert.ok(label && select && next && restart && identity && status && pre);
    const toggle = label.children[0];
    const code = pre.children[0];
    assert.ok(toggle && code);
    assert.deepEqual(calls, { page: 1, detail: 0, bulk: 0, legacy: 0 });
    assert.equal(select.options.length, 51);
    select.selectedIndex = 1;
    select.dispatch("change");
    assert.equal(calls.detail, 1);
    next.dispatch("click");
    await tick();
    assert.equal(select.options.length, 3);
    slow.resolve(await base.getRegisteredSchema("/app", "default"));
    await tick();
    assert.equal(code.textContent, "");
    toggle.checked = true;
    toggle.dispatch("change");
    assert.equal(select.options.length, 4);
    select.selectedIndex = 3;
    select.dispatch("change");
    assert.match(status.textContent, /another page/);
    assert.doesNotMatch(status.textContent, /empty/);
    pages.publish({ anchors, slots: [] });
    restart.dispatch("click");
    await tick();
    pages.publish({ anchors: [], slots: [] });
    next.dispatch("click");
    await tick();
    assert.equal(select.options.length, 0);
    assert.equal(code.textContent, "");
    assert.match(status.textContent, /409|stale/);
    restart.dispatch("click");
    await tick();
    assert.match(status.textContent, /empty/);
    assert.deepEqual(
      { bulk: calls.bulk, legacy: calls.legacy },
      { bulk: 0, legacy: 0 },
    );
    await client.close();
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});

test("page errors are distinct, clear previous detail and offer restart; late page cannot overwrite restart", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new ElementStub(tag) },
  });
  try {
    for (const [failure, expected] of [
      [createWeaverError("UNAUTHORIZED", "denied"), /401/],
      [createWeaverError("UNSUPPORTED_OPERATION", "missing"), /unsupported/],
      [new Error("network offline"), /network/],
    ] as const) {
      const base = createDemoTransport();
      const client = await createWeaverClient({
        transport: {
          ...base,
          async listRegisteredSchemaIdentityPage() {
            throw failure;
          },
        },
      });
      const container = new ElementStub("section");
      renderSchemaBrowser(container as unknown as HTMLElement, client);
      await tick();
      assert.match(container.children[7]?.textContent ?? "", expected);
      assert.equal(container.children[3]?.options.length, 0);
      await client.close();
    }
    const base = createDemoTransport();
    const slow =
      deferred<
        Awaited<ReturnType<typeof base.listRegisteredSchemaIdentityPage>>
      >();
    let calls = 0;
    const client = await createWeaverClient({
      transport: {
        ...base,
        async listRegisteredSchemaIdentityPage(input) {
          calls++;
          if (calls === 1) return slow.promise;
          if (calls === 3)
            return {
              anchors: [],
              slots: [],
              nextCursor: null,
              hasMore: false,
              extra: true,
            };
          return base.listRegisteredSchemaIdentityPage(input);
        },
      },
    });
    const container = new ElementStub("section");
    renderSchemaBrowser(container as unknown as HTMLElement, client);
    container.children[5]?.dispatch("click");
    await tick();
    slow.resolve({ anchors: [], slots: [], nextCursor: null, hasMore: false });
    await tick();
    assert.equal(container.children[3]?.options.length, 2);
    container.children[5]?.dispatch("click");
    await tick();
    assert.match(container.children[7]?.textContent ?? "", /Malformed/);
    assert.equal(container.children[3]?.options.length, 0);
    await client.close();
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});

test("schema detail uses inert textContent, exact identity, and no eager bulk", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new ElementStub(tag) },
  });
  try {
    const base = createDemoTransport();
    let details = 0;
    const client = await createWeaverClient({
      transport: {
        ...base,
        async getRegisteredSchema(path, environment) {
          details++;
          const detail = await base.getRegisteredSchema(path, environment);
          if (details === 2) return { ...detail, environment: "staging" };
          detail.schema.description = "<script>window.injected=true</script>";
          return detail;
        },
      },
    });
    const container = new ElementStub("section");
    renderSchemaBrowser(container as unknown as HTMLElement, client);
    await tick();
    assert.equal(details, 0);
    const select = container.children[3];
    const code = container.children[8]?.children[0];
    assert.ok(select && code);
    select.selectedIndex = 1;
    select.dispatch("change");
    await tick();
    assert.match(code.textContent, /<script>/);
    assert.equal(code.children.length, 0);
    select.dispatch("change");
    await tick();
    assert.equal(code.textContent, "");
    assert.match(container.children[7]?.textContent ?? "", /Malformed/);
    assert.equal(details, 2);
    await client.close();
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
