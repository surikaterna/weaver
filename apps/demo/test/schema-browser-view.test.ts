import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeaverError } from "@weaver-conf/config-types";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "../src/demo-transport";
import { renderSchemaBrowser } from "../src/ui/schema-browser";

class ElementStub {
  children: ElementStub[] = [];
  textContent = "";
  value = "";
  selectedIndex = 0;
  hidden = false;
  disabled = false;
  checked = false;
  type = "";
  id = "";
  private listeners = new Map<string, () => void>();
  constructor(
    readonly tag: string,
    private readonly doc: { activeElement: ElementStub | null },
  ) {}
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
  contains(node: ElementStub | null): boolean {
    return (
      node !== null &&
      (this === node || this.children.some((child) => child.contains(node)))
    );
  }
  focus() {
    this.doc.activeElement = this;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("detail 409 shows only Restart and clears the rendered identity; auth retains page for Retry", async () => {
  const original = globalThis.document;
  const doc = {
    activeElement: null as ElementStub | null,
    createElement(tag: string) {
      return new ElementStub(tag, doc);
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: doc,
  });
  const base = createDemoTransport();
  let pages = 0;
  let details = 0;
  const client = await createWeaverClient({
    transport: {
      ...base,
      async listRegisteredSchemaIdentityPage(input) {
        pages++;
        return base.listRegisteredSchemaIdentityPage(input);
      },
      async getRegisteredSchema(path, environment) {
        details++;
        if (details === 1)
          throw createWeaverError("REVISION_CONFLICT", "stale");
        if (details === 2) throw createWeaverError("UNAUTHORIZED", "denied");
        if (details === 3) throw new Error("network offline");
        if (details === 4) throw new Error("ZodError: validation failed");
        return base.getRegisteredSchema(path, environment);
      },
    },
  });
  try {
    const root = doc.createElement("section");
    const browser = renderSchemaBrowser(root as unknown as HTMLElement, client);
    const [button, content] = root.children;
    assert.ok(button && content);
    const selector = content.children[3]?.children[0];
    const next = content.children[5];
    const restart = content.children[6];
    const retry = content.children[7];
    const status = content.children[9];
    const code = content.children[10]?.children[0];
    assert.ok(selector && next && restart && retry && status && code);
    assert.equal(pages, 0);
    button.dispatch("click");
    await tick();
    assert.equal(selector.children.length, 2);
    selector.selectedIndex = 1;
    selector.focus();
    selector.dispatch("change");
    await tick();
    assert.equal(browser.state.error, "stale");
    assert.equal(selector.children.length, 1);
    assert.equal(selector.selectedIndex, 0);
    assert.equal(code.textContent, "");
    assert.match(status.textContent, /Restart/);
    assert.equal(restart.hidden, false);
    assert.equal(retry.hidden, true);
    assert.equal(next.hidden, true);
    assert.equal(doc.activeElement, restart);
    restart.dispatch("click");
    await tick();
    assert.equal(pages, 2);
    assert.equal(selector.children.length, 2);
    assert.equal(doc.activeElement, button);
    selector.selectedIndex = 1;
    selector.dispatch("change");
    await tick();
    assert.equal(browser.state.error, "retry");
    assert.equal(selector.children.length, 2);
    assert.match(status.textContent, /401/);
    assert.equal(restart.hidden, true);
    assert.equal(retry.hidden, false);
    for (const expected of [/network/, /Malformed/]) {
      retry.dispatch("click");
      await tick();
      assert.equal(browser.state.error, "retry");
      assert.equal(selector.children.length, 2);
      assert.match(status.textContent, expected);
      assert.equal(restart.hidden, true);
      assert.equal(retry.hidden, false);
    }
    retry.dispatch("click");
    await tick();
    assert.equal(browser.state.detail?.path, "/app");
    assert.equal(details, 5);
  } finally {
    await client.close();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
