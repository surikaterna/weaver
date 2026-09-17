import {
  canonicalConfigPathFromStorageKey,
  deepEqual,
} from "@weaver-conf/config-engine";
import {
  type ConfigurationStorageProvider,
  createWeaverError,
  type InternalCatalogBinding,
  type ScopeInstance,
} from "@weaver-conf/config-types";
import {
  authoritativeContextPaths,
  stageCandidateScopes,
} from "./candidate-scopes";
import { projectCanonicalRegistrations } from "./canonical-projection";
import { type CandidateLayers, mergeCandidate } from "./config-candidates";
import {
  ConfigContracts,
  type PreparedConfiguration,
} from "./config-contracts";
import {
  validateCoveredEffective,
  validateSparseLayer,
} from "./config-coverage";
import type { ConfigServiceController } from "./config-service-controller";
import { transitionPermission } from "./config-service-internal";
import type { WriteContext } from "./config-service-types";
import { pinnedRecoveryContext } from "./pinned-recovery-context";
import { trustedProviderDefinition } from "./provider-definition-binding";
import {
  assertInventoryTransition,
  scopeInventoryDigest,
} from "./scope-inventory";

export class ConfigPipeline {
  private bound: ConfigContracts | undefined;
  constructor(private readonly host: ConfigServiceController) {}

