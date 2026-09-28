import type { RegisteredSchemasResponse } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";
import { SCHEMA_FIXTURES } from "../registered-schema-fixtures";

export function schemaView(
  result: RegisteredSchemasResponse | null,
  key: string,
): string {
  if (result === null) return "Schema listing unsupported by this transport.";
  if (Object.keys(result.schemas).length === 0)
    return "Supported registry is empty.";
  const schema = Object.hasOwn(result.schemas, key)
    ? result.schemas[key]
    : undefined;
  if (!schema) return `No registration for ${key}.`;
  return JSON.stringify(schema, null, 2);
}

function createSchemaPanel(container: HTMLElement) {
  const heading = document.createElement("h2");
  heading.textContent = "Registered object schemas";
  const provenance = document.createElement("p");
  provenance.textContent = "offline seeded example (not server registrations)";
  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Schema fixture");
  for (const fixture of SCHEMA_FIXTURES) {
    const option = document.createElement("option");
    option.value = fixture.key;
    option.textContent = fixture.label;
    selector.append(option);
  }
  const identity = document.createElement("p");
  const code = document.createElement("code");
  const pre = document.createElement("pre");
  pre.append(code);
  container.append(heading, provenance, selector, identity, pre);
  return { selector, identity, code };
}

export function renderSchemaBrowser(
  container: HTMLElement,
  client: WeaverClient,
): void {
  const { selector, identity, code } = createSchemaPanel(container);
  let result: RegisteredSchemasResponse | null = null;
  let failure: string | null = null;
  const display = () => {
    const fixture = SCHEMA_FIXTURES.find(({ key }) => key === selector.value);
    identity.textContent = fixture
      ? `${fixture.kind}: ${fixture.anchor} · environment: ${fixture.environment} · key: ${fixture.key}`
      : `Unknown fixture key: ${selector.value}`;
    code.textContent = failure ?? schemaView(result, selector.value);
  };
  selector.addEventListener("change", display);
  code.textContent = "Loading schemas…";
  void client.fetchSchemas().then(
    (schemas) => {
      result = schemas;
      display();
    },
    (error: unknown) => {
      failure = `Schema fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      display();
    },
  );
}
