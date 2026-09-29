import { getSchemaForKey } from "../schemas";

const VISIBILITY_COLORS: Record<string, string> = {
  public: "#6bcb77",
  admin: "#e8a838",
  platform: "#5b9bd5",
  internal: "#e74c3c",
};
const POLICY_COLORS: Record<string, string> = {
  "direct-allowed": "#6bcb77",
  "staging-gate": "#e8d838",
  "full-pipeline": "#e8a838",
  "emergency-override": "#e74c3c",
};

function node(tag: string, text?: string, className?: string): HTMLElement {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function format(value: unknown): string {
  return value === undefined
    ? "undefined"
    : (JSON.stringify(value) ?? "undefined");
}

function badge(value: string, color: string): HTMLElement {
  const result = node("span", value, "schema-badge");
  result.style.background = `${color}20`;
  result.style.color = color;
  return result;
}

function metadata(body: HTMLElement, key: string): void {
  const schema = getSchemaForKey(key);
  const section = node("div", undefined, "schema-meta");
  if (!schema) {
    section.append(node("p", "No local property policy", "placeholder"));
    body.append(section);
    return;
  }
  section.append(
    node("h4", "Local demo property policy (not registered JSON Schema)"),
  );
  const list = node("dl");
  const fields = [
    ["Description", schema.description ?? "—"],
    ["Visibility", schema.visibility ?? "public"],
    ["Change Policy", schema.changePolicy ?? "direct-allowed"],
    [
      "Max Override Layer",
      schema.maxOverrideLayer ? `🔒 ${schema.maxOverrideLayer}` : "—",
    ],
  ];
  for (const [label, value = "—"] of fields) {
    list.append(node("dt", label));
    const detail = node("dd");
    const color =
      label === "Visibility"
        ? VISIBILITY_COLORS[value]
        : label === "Change Policy"
          ? POLICY_COLORS[value]
          : undefined;
    if (color) detail.append(badge(value, color));
    else detail.textContent = value;
    list.append(detail);
  }
  section.append(list);
  body.append(section);
}

function breakdown(
  body: HTMLElement,
  layers: string[],
  winner: string | undefined,
  values: Partial<Record<string, unknown>> | undefined,
): void {
  const list = node("div", undefined, "layer-breakdown");
  for (const layer of layers) {
    const row = node(
      "div",
      undefined,
      `layer-row${layer === winner ? " winner" : ""}`,
    );
    row.append(node("span", layer, "layer-label"));
    row.append(
      node(
        "span",
        values?.[layer] === undefined ? "—" : format(values[layer]),
        "layer-val",
      ),
    );
    list.append(row);
  }
  body.append(list);
}

export function renderInspectorValue(
  body: HTMLElement,
  input: {
    key: string;
    value: unknown;
    effectiveLayer?: string | undefined;
    layerNames?: string[];
    layerValues?: Partial<Record<string, unknown>>;
  },
): void {
  const { key, value, effectiveLayer, layerNames, layerValues } = input;
  body.replaceChildren();
  body.append(node("h3", key));
  const effective = node("div", "Effective: ", "effective-value");
  effective.append(node("strong", format(value)));
  const from = node("span", "from ", "effective-layer");
  from.append(node("em", effectiveLayer ?? "local"));
  effective.append(from);
  body.append(effective);
  if (layerNames) breakdown(body, layerNames, effectiveLayer, layerValues);
  metadata(body, key);
}
