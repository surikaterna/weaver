import type { WeaverConfig } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";
import {
  buildScopePath,
  COUNTRY_CODES_WITH_PROVIDERS,
  findLocation,
  type LocationDef,
} from "../locations";
import {
  getSelectedKey,
  getSelectedLocation,
  onSelectedKeyChange,
  onSelectedLocationChange,
} from "../state";
import { renderInspectorValue } from "./inspector-view";
import { renderSchemaBrowser } from "./schema-browser";

function scopeLayers(loc: LocationDef | null): string[] {
  if (!loc) return [];
  return [
    ...(COUNTRY_CODES_WITH_PROVIDERS.has(loc.countryCode)
      ? [`country:${loc.countryCode}`]
      : []),
    `location:${loc.code}`,
  ];
}

function displayLayers(names: string[], scope: string[]): string[] {
  return names.flatMap((name) =>
    name === "tenant" ? [name, ...scope] : [name],
  );
}

function winningScopeLayer(
  scope: string[],
  values: Partial<Record<string, unknown>>,
): string | undefined {
  return [...scope].reverse().find((layer) => values[layer] !== undefined);
}

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
    const base = this.client.get(key);
    const value = loc
      ? this.client.getForScope(key, buildScopePath(loc))
      : base;
    const scope = scopeLayers(loc);
    const names = displayLayers(
      this.config
        ? [...this.config.layerNames]
        : ["core", "app", "tenant", "user", "session"],
      scope,
    );
    renderInspectorValue(this.valueRoot, { key, value });
    this.inspect(key, value, base, loc, scope, names, request);
  };

  private inspect(
    key: string,
    value: unknown,
    base: unknown,
    loc: LocationDef | null,
    scope: string[],
    names: string[],
    request: number,
  ): void {
    this.client
      .inspect(key)
      .then((inspection) => {
        if (request !== this.generation) return;
        const effectiveLayer =
          loc && value !== base
            ? (winningScopeLayer(scope, inspection.layerValues ?? {}) ??
              inspection.effectiveLayer)
            : inspection.effectiveLayer;
        renderInspectorValue(this.valueRoot, {
          key,
          value,
          effectiveLayer,
          layerNames: names,
          layerValues: inspection.layerValues ?? {},
        });
      })
      .catch(() => {
        if (request === this.generation)
          renderInspectorValue(this.valueRoot, { key, value });
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
