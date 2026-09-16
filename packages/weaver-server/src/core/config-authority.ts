import { randomUUID } from "node:crypto";
import { deepEqual, runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  authorityVectorSchema,
  type ConfigurationLayerData,
  type ConfigurationStorageProvider,
  createWeaverError,
  type LayerCommitRequest,
  type LayerEnvelope,
  layerCommitRequestSchema,
  type ProviderCapabilities,
  type ProviderInventory,
  type ProviderRevision,
  type ProviderWriterHandle,
  providerCapabilitiesSchema,
  providerInventorySchema,
  type ScopeInventory,
  type WriteResult,
} from "@weaver-conf/config-types";
import { getProviderRevision } from "@weaver-conf/storage-providers";
import {
  validateAuthorityCommit,
  validateAuthorityRead,
} from "./authority-contract-boundary";
import { preflightAuthorities } from "./authority-preflight";

/** One owner per mutable provider; ownership is acquired before any service load. */
export class ConfigAuthority {
  private readonly handles = new Map<
    ConfigurationStorageProvider,
    ProviderWriterHandle
  >();
  private readonly stamps = new Map<string, string[]>();
  private readonly inventories = new Map<
    ConfigurationStorageProvider,
    ProviderInventory
  >();
  private readonly capabilities = new Map<
    ConfigurationStorageProvider,
    ProviderCapabilities
  >();
  private readonly snapshots = new Map<
    ConfigurationStorageProvider,
    Map<string, LayerEnvelope>
  >();
  private layerOrder: string[] = [];
  private readonly fallback = new Map<
    string,
    { entries: unknown; epoch: string; sequence: bigint }
  >();
  constructor(
    private readonly infrastructureId: string,
    private inventoryRevision: string,
    private inventoryDigest = "unknown",
  ) {}
  bindInventory(revision: string, digest: string): void {
    this.inventoryRevision = revision;
    this.inventoryDigest = digest;
  }
  async acquire(
    providers: readonly ConfigurationStorageProvider[],
    durable: boolean,
    inventory?: ScopeInventory,
  ): Promise<void> {
    this.layerOrder = providers.map((provider) => provider.id);
    const sorted = await preflightAuthorities(providers, durable, inventory);
    try {
      for (const provider of sorted) await this.acquireOne(provider);
    } catch (error) {
      await runIndependentCleanup(
        [{ name: "acquired providers", run: () => this.close() }],
        error,
      );
    }
  }
  private async acquireOne(
    provider: ConfigurationStorageProvider,
  ): Promise<void> {
    if (!provider.authority) return;
    this.capabilities.set(
      provider,
      providerCapabilitiesSchema.parse(provider.authority.capabilities),
    );
    this.handles.set(
      provider,
      await provider.authority.acquireWriter(randomUUID()),
    );
    await this.capture(provider);
  }
  async capture(provider: ConfigurationStorageProvider): Promise<void> {
    await this.captureMany([provider]);
  }
  async captureMany(
    providers: readonly ConfigurationStorageProvider[],
    committed?: {
      readonly provider: ConfigurationStorageProvider;
      readonly snapshot: LayerEnvelope;
    },
  ): Promise<void> {
    const staged = new Map<string, string[]>();
    const inventories = new Map<
      ConfigurationStorageProvider,
      ProviderInventory
    >();
    for (const provider of providers) {
      if (!provider.authority) continue;
      const inventory = providerInventorySchema.parse(
        await provider.authority.inventory(),
      );
      if (
        committed?.provider === provider &&
        !inventory.revisions.some((stamp) =>
          deepEqual(stamp, getProviderRevision(committed.snapshot)),
        )
      )
        throw createWeaverError(
          "COMMIT_OUTCOME_UNKNOWN",
          "Committed snapshot differs from provider inventory",
        );
      if (
        !inventory.revisions.some((stamp) => stamp.layer === provider.layer) ||
        new Set(inventory.revisions.map((stamp) => stamp.layer)).size !==
          inventory.revisions.length
      )
        throw createWeaverError(
          "PROVIDER_CORRUPT",
          "Invalid provider revision inventory",
        );
      inventories.set(provider, inventory);
      staged.set(
        provider.id,
        inventory.revisions.map((stamp) => JSON.stringify(stamp)).sort(),
      );
    }
    for (const [id, revisions] of staged) this.stamps.set(id, revisions);
    for (const [provider, inventory] of inventories)
      this.inventories.set(provider, inventory);
  }
  private expected(
    provider: ConfigurationStorageProvider,
    layer: string,
  ): ProviderRevision | undefined {
    return this.inventories
      .get(provider)
      ?.revisions.find((stamp) => stamp.layer === layer);
  }
  async load(
    provider: ConfigurationStorageProvider,
    layer = provider.layer,
  ): Promise<ConfigurationLayerData> {
    if (!provider.authority)
      return layer !== provider.layer && provider.loadLayer
        ? provider.loadLayer(layer)
        : provider.load();
    const snapshot = validateAuthorityRead(
      await provider.authority.readLayer(layer),
      layer,
      this.expected(provider, layer),
    );
    this.rememberSnapshot(provider, snapshot);
    return {
      entries: snapshot.entries,
      revision: JSON.stringify(getProviderRevision(snapshot)),
    };
  }
  assertCapturedSnapshot(
    provider: ConfigurationStorageProvider,
    snapshot: LayerEnvelope,
  ): void {
    const captured = this.snapshots.get(provider)?.get(snapshot.layer);
    const capabilities = this.capabilities.get(provider);
    const currentCapabilities = provider.authority
      ? providerCapabilitiesSchema.parse(provider.authority.capabilities)
      : undefined;
    if (
      !captured ||
      !capabilities ||
      !deepEqual(capabilities, currentCapabilities) ||
      !deepEqual(captured, snapshot)
    )
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Provider snapshot differs from the captured authority",
      );
  }
  private rememberSnapshot(
    provider: ConfigurationStorageProvider,
    snapshot: LayerEnvelope,
  ): void {
    const layers =
      this.snapshots.get(provider) ?? new Map<string, LayerEnvelope>();
    layers.set(snapshot.layer, structuredClone(snapshot));
    this.snapshots.set(provider, layers);
  }
  trackFallback(
    provider: ConfigurationStorageProvider,
    entries: unknown,
  ): void {
    if (provider.authority) return;
    const previous = this.fallback.get(provider.id);
    if (previous && deepEqual(previous.entries, entries)) return;
    this.fallback.set(provider.id, {
      entries: structuredClone(entries),
      epoch: previous?.epoch ?? randomUUID(),
      sequence: (previous?.sequence ?? -1n) + 1n,
    });
  }
  revision(): string {
    const providers = [...this.stamps.entries()];
    for (const [id, state] of this.fallback)
      providers.push([id, [`volatile:${state.epoch}:${state.sequence}`]]);
    const vector = authorityVectorSchema.parse({
      version: 1,
      infrastructureId: this.infrastructureId,
      inventoryRevision: this.inventoryRevision,
      inventoryDigest: this.inventoryDigest,
      layerOrder: this.layerOrder,
      providers: providers
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([providerId, revisions]) => ({ providerId, revisions })),
    });
    return `authority-v1.${Buffer.from(JSON.stringify(vector)).toString("base64url")}`;
  }
  matches(
    provider: ConfigurationStorageProvider,
    inventory: ProviderInventory,
  ): boolean {
    return deepEqual(
      this.stamps.get(provider.id),
      inventory.revisions.map((stamp) => JSON.stringify(stamp)).sort(),
    );
  }
  admitted(provider: ConfigurationStorageProvider): {
    readonly capabilities: ProviderCapabilities;
    readonly inventory: ProviderInventory;
  } {
    const capabilities = this.capabilities.get(provider);
    const inventory = this.inventories.get(provider);
    if (!capabilities || !inventory)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        `Provider ${provider.id} has no admitted authority identity`,
      );
    return { capabilities, inventory };
  }
  async commit(
    provider: ConfigurationStorageProvider,
    layer: string,
    key: string,
    value: unknown,
    remove: boolean,
    operationId?: string,
  ): Promise<{ result: WriteResult; snapshot?: LayerEnvelope }> {
    const authority = provider.authority;
    const handle = this.handles.get(provider);
    if (!authority || !handle)
      return {
        result: {
          success: false,
          error: {
            code: "UNSUPPORTED_AUTHORITY",
            message: "No owned provider authority",
          },
        },
      };
    const current = validateAuthorityRead(
      await authority.readLayer(layer),
      layer,
      this.expected(provider, layer),
      true,
    );
    const expectedRevision = getProviderRevision(current);
    const request = layerCommitRequestSchema.safeParse({
      layer,
      expectedRevision,
      operationId: operationId ?? randomUUID(),
      mutation: remove
        ? { action: "remove", key }
        : { action: "set", key, value },
    });
    if (!request.success)
      return {
        result: {
          success: false,
          error: { code: "VALIDATION_ERROR", message: request.error.message },
        },
      };
    return this.commitPrepared(provider, current, request.data, handle);
  }
  private async commitPrepared(
    provider: ConfigurationStorageProvider,
    current: LayerEnvelope,
    request: LayerCommitRequest,
    handle: ProviderWriterHandle,
  ): Promise<{ result: WriteResult; snapshot?: LayerEnvelope }> {
    const capabilities = this.capabilities.get(provider);
    if (!capabilities)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Provider was not admitted",
      );
    const committed = validateAuthorityCommit(
      await provider.authority?.commitLayer(request, handle),
      current,
      request,
      capabilities,
    );
    if (!committed.success) return { result: committed };
    this.rememberSnapshot(provider, committed.snapshot);
    await this.captureMany([provider], {
      provider,
      snapshot: committed.snapshot,
    });
    return { result: { success: true }, snapshot: committed.snapshot };
  }
  async close(): Promise<void> {
    const acquired = [...this.handles].reverse();
    this.handles.clear();
    await runIndependentCleanup(
      acquired.map(([provider, handle]) => ({
        name: `writer:${provider.id}`,
        run: async () => {
          await provider.authority?.releaseWriter(handle);
        },
      })),
    );
  }
}
