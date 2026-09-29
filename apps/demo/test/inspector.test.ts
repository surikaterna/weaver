import assert from "node:assert/strict";
import { test } from "node:test";
import type { WeaverClient } from "@weaver-conf/weaver-client";
import { setSelectedKey, setSelectedLocation } from "../src/state";
import { renderInspector } from "../src/ui/inspector";

class ElementStub {
  children: ElementStub[] = [];
  textContent = "";
  className = "";
  hidden = false;
  style = { background: "", color: "" };
  private listeners = new Map<string, () => void>();
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
    this.textContent = "";
  }
  setAttribute() {}
  contains(node: ElementStub | null): boolean {
    return (
      node !== null &&
      (node === this || this.children.some((child) => child.contains(node)))
    );
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  query(tag: string): ElementStub[] {
    return [
      ...(this.tag === tag ? [this] : []),
      ...this.children.flatMap((child) => child.query(tag)),
    ];
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("late inspect of old key/location cannot replace current inspector or disclosure", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => new ElementStub(tag),
      activeElement: null,
    },
  });
  setSelectedKey(null);
  setSelectedLocation(null);
  try {
    type Inspection = Awaited<ReturnType<WeaverClient["inspect"]>>;
    const pending: ReturnType<typeof deferred<Inspection>>[] = [];
    let pages = 0;
    const client = {
      get: () => "system",
      getForScope: () => "dark",
      inspect() {
        const request = deferred<Inspection>();
        pending.push(request);
        return request.promise;
      },
      onChange: () => () => {},
      listRegisteredSchemaIdentityPage: () => {
        pages++;
        throw Error("unexpected page request");
      },
    } as unknown as WeaverClient;
    const root = new ElementStub("section");
    renderInspector(root as unknown as HTMLElement, client);
    assert.equal(root.query("strong").length, 0);
    setSelectedKey("app.ui.theme");
    setSelectedLocation("GBDVR");
    setSelectedKey("app.ui.language");
    assert.equal(root.query("h3")[0]?.textContent, "app.ui.language");
    assert.equal(root.query("strong")[0]?.textContent, '"dark"');
    assert.equal(
      root
        .query("div")
        .some((item) => item.className === "inspector-schema" && !item.hidden),
      true,
    );
    for (const request of pending)
      request.resolve({ effectiveLayer: "old", layerValues: { old: "stale" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.query("h3")[0]?.textContent, "app.ui.language");
    assert.equal(root.query("strong")[0]?.textContent, '"dark"');
    assert.equal(pages, 0);
  } finally {
    setSelectedKey(null);
    setSelectedLocation(null);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
