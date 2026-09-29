import type { WeaverConfig } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";
import { buildScopePath, findLocation, type LocationDef } from "../locations";
import {
  getSelectedKey,
  getSelectedLocation,
  onSelectedKeyChange,
  onSelectedLocationChange,
} from "../state";
import { renderInspectorValue } from "./inspector-view";
import { renderSchemaBrowser } from "./schema-browser";

function showPlaceholder(root: HTMLElement): void {
  const placeholder = document.createElement("p");
  placeholder.className = "placeholder";
  placeholder.textContent = "Select a key to inspect";
  root.replaceChildren(placeholder);
}

function restoreFocus(
  root: HTMLElement,
  inspector: HTMLElement,
  key: string | null,
): void {
  if (!root.contains(document.activeElement)) return;
  if (key !== null) root.querySelector("button")?.focus();
  else {
    inspector.tabIndex = -1;
    inspector.focus();
  }
}

class InspectorPresenter {
  private generation = 0;
  private previousKey = getSelectedKey();
  private cleanup: (() => void) | undefined;
  private readonly browser;

  constructor(
    private readonly container: HTMLElement,
    private readonly valueRoot: HTMLElement,
    private readonly schemaRoot: HTMLElement,
    private readonly client: WeaverClient,
    private readonly config?: WeaverConfig,
  ) {
    this.browser = renderSchemaBrowser(schemaRoot, client);
  }

  render = (): void => {
    const request = ++this.generation;
    const key = getSelectedKey();
    if (key !== this.previousKey) {
      restoreFocus(this.schemaRoot, this.container, key);
      this.browser.reset();
      this.previousKey = key;
      this.cleanup?.();
      this.cleanup =
        key === null ? undefined : this.client.onChange(key, this.render);
    }
    this.schemaRoot.hidden = key === null;
    if (key === null) {
      showPlaceholder(this.valueRoot);
      return;
    }
    const code = getSelectedLocation();
    const loc = code ? (findLocation(code) ?? null) : null;
    const value = loc
      ? this.client.getForScope(key, buildScopePath(loc))
      : this.client.get(key);
    const names = this.config
      ? [...this.config.layerNames]
      : ["core", "app", "tenant", "user", "session"];
    renderInspectorValue(this.valueRoot, { key, value, location: loc });
    this.inspect(key, value, loc, names, request);
  };

  private inspect(
    key: string,
    value: unknown,
    loc: LocationDef | null,
    names: string[],
    request: number,
  ): void {
    this.client
      .inspect(key)
      .then((inspection) => {
        if (request !== this.generation) return;
        renderInspectorValue(this.valueRoot, {
          key,
          value,
          location: loc,
          effectiveLayer: loc ? undefined : inspection.effectiveLayer,
          layerNames: names,
          layerValues: inspection.layerValues ?? {},
        });
      })
      .catch(() => {
        if (request === this.generation)
          renderInspectorValue(this.valueRoot, { key, value, location: loc });
      });
  }
}

export function renderInspector(
  container: HTMLElement,
  client: WeaverClient,
  config?: WeaverConfig,
): void {
  const heading = document.createElement("h2");
  heading.textContent = "Key Inspector";
  const valueRoot = document.createElement("div");
  valueRoot.className = "inspector-body";
  const schemaRoot = document.createElement("div");
  schemaRoot.className = "inspector-schema";
  container.replaceChildren(heading, valueRoot, schemaRoot);
  const presenter = new InspectorPresenter(
    container,
    valueRoot,
    schemaRoot,
    client,
    config,
  );
  presenter.render();
  onSelectedKeyChange(presenter.render);
  onSelectedLocationChange(presenter.render);
}
