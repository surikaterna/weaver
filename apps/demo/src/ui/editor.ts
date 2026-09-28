import { evaluateChangePolicy } from "@weaver-conf/config-policy";
import type { OverrideSessionController } from "@weaver-conf/config-sessions";
import type { WeaverConfig } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";
import { COUNTRY_CODES_WITH_PROVIDERS, findLocation } from "../locations";
import { getFullSchemaForKey, getSchemaForKey } from "../schemas";
import {
  addLogEntry,
  getSelectedKey,
  getSelectedLocation,
  isSessionActive,
  onSelectedKeyChange,
  onSelectedLocationChange,
  onSessionActiveChange,
} from "../state";

const BASE_WRITABLE_LAYERS = ["tenant", "user", "session"] as const;

function requireQuery(container: HTMLElement, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function getWritableLayers(): string[] {
  const locationCode = getSelectedLocation();
  if (!locationCode) return [...BASE_WRITABLE_LAYERS];
  const loc = findLocation(locationCode);
  const layers = ["tenant"];
  if (loc && COUNTRY_CODES_WITH_PROVIDERS.has(loc.countryCode)) {
    layers.push(`country:${loc.countryCode}`);
  }
  layers.push(`location:${locationCode}`);
  layers.push("user", "session");
  return layers;
}

export function renderEditor(
  container: HTMLElement,
  client: WeaverClient,
  session: OverrideSessionController,
  weaverConfig: WeaverConfig,
): void {
  container.innerHTML = `<h2>Value Editor</h2><div class="editor-body"></div>`;
  const body = requireQuery(container, ".editor-body");

  function render(): void {
    const key = getSelectedKey();
    if (key === null) {
      body.innerHTML = `<p class="placeholder">Select a key to edit</p>`;
      return;
    }

    const currentValue = client.get(key);
    const schema = getSchemaForKey(key);
    let html = `<h3>${key}</h3>`;

    for (const layer of getWritableLayers()) {
      html += buildLayerSection(layer, key, currentValue, schema, weaverConfig);
    }

    html += `<div class="policy-feedback" id="policy-feedback"></div>`;
    body.innerHTML = html;
    bindEvents(body, key, client, session, weaverConfig);
  }

  render();
  onSelectedKeyChange(() => render());
  onSessionActiveChange(() => render());
  onSelectedLocationChange(() => render());

  let cleanupOnChange: (() => void) | null = null;
  onSelectedKeyChange((key) => {
    cleanupOnChange?.();
    if (key !== null) {
      cleanupOnChange = client.onChange(key, () => render());
    }
  });
}

function buildLayerSection(
  layer: string,
  _key: string,
  currentValue: unknown,
  schema: ReturnType<typeof getSchemaForKey>,
  weaverConfig: WeaverConfig,
): string {
  const blocked = isCeilingBlocked(layer, schema, weaverConfig);

  const cls = blocked ? "editor-layer ceiling-blocked" : "editor-layer";
  let html = `<div class="${cls}" data-layer="${layer}">`;
  html += `<label>${layer}</label>`;

  if (blocked) {
    const ceiling = schema?.maxOverrideLayer ?? "?";
    html += `<div class="ceiling-msg">🔒 Ceiling: max override at <strong>${ceiling}</strong></div>`;
  } else {
    html += `<div class="editor-controls">`;
    html += buildInput(layer, currentValue);
    html += `<button class="btn-set" data-layer="${layer}">Set</button>`;
    html += `<button class="btn-remove" data-layer="${layer}">Remove</button>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function isCeilingBlocked(
  layer: string,
  schema: ReturnType<typeof getSchemaForKey>,
  weaverConfig: WeaverConfig,
): boolean {
  if (!schema?.maxOverrideLayer) return false;
  if (layer === "session" && isSessionActive()) return false;
  const SCOPE_LAYER_RANK = 2.5;
  const isScopeLayer =
    layer.startsWith("location:") || layer.startsWith("country:");
  const layerRank = isScopeLayer
    ? SCOPE_LAYER_RANK
    : weaverConfig.getRank(layer);
  const ceilingRank = weaverConfig.getRank(schema.maxOverrideLayer);
  if (layerRank < 0 || ceilingRank < 0) return false;
  return layerRank > ceilingRank;
}

function buildInput(layer: string, currentValue: unknown): string {
  const attr = `data-input-layer="${layer}"`;

  if (typeof currentValue === "boolean") {
    return `<select ${attr}><option value="true">true</option><option value="false">false</option></select>`;
  }
  if (typeof currentValue === "number") {
    return `<input ${attr} type="number" placeholder="${currentValue}" />`;
  }
  return `<input ${attr} type="text" placeholder="${currentValue ?? ""}" />`;
}

function parseInput(
  el: HTMLInputElement | HTMLSelectElement,
  currentValue: unknown,
): unknown {
  const raw = el.value;
  if (raw === "") return currentValue;
  if (typeof currentValue === "boolean") return raw === "true";
  if (typeof currentValue === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

function showFeedback(
  body: Element,
  message: string,
  level: "warning" | "error",
): void {
  const el = body.querySelector("#policy-feedback");
  if (!el) return;
  el.className = `policy-feedback ${level}`;
  el.textContent = message;
}

function clearFeedback(body: Element): void {
  const el = body.querySelector("#policy-feedback");
  if (!el) return;
  el.className = "policy-feedback";
  el.textContent = "";
}

async function handleSet(
  body: Element,
  key: string,
  layer: string,
  client: WeaverClient,
  session: OverrideSessionController,
): Promise<void> {
  const input = body.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-input-layer="${layer}"]`,
  );
  if (!input) return;

  const schema = getFullSchemaForKey(key);
  const value = parseInput(input, client.get(key));

  if (schema) {
    const ctx = {
      userId: "demo-user",
      roles: ["admin"] as readonly string[],
      sessionMode: isSessionActive()
        ? ("emergency-override" as const)
        : undefined,
      overrideReason: session.getSession()?.reason,
    };
    const decision = evaluateChangePolicy(schema, ctx, layer, () => true);

    if (decision.outcome === "requires-promotion") {
      showFeedback(body, decision.message, "warning");
      return;
    }
    if (decision.outcome === "requires-emergency-auth") {
      showFeedback(body, "Activate an override session first", "error");
      return;
    }
    if (decision.outcome === "denied") {
      showFeedback(body, decision.reason, "error");
      return;
    }
  }

  clearFeedback(body);
  const result = await client.set(key, value, { layer });
  if (!result.success) {
    showFeedback(body, result.error?.message ?? "Set failed", "error");
    return;
  }
  addLogEntry(`Set ${key} = ${JSON.stringify(value)} at [${layer}]`);
}

function bindEvents(
  body: Element,
  key: string,
  client: WeaverClient,
  session: OverrideSessionController,
  _weaverConfig: WeaverConfig,
): void {
  for (const btn of body.querySelectorAll<HTMLButtonElement>(".btn-set")) {
    btn.addEventListener("click", () => {
      const layer = btn.dataset.layer;
      if (layer === undefined) return;
      void handleSet(body, key, layer, client, session);
    });
  }

  for (const btn of body.querySelectorAll<HTMLButtonElement>(".btn-remove")) {
    btn.addEventListener("click", async () => {
      const layer = btn.dataset.layer;
      if (layer === undefined) return;
      clearFeedback(body);
      const result = await client.remove(key, { layer });
      if (!result.success) {
        showFeedback(body, result.error?.message ?? "Remove failed", "error");
        return;
      }
      addLogEntry(`Removed ${key} from [${layer}]`);
    });
  }
}
