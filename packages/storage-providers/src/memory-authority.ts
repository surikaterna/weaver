import { randomUUID } from "node:crypto";
import {
  createWeaverError,
  type LayerEnvelope,
  type ProviderCapabilities,
  type ProviderPreflight,
} from "@weaver-conf/config-types";
import { freshEnvelope } from "./authority-envelope";
import { type AuthorityBackend, LayerAuthority } from "./layer-authority";

export class MemoryAuthorityBackend implements AuthorityBackend {
  private readonly storeId = `memory:${randomUUID()}`;
  private readonly envelopes = new Map<string, LayerEnvelope>();
  readonly capabilities: ProviderCapabilities = {
    kind: "volatile-exclusive",
    durability: "memory",
    namespace: this.storeId,
    maxEnvelopeBytes: 16_000_000,
    scopedIO: "complete",
  };
  private owned = false;
  constructor(
    private readonly environment: string,
    layer: string,
    entries: Record<string, unknown>,
  ) {
    this.envelopes.set(
      layer,
      freshEnvelope(this.storeId, environment, layer, entries),
    );
  }
  async acquire(): Promise<void> {
    if (this.owned)
      throw createWeaverError("WRITER_CONFLICT", "Memory store already owned");
    this.owned = true;
  }
  async preflight(layers?: readonly string[]): Promise<ProviderPreflight> {
    return {
      namespace: this.storeId,
      layers: [...new Set([...this.envelopes.keys(), ...(layers ?? [])])],
      initialization: "volatile",
    };
  }
  async release(): Promise<void> {
    this.owned = false;
  }
  async read(layer: string): Promise<LayerEnvelope> {
    let envelope = this.envelopes.get(layer);
    if (!envelope) {
      envelope = freshEnvelope(this.storeId, this.environment, layer);
      this.envelopes.set(layer, envelope);
    }
    return structuredClone(envelope);
  }
  async layers(): Promise<string[]> {
    return [...this.envelopes.keys()];
  }
  async persist(envelope: LayerEnvelope): Promise<void> {
    this.envelopes.set(envelope.layer, structuredClone(envelope));
  }
}

export function createMemoryAuthority(
  environment: string,
  layer: string,
  entries: Record<string, unknown>,
): LayerAuthority {
  return new LayerAuthority(
    new MemoryAuthorityBackend(environment, layer, entries),
  );
}
