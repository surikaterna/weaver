import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registeredSchemaDetailResponseSchema,
  registeredSchemaIdentityListResponseSchema,
} from "@weaver-conf/config-types";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "../src/demo-transport";
import { SCHEMA_FIXTURES } from "../src/registered-schema-fixtures";
import {
  renderSchemaBrowser,
  schemaBrowseError,
} from "../src/ui/schema-browser";

test("offline identities carry no schemas, declared empty slot, and exact cloned detail", async () => {
  const transport = createDemoTransport();
  const calls = { list: 0, detail: [] as string[], bulk: 0 };
  const client = await createWeaverClient({
    transport: {
      ...transport,
      async listRegisteredSchemaIdentities() {
        calls.list++;
        return transport.listRegisteredSchemaIdentities();
      },
      async getRegisteredSchema(path, env) {
        calls.detail.push(`${path}:${env}`);
        return transport.getRegisteredSchema(path, env);
      },
      async fetchSchemas() {
        calls.bulk++;
        return transport.fetchSchemas();
      },
    },
  });
  assert.deepEqual(calls, { list: 0, detail: [], bulk: 0 });
  const list = registeredSchemaIdentityListResponseSchema.parse(
    await client.listRegisteredSchemaIdentities(),
  );
  assert.deepEqual(
    list.anchors,
    SCHEMA_FIXTURES.map(({ kind, anchor, environment }) => ({
      kind,
      path: anchor,
      environment,
    })),
  );
  assert.equal(list.slots.length, 2);
  assert.equal(list.slots[1]?.path, "/app/plugins/demo.empty");
  assert.ok(
    JSON.stringify(list).length <
      JSON.stringify(await transport.fetchSchemas()).length,
  );
  console.log(
    "OFFLINE_SCHEMA_BYTES",
    JSON.stringify({
      identities: Buffer.byteLength(JSON.stringify(list)),
      service: Buffer.byteLength(
        JSON.stringify(await transport.getRegisteredSchema("/app", "default")),
      ),
      fragment: Buffer.byteLength(
        JSON.stringify(
          await transport.getRegisteredSchema(
            "/app/plugins/demo.notifications",
            "default",
          ),
        ),
      ),
      legacyBulk: Buffer.byteLength(
        JSON.stringify(await transport.fetchSchemas()),
      ),
    }),
  );
  assert.doesNotMatch(JSON.stringify(list), /owner|properties|schemaVersion/);
  const first = list.anchors[0];
  assert.ok(first);
  Object.assign(first, { path: "/changed" });
  assert.equal(
    (await client.listRegisteredSchemaIdentities()).anchors[0]?.path,
    "/app",
  );
  for (const fixture of SCHEMA_FIXTURES) {
    const detail = registeredSchemaDetailResponseSchema.parse(
      await client.getRegisteredSchema(fixture.anchor, "default"),
    );
    assert.deepEqual(detail.schema, fixture.schema);
    assert.equal(detail.path, fixture.anchor);
    assert.equal(detail.metadata.owner.name, "Demo seed");
    detail.schema.description = "mutated";
    assert.deepEqual(
      (await client.getRegisteredSchema(fixture.anchor, "default")).schema,
      fixture.schema,
    );
  }
  for (const [path, env] of [
    ["/app", "production"],
    ["/app/plugins/demo.empty", "default"],
    ["/app/plugins/demo.notifications/child", "default"],
  ] as const) {
    await assert.rejects(
      client.getRegisteredSchema(path, env),
      /NOT_FOUND.*404/,
    );
  }
  assert.deepEqual(calls, {
    list: 2,
    detail: [
      "/app:default",
      "/app:default",
      "/app/plugins/demo.notifications:default",
      "/app/plugins/demo.notifications:default",
      "/app:production",
      "/app/plugins/demo.empty:default",
      "/app/plugins/demo.notifications/child:default",
    ],
    bulk: 0,
  });
  await client.close();
});

test("browse failures have explicit states", () => {
  for (const [message, expected] of [
    ["UNSUPPORTED_OPERATION", /unsupported/],
    ["NOT_FOUND 404", /404/],
    ["HTTP 401", /401/],
    ["HTTP 403", /403/],
    ["network offline", /network/],
    ["invalid_type", /Malformed/],
  ] as const)
    assert.match(schemaBrowseError(new Error(message)), expected);
});