  get controlProvider(): ConfigurationStorageProvider {
    const provider = this.host.providers.find(
      (item) => item.layer === (this.host.options.controlLayer ?? "platform"),
    );
    if (!provider?.authority)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Control layer requires owned authority",
      );
    return provider;
  }

  get contracts(): ConfigContracts {
    if (!this.bound)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Code contracts are not bound",
      );
    return this.bound;
  }

  get inventory() {
    try {
      return this.contracts.prepared().configuration.scopeInventory;
    } catch {
      return undefined;
    }
  }

  async initialize(): Promise<void> {
    const provider = this.controlProvider;
    const envelope = await provider.authority?.readLayer(provider.layer);
    if (!envelope)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Missing control authority",
      );
    const binding: InternalCatalogBinding = {
      storeId: envelope.storeId,
      environment: this.host.options.environment,
    };
    const controlOnly = this.host.options.serviceMode === "control";
    this.bound = new ConfigContracts(
      binding,
      controlOnly,
      controlOnly ? [] : trustedProviderAuthorities(this.host),
    );
    const recovery = pinnedRecoveryContext(this.host);
    if (recovery) {
      const current = this.host.layerData.get(provider.id) ?? {};
      this.host.layerData.set(provider.id, { ...current, _weaver: recovery });
    }
    const raw = this.host.layerData.get(provider.id)?._weaver;
    if (raw === undefined && this.host.options.serviceMode === "control")
      return;
    let prepared: PreparedConfiguration;
    try {
      prepared = this.contracts.prepare(raw);
    } catch (error) {
      if (this.host.options.serviceMode === "control") return;
      throw error;
    }
    if (
      this.host.options.scopeInventory &&
      !deepEqual(
        this.host.options.scopeInventory,
        prepared.configuration.scopeInventory,
      )
    )
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Scope inventory hint differs from persisted authority",
      );
    this.install(prepared);
  }

  assertApplicationReady(): void {
    if (!this.host.applicationActive)
      throw createWeaverError(
        this.host.applicationError,
        "Control service does not serve application configuration",
      );
    this.assertInitialized();
  }

  assertInitialized(): void {
    const configuration = this.contracts.prepared().configuration;
    if (configuration.format.initialization !== "initialized")
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Configuration is not initialized",
      );
    if (
      Object.values(configuration.upgrades.journal).some(
        (journal) =>
          !["completed", "compensated", "restart-required"].includes(
            journal.phase,
          ),
      )
    )
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Maintenance recovery is pending",
      );
  }

  install(prepared: PreparedConfiguration): void {
    this.contracts.install(prepared);
    const inventory = prepared.configuration.scopeInventory;
    this.host.authority.bindInventory(
      inventory.revision,
      scopeInventoryDigest(inventory),
    );
  }

  anchors(environment = this.host.options.environment) {
    return this.contracts
      .registrations()
      .anchors.filter(
        (anchor) =>
          anchor.kind === "service" && anchor.environment === environment,
      );
  }

  merge(path?: ScopeInstance[]): Record<string, unknown> {
    return mergeCandidate(
      this.contracts.prepared(),
      this.host.providers,
      {
        base: this.host.layerData,
        scoped: this.host.dynamicScopeEntries,
      },
      path,
    );
  }

  async validate(
    layers: CandidateLayers,
    prepared = this.contracts.prepare(
      layers.base.get(this.controlProvider.id)?._weaver,
    ),
    expectedContexts?: readonly (readonly ScopeInstance[])[],
  ) {
    this.validateLayout(prepared);
    const anchors = projectCanonicalRegistrations(
      prepared.configuration.catalog,
    ).anchors.filter((anchor) => anchor.kind === "service");
    const staged = await stageCandidateScopes(this.host, prepared, layers);
    this.validateLayers(layers, staged, anchors);
    const contexts = [];
    for (const scopePath of authoritativeContextPaths(
      prepared,
      expectedContexts,
    )) {
      const raw = mergeCandidate(
        prepared,
        this.host.providers,
        { base: layers.base, scoped: staged.scoped },
        scopePath,
      );
      const entries = validateCoveredEffective(
        await this.host.runtime.resolveCandidate(raw),
        anchors,
      );
      contexts.push({ scopePath, entries });
    }
    return { prepared, scoped: staged.scoped, contexts };
  }

  private validateLayout(prepared: PreparedConfiguration): void {
    const generation =
      prepared.configuration.infrastructure.generations[
        prepared.configuration.infrastructure.activeGeneration
      ];
    const declared =
      generation?.layout.layers.map((layer) => layer.providerId) ?? [];
    if (this.host.providers.some((provider) => !declared.includes(provider.id)))
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Provider is not bound by the compiled layout",
      );
    if (
      declared.some(
        (id) => !this.host.providers.some((provider) => provider.id === id),
      )
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Compiled layout references an unavailable provider",
      );
    for (const layer of generation?.layout.layers ?? []) {
      const provider = this.host.providers.find(
        (item) => item.id === layer.providerId,
      );
      if (provider?.layer.includes(":") && layer.type !== "dynamic")
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          "Scoped providers require a dynamic layer definition",
        );
      if (provider === this.controlProvider && layer.type !== "static")
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          "The protected control layer must be static",
        );
    }
  }

  private validateLayers(
    layers: CandidateLayers,
    staged: Awaited<ReturnType<typeof stageCandidateScopes>>,
    anchors: ReturnType<typeof projectCanonicalRegistrations>["anchors"],
  ): void {
    for (const provider of this.host.providers) {
      const entries = layers.base.get(provider.id) ?? {};
      if (
        this.host.options.controlPathsOnly &&
        provider === this.controlProvider &&
        Object.keys(entries).some((key) => key !== "_weaver")
      )
        throw createWeaverError(
          "FORBIDDEN",
          "Seed control namespace cannot contain application data",
        );
      if (
        provider !== this.controlProvider &&
        Object.hasOwn(entries, "_weaver")
      )
        throw createWeaverError(
          "FORBIDDEN",
          "Application layer cannot supply protected configuration",
        );
      if (!provider.layer.includes(":") || staged.active.has(provider.layer))
        validateSparseLayer(entries, anchors);
    }
    for (const [layer, entries] of staged.scoped) {
      if (Object.hasOwn(entries, "_weaver"))
        throw createWeaverError(
          "FORBIDDEN",
          "Scoped internal override is forbidden",
        );
      if (staged.active.has(layer)) validateSparseLayer(entries, anchors);
    }
  }

  async validateMutation(
    provider: ConfigurationStorageProvider,
    layer: string,
    candidate: Record<string, unknown>,
    internal: boolean,
    key: string,
    options?: WriteContext,
  ) {
    if (!internal) this.assertWriteCoverage(key);
    const base = new Map(this.host.layerData);
    const scoped = new Map(this.host.dynamicScopeEntries);
    if (layer === provider.layer) base.set(provider.id, candidate);
    else scoped.set(layer, candidate);
    const transition = transitionPermission(options);
    if (transition) return this.validate({ base, scoped }, transition.prepared);
    if (
      internal &&
      (provider !== this.controlProvider || layer !== provider.layer)
    )
      throw createWeaverError(
        "FORBIDDEN",
        "Protected mutation must use the control layer",
      );
    if (internal && key === "_weaver.scopeInventory") {
      const previous = this.contracts.prepared().configuration;
      const next = this.contracts.prepare(candidate._weaver).configuration;
      assertInventoryTransition(
        previous.scopeInventory,
        next.scopeInventory,
        previous.format.initialization !== "initialized",
      );
    }
    if (internal && !this.host.applicationActive) {
      const prepared = this.contracts.prepare(candidate._weaver);
      if (
        key.startsWith("_weaver.upgrades.") ||
        (prepared.configuration.format.initialization !== "initialized" &&
          key !== "_weaver.scopeInventory")
      )
        return;
    }
    return this.validate({ base, scoped });
  }

  private assertWriteCoverage(key: string): void {
    const path = canonicalConfigPathFromStorageKey(key).path;
    if (
      !this.anchors().some(
        (anchor) =>
          path === anchor.path ||
          path.startsWith(`${anchor.path}/`) ||
          anchor.path.startsWith(`${path}/`),
      )
    )
      throw createWeaverError(
        "VALIDATION_ERROR",
        "No registered schema covers this path",
      );
  }

  installCurrent(): void {
    this.install(
      this.contracts.prepare(
        this.host.layerData.get(this.controlProvider.id)?._weaver,
      ),
    );
  }
}

function trustedProviderAuthorities(host: ConfigServiceController) {
  return host.providers.flatMap((provider) => {
    if (!provider.authority) return [];
    const admitted = host.authority.admitted(provider);
    const definition = trustedProviderDefinition(provider);
    return definition && "namespace" in admitted.capabilities
      ? [
          Object.freeze({
            providerId: provider.id,
            definition,
            namespace: admitted.capabilities.namespace,
            revisions: admitted.inventory.revisions,
          }),
        ]
      : [];
  });
}

export type ValidatedCandidate = Awaited<
  ReturnType<ConfigPipeline["validate"]>
>;
