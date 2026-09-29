import assert from "node:assert/strict";
import { test } from "node:test";
import { renderInspectorValue } from "../src/ui/inspector-view";

class ElementStub {
  children: ElementStub[] = [];
  textContent = "";
  className = "";
  style = { background: "", color: "" };
  constructor(readonly tag: string) {}
  append(...children: ElementStub[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: ElementStub[]) {
    this.children = children;
    this.textContent = "";
  }
  query(tag: string): ElementStub[] {
    return [
      ...(this.tag === tag ? [this] : []),
      ...this.children.flatMap((child) => child.query(tag)),
    ];
  }
}

test("inspector renders arbitrary key, value and layer as inert text while keeping policy", () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new ElementStub(tag) },
  });
  try {
    const root = new ElementStub("section");
    const hostile = '<img src=x onerror="alert(1)">';
    renderInspectorValue(root as unknown as HTMLElement, {
      key: hostile,
      value: hostile,
      effectiveLayer: hostile,
      layerNames: [hostile],
      layerValues: { [hostile]: hostile },
    });
    assert.equal(root.query("img").length, 0);
    assert.equal(root.query("h3")[0]?.textContent, hostile);
    assert.match(root.query("strong")[0]?.textContent ?? "", /onerror/);
    assert.equal(root.query("em")[0]?.textContent, hostile);
    assert.equal(
      root.query("span").some((item) => item.textContent === hostile),
      true,
    );
    renderInspectorValue(root as unknown as HTMLElement, {
      key: "app.ui.theme",
      value: "dark",
    });
    assert.match(
      root.query("h4")[0]?.textContent ?? "",
      /Local demo property policy/,
    );
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