test("empty list and rejected list remain schema-free", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new ElementStub(tag) },
  });
  try {
    const local = createDemoTransport();
    for (const [list, expected] of [
      [async () => ({ anchors: [], slots: [] }), /empty/],
      [
        async () => {
          throw new Error("UNSUPPORTED_OPERATION");
        },
        /unsupported/,
      ],
      [
        async () => {
          throw new Error("HTTP 401");
        },
        /401/,
      ],
      [
        async () => {
          throw new Error("network offline");
        },
        /network/,
      ],
      [
        async () => ({ anchors: [{ schema: { type: "object" } }], slots: [] }),
        /Malformed/,
      ],
    ] as const) {
      let detailCalls = 0;
      const client = await createWeaverClient({
        transport: {
          ...local,
          listRegisteredSchemaIdentities: list,
          async getRegisteredSchema(path, env) {
            detailCalls++;
            return local.getRegisteredSchema(path, env);
          },
        },
      });
      const container = new ElementStub("section");
      renderSchemaBrowser(container as unknown as HTMLElement, client);
      await tick();
      const status = container.children[5];
      const code = container.children[6]?.children[0];
      assert.ok(status && code);
      assert.match(status.textContent, expected);
      assert.equal(code.textContent, "");
      assert.equal(detailCalls, 0);
      await client.close();
    }
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});

class ElementStub {
  children: ElementStub[] = [];
  textContent = "";
  value = "";
  type = "";
  checked = false;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("UI list-first, exact detail selection, slot, out-of-order and inert JSON", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new ElementStub(tag) },
  });
  try {
    const base = createDemoTransport();
    const slow =
      deferred<Awaited<ReturnType<typeof base.getRegisteredSchema>>>();
    const calls = { list: 0, detail: [] as string[], bulk: 0 };
    const client = await createWeaverClient({
      transport: {
        ...base,
        async listRegisteredSchemaIdentities() {
          calls.list++;
          return base.listRegisteredSchemaIdentities();
        },
        async getRegisteredSchema(path, env) {
          calls.detail.push(`${path}:${env}`);
          if (calls.detail.length === 1) return slow.promise;
          if (calls.detail.length === 3) throw new Error("HTTP 403");
          const detail = await base.getRegisteredSchema(path, env);
          if (path === "/app/plugins/demo.notifications")
            detail.schema.description = "<script>window.injected=true</script>";
          return detail;
        },
        async fetchSchemas() {
          calls.bulk++;
          return base.fetchSchemas();
        },
      },
    });
    const container = new ElementStub("section");
    renderSchemaBrowser(container as unknown as HTMLElement, client);
    await tick();
    const [, , label, select, identity, status, pre] = container.children;
    assert.ok(label && select && identity && status && pre);
    const toggle = label.children[0];
    const code = pre.children[0];
    assert.ok(toggle && code);
    assert.deepEqual(calls, { list: 1, detail: [], bulk: 0 });
    assert.equal(select.options.length, 2);
    select.selectedIndex = 1;
    select.dispatch("change");
    assert.equal(code.textContent, "");
    toggle.checked = true;
    toggle.dispatch("change");
    assert.equal(select.options.length, 5);
    select.selectedIndex = 2;
    select.dispatch("change");
    await tick();
    assert.equal(
      JSON.parse(code.textContent).description,
      "<script>window.injected=true</script>",
    );
    assert.equal(code.children.length, 0);
    slow.resolve(await base.getRegisteredSchema("/app", "default"));
    await tick();
    assert.equal(
      JSON.parse(code.textContent).description,
      "<script>window.injected=true</script>",
    );
    select.selectedIndex = 3;
    select.dispatch("change");
    assert.match(status.textContent, /registered fragment/);
    assert.equal(code.textContent, "");
    select.selectedIndex = 4;
    select.dispatch("change");
    assert.match(identity.textContent, /demo.empty/);
    assert.match(status.textContent, /empty/);
    assert.equal(code.textContent, "");
    select.selectedIndex = 1;
    select.dispatch("change");
    await tick();
    assert.match(status.textContent, /403/);
    assert.equal(code.textContent, "");
    assert.deepEqual(calls, {
      list: 1,
      detail: [
        "/app:default",
        "/app/plugins/demo.notifications:default",
        "/app:default",
      ],
      bulk: 0,
    });
    await client.close();
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
