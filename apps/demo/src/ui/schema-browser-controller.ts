import type {
  RegisteredSchemaDetailResponse,
  RegisteredSchemaIdentityPageResponse,
} from "@weaver-conf/config-types";
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";

export type Selection = {
  kind: "service" | "fragment" | "slot";
  path: string;
  environment: string;
};

export interface BrowseState {
  page: RegisteredSchemaIdentityPageResponse | undefined;
  selected: Selection | undefined;
  detail: RegisteredSchemaDetailResponse | undefined;
  status: string;
  error: "stale" | "retry" | null;
  history: (string | undefined)[];
  historyTruncated: boolean;
  cursor: string | undefined;
  open: boolean;
  includeFragments: boolean;
}

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
  if (/REVISION_CONFLICT|\b409\b/i.test(text))
    return "Schema page is stale (409). Restart from the first page.";
  if (/UNSUPPORTED_OPERATION|unsupported/i.test(text))
    return "Schema browsing unsupported by this transport.";
  if (/NOT_FOUND|\b404\b/i.test(text))
    return "Schema registration not found (404).";
  if (/\b401\b|unauthorized/i.test(text))
    return "Schema browsing requires authentication (401).";
  if (/\b403\b|forbidden/i.test(text))
    return "Schema browsing access denied (403).";
  if (
    /ZodError|invalid_type|invalid_format|validation/i.test(text) ||
    (error instanceof Error && error.name === "ZodError")
  )
    return "Malformed schema response or request.";
  return `Schema request failed (network or transport): ${text}`;
}

function initialState(): BrowseState {
  return {
    status: "",
    error: null,
    history: [],
    historyTruncated: false,
    open: false,
    includeFragments: false,
    page: undefined,
    selected: undefined,
    detail: undefined,
    cursor: undefined,
  };
}

function onPage(state: BrowseState, selection: Selection): boolean {
  const identities = [
    ...(state.page?.anchors ?? []),
    ...(state.page?.slots ?? []),
  ];
  return identities.some(
    (item) =>
      item.kind === selection.kind &&
      item.path === selection.path &&
      item.environment === selection.environment,
  );
}

export class SchemaBrowserController {
  readonly state = initialState();
  private generation = 0;

  constructor(
    private readonly client: WeaverClient,
    private readonly notify: (state: BrowseState) => void,
  ) {}

  private emit(): void {
    this.notify(this.state);
  }

  reset(): void {
    this.generation++;
    Object.assign(this.state, initialState());
    this.emit();
  }

  dispose(): void {
    this.reset();
  }
  close(): void {
    this.reset();
  }

  open(): void {
    if (this.state.open) return;
    this.state.open = true;
    void this.load();
  }

  private async load(cursor?: string): Promise<void> {
    const request = ++this.generation;
    const state = this.state;
    state.cursor = cursor;
    state.page = undefined;
    state.selected = undefined;
    state.detail = undefined;
    state.error = null;
    state.status = "Loading schema identities…";
    this.emit();
    try {
      const page = await this.client.listRegisteredSchemaIdentityPage({
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (request !== this.generation || !state.open) return;
      state.page = page;
      state.status =
        page.anchors.length + page.slots.length === 0 &&
        !page.hasMore &&
        !cursor
          ? "Supported registry is empty."
          : "Select an identity on this page to load its schema.";
      this.emit();
    } catch (error) {
      if (request !== this.generation || !state.open) return;
      state.status = schemaBrowseError(error);
      state.error = /stale \(409\)/.test(state.status) ? "stale" : "retry";
      if (state.error === "stale") state.history = [];
      this.emit();
    }
  }

  setFragments(value: boolean): void {
    const state = this.state;
    if (state.error && !state.page) return;
    if (state.page) this.generation++;
    state.includeFragments = value;
    state.selected = undefined;
    state.detail = undefined;
    state.error = null;
    state.status = "Select an identity on this page to load its schema.";
    this.emit();
  }

  select(selection?: Selection): void {
    void this.loadDetail(selection);
  }

  private staleDetail(): void {
    this.generation++;
    const state = this.state;
    state.page = undefined;
    state.selected = undefined;
    state.detail = undefined;
    state.cursor = undefined;
    state.history = [];
    state.historyTruncated = false;
    state.error = "stale";
    state.status = "Schema page is stale (409). Restart from the first page.";
    this.emit();
  }

  private async loadDetail(selection?: Selection): Promise<void> {
    const state = this.state;
    if (!state.open || (selection && !onPage(state, selection))) return;
    const request = ++this.generation;
    state.selected = selection;
    state.detail = undefined;
    state.error = null;
    state.status =
      selection?.kind === "slot"
        ? "Declared slot; fragments may be on another page. Select a fragment anchor for detail."
        : selection
          ? "Loading selected schema…"
          : "Select an identity on this page.";
    this.emit();
    if (!selection || selection.kind === "slot") return;
    try {
      const detail = await this.client.getRegisteredSchema(
        selection.path,
        selection.environment,
      );
      if (request !== this.generation || !state.open) return;
      if (
        detail.path !== selection.path ||
        detail.environment !== selection.environment ||
        detail.kind !== selection.kind
      )
        throw new SchemaIdentityMismatchError(
          "Schema detail identity mismatch",
        );
      state.detail = detail;
      state.status = `Full ${detail.kind} schema · owner: ${detail.metadata.owner.name}`;
      this.emit();
    } catch (error) {
      if (request !== this.generation || !state.open) return;
      if (
        error instanceof WeaverErrorInstance &&
        error.code === "REVISION_CONFLICT"
      ) {
        this.staleDetail();
        return;
      }
      state.error = "retry";
      state.status = schemaBrowseError(error);
      this.emit();
    }
  }

  next(): void {
    if (!this.state.page?.hasMore || !this.state.page.nextCursor) return;
    if (this.state.history.length === 10) this.state.historyTruncated = true;
    this.state.history = [...this.state.history, this.state.cursor].slice(-10);
    void this.load(this.state.page.nextCursor);
  }

  back(): void {
    if (!this.state.history.length) return;
    const cursor = this.state.history.pop();
    void this.load(cursor);
  }

  restart(): void {
    if (this.state.error === "stale") {
      this.state.history = [];
      this.state.historyTruncated = false;
      void this.load();
    }
  }

  retry(): void {
    if (this.state.error !== "retry") return;
    if (
      this.state.page &&
      this.state.selected &&
      this.state.selected.kind !== "slot"
    )
      this.select(this.state.selected);
    else void this.load(this.state.cursor);
  }
}
