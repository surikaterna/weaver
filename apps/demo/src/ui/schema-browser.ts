import type {
  RegisteredSchemaDetailResponse,
  RegisteredSchemaIdentityPageResponse,
} from "@weaver-conf/config-types";
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";

type Selection = {
  kind: "service" | "fragment" | "slot";
  path: string;
  environment: string;
};

type Panel = ReturnType<typeof createPanel>;
type BrowseState = {
  selections: Selection[];
  request: number;
  pageRequest: number;
  nextCursor: string | null;
};

class SchemaIdentityMismatchError extends Error {}

export function schemaBrowseError(error: unknown): string {
  if (error instanceof SchemaIdentityMismatchError)
    return "Malformed schema response or request.";
  const text = error instanceof Error ? error.message : String(error);
  if (error instanceof WeaverErrorInstance) {
    if (error.code === "REVISION_CONFLICT")
      return "Schema page is stale (409). Restart from the first page.";
    if (error.code === "UNSUPPORTED_OPERATION")
      return "Schema browsing unsupported by this transport.";
    if (error.code === "NOT_FOUND")
      return "Schema registration not found (404).";
    if (error.code === "UNAUTHORIZED")
      return "Schema browsing requires authentication (401).";
    if (error.code === "FORBIDDEN")
      return "Schema browsing access denied (403).";
  }
  if (/UNSUPPORTED_OPERATION|unsupported/i.test(text))
    return "Schema browsing unsupported by this transport.";
  if (/NOT_FOUND|\b404\b/i.test(text))
    return "Schema registration not found (404).";
  if (/\b401\b|unauthorized/i.test(text))
    return "Schema browsing requires authentication (401).";
  if (/\b403\b|forbidden/i.test(text))
    return "Schema browsing access denied (403).";
  if (/REVISION_CONFLICT|\b409\b/i.test(text))
    return "Schema page is stale (409). Restart from the first page.";
  if (
    /ZodError|invalid_type|invalid_format|validation/i.test(text) ||
    (error instanceof Error && error.name === "ZodError")
  )
    return "Malformed schema response or request.";
  return `Schema request failed (network or transport): ${text}`;
}

function optionFor(selection: Selection): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = `${selection.kind}:${selection.path}:${selection.environment}`;
  option.textContent = `${selection.kind}: ${selection.path} · ${selection.environment}`;
  return option;
}

function visibleSelections(
  list: RegisteredSchemaIdentityPageResponse,
  includeFragments: boolean,
): Selection[] {
  return [
    ...list.anchors.filter(
      (item) => includeFragments || item.kind === "service",
    ),
    ...(includeFragments ? list.slots : []),
  ];
}

function createPanel(container: HTMLElement) {
  const heading = document.createElement("h2");
  heading.textContent = "Registered object schemas";
  const provenance = document.createElement("p");
  provenance.textContent = "offline seeded example (not server registrations)";
  const label = document.createElement("label");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("aria-label", "Include fragments and declared slots");
  label.append(toggle, " Include fragments and declared slots");
  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Registered schema identity");
  const next = document.createElement("button");
  next.textContent = "Next page";
  next.disabled = true;
  const restart = document.createElement("button");
  restart.textContent = "Restart first page";
  const identity = document.createElement("p");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const code = document.createElement("code");
  const pre = document.createElement("pre");
  pre.append(code);
  container.append(
    heading,
    provenance,
    label,
    selector,
    next,
    restart,
    identity,
    status,
    pre,
  );
  return { toggle, selector, next, restart, identity, status, code };
}

function clear(panel: Panel, state: BrowseState, message: string): void {
  state.request++;
  panel.code.textContent = "";
  panel.status.textContent = message;
}

function populate(
  panel: Panel,
  state: BrowseState,
  list: RegisteredSchemaIdentityPageResponse,
): void {
  state.selections = visibleSelections(list, panel.toggle.checked);
  panel.selector.replaceChildren(
    optionFor({ kind: "service", path: "Select an identity", environment: "" }),
    ...state.selections.map(optionFor),
  );
  panel.selector.selectedIndex = 0;
  panel.identity.textContent = "";
  clear(
    panel,
    state,
    state.selections.length
      ? "Select an identity to load its schema."
      : list.anchors.length + list.slots.length === 0 && !list.hasMore
        ? "Supported registry is empty."
        : "No identities match on this page. Try the next page or include fragments.",
  );
}

async function select(
  panel: Panel,
  state: BrowseState,
  client: WeaverClient,
): Promise<void> {
  const selected = state.selections[panel.selector.selectedIndex - 1];
  panel.identity.textContent = selected
    ? `${selected.kind}: ${selected.path} · environment: ${selected.environment}`
    : "";
  clear(
    panel,
    state,
    selected?.kind === "slot"
      ? "Declared slot; fragments may be on another page. Select a fragment anchor to load its schema."
      : selected
        ? "Loading selected schema…"
        : "Select an identity to load its schema.",
  );
  if (!selected || selected.kind === "slot") return;
  const current = state.request;
  try {
    const detail: RegisteredSchemaDetailResponse =
      await client.getRegisteredSchema(selected.path, selected.environment);
    if (state.request !== current) return;
    if (
      detail.path !== selected.path ||
      detail.environment !== selected.environment ||
      detail.kind !== selected.kind
    )
      throw new SchemaIdentityMismatchError("Schema detail identity mismatch");
    panel.code.textContent = JSON.stringify(detail.schema, null, 2);
    panel.status.textContent = `Full ${detail.kind} schema · owner: ${detail.metadata.owner.name}`;
  } catch (error) {
    if (state.request !== current) return;
    panel.code.textContent = "";
    panel.status.textContent = schemaBrowseError(error);
  }
}

export function renderSchemaBrowser(
  container: HTMLElement,
  client: WeaverClient,
): void {
  const panel = createPanel(container);
  const state: BrowseState = {
    selections: [],
    request: 0,
    pageRequest: 0,
    nextCursor: null,
  };
  let list: RegisteredSchemaIdentityPageResponse | undefined;
  async function load(cursor?: string): Promise<void> {
    const current = ++state.pageRequest;
    state.selections = [];
    list = undefined;
    panel.selector.replaceChildren();
    panel.identity.textContent = "";
    panel.next.disabled = true;
    clear(panel, state, "Loading schema identities…");
    try {
      const result = await client.listRegisteredSchemaIdentityPage({
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (current !== state.pageRequest) return;
      state.nextCursor = result.nextCursor;
      list = result;
      populate(panel, state, result);
      panel.next.disabled = !result.hasMore;
    } catch (error) {
      if (current !== state.pageRequest) return;
      state.nextCursor = null;
      clear(panel, state, schemaBrowseError(error));
    }
  }
  panel.selector.addEventListener("change", () => {
    void select(panel, state, client);
  });
  panel.toggle.addEventListener("change", () => {
    if (list) populate(panel, state, list);
  });
  panel.next.addEventListener("click", () => {
    if (state.nextCursor) void load(state.nextCursor);
  });
  panel.restart.addEventListener("click", () => {
    void load();
  });
  void load();
}
