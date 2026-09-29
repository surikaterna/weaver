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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function assertInspector(
  root: ElementStub,
  value: string,
  label: string,
  winner: string | null,
): void {
  assert.equal(root.query("strong")[0]?.textContent, JSON.stringify(value));
  assert.equal(root.query("em")[0]?.textContent, label);
  const winners = root
    .query("div")
    .filter((item) => item.className.includes("winner"));
  assert.equal(winners.length, winner === null ? 0 : 1);
  if (winner) assert.equal(winners[0]?.query("span")[0]?.textContent, winner);
}

test("unscoped winner and scoped source remain truthful through locations and late inspect results", async () => {
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
    const baseInspection: Inspection = {
      effectiveLayer: "app",
      layerValues: { core: "light", app: "system", user: undefined },
    };
    let pages = 0;
    const scoped: Record<string, string> = {
      GBDVR: "dark",
      FRCQF: "light",
      NLEUR: "system",
    };
    const client = {
      get: () => "system",
      getForScope(_key: string, path: { value: string }[]) {
        return scoped[path.at(-1)?.value ?? ""] ?? "system";
      },
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
    pending[0]?.resolve(baseInspection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertInspector(root, "system", "app", "app");
    const schemaRoot = root
      .query("div")
      .find((item) => item.className === "inspector-schema");
    for (const [code, label, value] of [
      ["GBDVR", "Dover", "dark"],
      ["FRCQF", "Calais", "light"],
      ["NLEUR", "Europoort", "system"],
    ]) {
      assert.ok(code && label && value);
      setSelectedLocation(code);
      pending.at(-1)?.resolve(baseInspection);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertInspector(root, value, "scoped value (source unspecified)", null);
      assert.match(
        root.query("p")[0]?.textContent ?? "",
        new RegExp(`Selected scope: ${label}`),
      );
      assert.equal(root.query("h4")[0]?.textContent, "Base layers (unscoped)");
      assert.deepEqual(
        root
          .query("span")
          .filter((item) => item.className === "layer-label")
          .map((item) => item.textContent),
        ["core", "app", "tenant", "user", "session"],
      );
      assert.deepEqual(
        root
          .query("span")
          .filter((item) => item.className === "layer-val")
          .map((item) => item.textContent),
        ['"light"', '"system"', "—", "—", "—"],
      );
      assert.equal(
        root.query("h4").at(-1)?.textContent,
        "Local demo property policy (not registered JSON Schema)",
      );
      assert.equal(
        root.query("div").find((item) => item.className === "inspector-schema"),
        schemaRoot,
      );
    }
    setSelectedLocation("GBDVR");
    const lateSuccess = pending.at(-1);
    setSelectedLocation("FRCQF");
    const lateFailure = pending.at(-1);
    setSelectedKey("app.ui.language");
    assert.equal(root.query("h3")[0]?.textContent, "app.ui.language");
    lateSuccess?.resolve(baseInspection);
    lateFailure?.reject(new Error("late inspect failure"));
    pending.at(-1)?.resolve(baseInspection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertInspector(root, "light", "scoped value (source unspecified)", null);
    setSelectedLocation(null);
    pending.at(-1)?.resolve(baseInspection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertInspector(root, "system", "app", "app");
    assert.equal(
      root
        .query("div")
        .some((item) => item.className === "inspector-schema" && !item.hidden),
      true,
    );
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
