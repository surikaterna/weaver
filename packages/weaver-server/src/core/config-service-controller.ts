import {
  consoleLogger,
  runIndependentCleanup,
  type WeaverLogger,
} from "@weaver-conf/config-engine";
import {
  type ConfigurationStorageProvider,
  createWeaverError,
  type ScopeInstance,
  type ScopeInventory,
} from "@weaver-conf/config-types";
import type { ConfigDelta } from "../types/index";
import type { ConfigAuthority } from "./config-authority";
import { createConfigMutationCoordinator } from "./config-mutation-coordinator";
import { ConfigPipeline, type ValidatedCandidate } from "./config-pipeline";
import { providerFlushSteps } from "./config-service-disposal";
import { ConfigServiceMutations } from "./config-service-mutations";
import type {
  WeaverConfigService,
  WeaverConfigServiceOptions,
} from "./config-service-types";
import {
  createConfigServiceState,
  hasScopedLayerIo,
} from "./config-service-write-state";
import type { ValidatedFinalContexts } from "./final-context-evidence";
import { installUpgradeSnapshot } from "./install-upgrade-snapshot";
import { MaintenanceController } from "./maintenance-controller";
import { createProviderReadiness } from "./provider-readiness";
import { createRuntimeResolutionContexts } from "./runtime-resolution-contexts";
import { assertInventoryContext, scopeContextId } from "./scope-inventory";
import {
  isSameScopeLayer,
  normalizeScopeLayer,
  parseScopeLayer,
} from "./scope-utils";
import { initializeAuthorityInventory } from "./service-authority-snapshot";
/** Owns live installation and provider IO; facade reads and mutations share its coordinator. */
export class ConfigServiceController {
  readonly coordinator = createConfigMutationCoordinator();
  readonly readiness;
  readonly layerData = new Map<string, Record<string, unknown>>();
  readonly dynamicScopeEntries = new Map<string, Record<string, unknown>>();
  readonly logger: WeaverLogger;
  readonly state;
  readonly runtime;
  readonly mutations;
  readonly pipeline;
  private service: WeaverConfigService | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  readonly maintenance = new MaintenanceController(this);
  private admitted = false;
  private denial: "CONFIG_NOT_READY" | "MAINTENANCE" = "CONFIG_NOT_READY";
  private committedValidation: ValidatedCandidate | undefined;

  constructor(
    readonly options: WeaverConfigServiceOptions,
    readonly providers: readonly ConfigurationStorageProvider[],
    readonly authority: ConfigAuthority,
    _inventory?: ScopeInventory,
  ) {
    this.pipeline = new ConfigPipeline(this);
    this.logger = options.logger ?? consoleLogger;
    this.readiness = createProviderReadiness(options.onReadinessChange);
    this.state = createConfigServiceState({
      layerData: this.layerData,
      dynamicScopeEntries: this.dynamicScopeEntries,
      resolveProvider: (layer) => this.resolveProvider(layer),
    });
    this.runtime = createRuntimeResolutionContexts({
      isActiveScope: (path) =>
        this.inventory?.contexts[scopeContextId(path)]?.state === "active",
      getMergedState: (path) => this.pipeline.merge(path),
      ...(options.secretBackend
        ? { secretBackend: options.secretBackend }
        : {}),
      logger: this.logger,
    });
    this.mutations = new ConfigServiceMutations(this.mutationHost());
  }
  private mutationHost() {
    return {
      service: () => this.getService(),
      environment: this.options.environment,
      authority: this.authority,
      revision: () => this.authority.revision(),
      ready: (internal: boolean) => this.assertReady(internal),
      validateCandidate: (
        provider: ConfigurationStorageProvider,
        layer: string,
        entries: Record<string, unknown>,
        internal: boolean,
        key: string,
        options?: import("./config-service-types").WriteContext,
      ) =>
        this.pipeline.validateMutation(
          provider,
          layer,
          entries,
          internal,
          key,
          options,
        ),
      resolveProvider: (layer: string) => this.resolveProvider(layer),
      getLayerValue: (layer: string, key: string) =>
        this.layerValue(layer, key),
      layerEntries: this.state.getLayerEntries,
      install: (
        provider: ConfigurationStorageProvider,
        layer: string,
        dynamic: boolean,
        entries: Record<string, unknown>,
        validation?: ValidatedCandidate,
      ) => this.install(provider, layer, dynamic, entries, validation),
      publish: (delta: ConfigDelta, validation?: ValidatedCandidate) =>
        this.publish(delta, validation),
      autoFlush: () => this.autoFlush(),
      failedCommit: (provider: ConfigurationStorageProvider, message: string) =>
        this.readiness.fail(provider.id, message),
      warn: (message: string) => this.logger.warn(message),
    };
  }
  bind(service: WeaverConfigService): void {
    this.service = service;
  }
  getService(): WeaverConfigService {
    if (!this.service)
      throw createWeaverError("INTERNAL_ERROR", "Service is not bound");
    return this.service;
  }
  get inventory(): ScopeInventory | undefined {
    return this.pipeline.inventory;
  }
  get applicationActive(): boolean {
    return this.admitted;
  }
  get applicationError() {
    return this.denial;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  suspendApplication(): void {
    this.admitted = false;
    this.denial = "MAINTENANCE";
  }
  openApplication(): void {
    this.assertReady(true);
    this.pipeline.assertInitialized();
    this.admitted = true;
  }
  installUpgradeSnapshot(
    snapshot: ValidatedFinalContexts,
    prepared: ValidatedCandidate["prepared"],
  ): void {
    installUpgradeSnapshot(this, snapshot, prepared);
    this.updateRevision();
  }
  assertReady(internal = false): void {
    if (this.closed)
      throw createWeaverError("SERVER_DEGRADED", "Service is closed");
    this.readiness.assertReady();
    if (!internal) this.pipeline.assertApplicationReady();
  }
  async initialize(): Promise<void> {
    for (const provider of this.providers)
      this.layerData.set(
        provider.id,
        (await this.loadProvider(provider)).entries,
      );
    await this.pipeline.initialize();
    if (this.options.serviceMode !== "control")
      await initializeAuthorityInventory(this);
    if (this.inventory && this.options.serviceMode !== "control")
      for (const context of Object.values(this.inventory.contexts))
        if (context.state === "active")
          await this.warmScopeLayers(context.scopePath);
    this.updateRevision();
    if (this.inventory && this.options.serviceMode !== "control")
      await this.pipeline.validate({
        base: this.layerData,
        scoped: this.dynamicScopeEntries,
      });
    if (this.options.serviceMode !== "control") this.openApplication();
    this.maintenance.start();
  }
  resolveProvider(layer: string): ConfigurationStorageProvider | undefined {
    const direct = this.providers.find((provider) => provider.layer === layer);
    if (direct) return direct;
    const parsed = parseScopeLayer(layer);
    if (!parsed) return undefined;
    return (
      this.providers.find((provider) =>
        isSameScopeLayer(provider.layer, layer),
      ) ?? this.providers.find((provider) => provider.layer === parsed.scopeId)
    );
  }
  private updateRevision(): void {
    for (const provider of this.providers)
      this.authority.trackFallback(provider, {
        entries: this.layerData.get(provider.id),
        scopes: [...this.dynamicScopeEntries].filter(
          ([layer]) => this.resolveProvider(layer) === provider,
        ),
      });
  }
  private install(
    provider: ConfigurationStorageProvider,
    layer: string,
    dynamic: boolean,
    entries: Record<string, unknown>,
    validation?: ValidatedCandidate,
  ): void {
    this.committedValidation = validation;
    if (validation) {
      this.runtime.installValidated(validation.contexts);
      for (const [scope, data] of validation.scoped)
        this.dynamicScopeEntries.set(scope, structuredClone(data));
      for (const context of Object.values(
        validation.prepared.configuration.scopeInventory.contexts,
      ))
        if (context.state === "active")
          this.runtime.materialize(context.scopePath);
    }
    if (dynamic) this.dynamicScopeEntries.set(layer, structuredClone(entries));
    else this.layerData.set(provider.id, structuredClone(entries));
    this.updateRevision();
    if (provider === this.pipeline.controlProvider && layer === provider.layer)
      this.pipeline.installCurrent();
  }
  async warmScopeLayers(scopePath?: ScopeInstance[]): Promise<void> {
    if (this.inventory) assertInventoryContext(this.inventory, scopePath);
    if (!scopePath?.length) return;
    for (const scope of scopePath)
      await this.warmPhysicalLayer(`${scope.scopeId}:${scope.value}`);
    this.runtime.materialize(scopePath);
  }
  private assertPhysicalLayer(layer: string): void {
    if (!this.inventory) return;
    const active = Object.values(this.inventory.contexts).filter(
      (context) => context.state === "active",
    );
    if (
      !active.some((context) =>
        context.scopePath.some(
          (scope) => `${scope.scopeId}:${scope.value}` === layer,
        ),
      )
    )
      throw createWeaverError(
        "SCOPE_NOT_FOUND",
        "Physical scope is not active in the authoritative inventory",
      );
  }
  private async warmPhysicalLayer(layer: string): Promise<void> {
    this.assertPhysicalLayer(layer);
    const provider = this.resolveProvider(layer);
    if (!provider || !hasScopedLayerIo(provider)) {
      if (this.inventory)
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          `Inventory references unavailable physical layer: ${layer}`,
        );
      return;
    }
    if (this.dynamicScopeEntries.has(layer) || provider.layer === layer) return;
    const data = await this.loadProvider(provider, layer);
    this.dynamicScopeEntries.set(layer, data.entries);
    await this.authority.capture(provider);
    this.updateRevision();
  }
  async layerValue(layer: string, key: string): Promise<unknown> {
    if (parseScopeLayer(layer))
      await this.warmPhysicalLayer(normalizeScopeLayer(layer));
    return key === "" ? undefined : this.state.getLayerValue(layer, key);
  }
  publishRegistration(path: string): Promise<void> {
    return this.runtime.publishRegistration(
      this.getService(),
      path,
      this.committedValidation?.contexts,
    );
  }
  private publish(
    delta: ConfigDelta,
    validation?: ValidatedCandidate,
  ): Promise<void> {
    return this.runtime.publishMutation(
      this.getService(),
      delta,
      validation?.contexts,
    );
  }
  async reload(
    selected: readonly ConfigurationStorageProvider[],
    refresh: boolean,
  ): Promise<void> {
    this.assertOpen();
    if (this.options.serviceMode !== "control" && !this.applicationActive)
      throw createWeaverError("MAINTENANCE", "Application reload is suspended");
    this.readiness.assertRecoverable();
    const staged = new Map<string, Record<string, unknown>>();
    const scoped = new Map<string, Record<string, unknown>>();
    for (const provider of selected)
      await this.stageReload(provider, refresh, staged, scoped);
    const candidateBase = new Map([...this.layerData, ...staged]);
    const candidateScopes = new Map([...this.dynamicScopeEntries, ...scoped]);
    try {
      const validation = await this.pipeline.validate({
        base: candidateBase,
        scoped: candidateScopes,
      });
      this.runtime.installValidated(validation.contexts);
    } catch (error) {
      this.readiness.invalidate("configuration-contracts", String(error));
      throw error;
    }
    try {
      await this.authority.captureMany(selected);
    } catch (error) {
      for (const provider of selected)
        this.readiness.invalidate(provider.id, String(error));
      throw error;
    }
    for (const [id, entries] of staged) this.layerData.set(id, entries);
    for (const [layer, entries] of scoped)
      this.dynamicScopeEntries.set(layer, entries);
    this.updateRevision();
    this.pipeline.installCurrent();
    this.readiness.validated();
  }
  private async stageReload(
    provider: ConfigurationStorageProvider,
    refresh: boolean,
    staged: Map<string, Record<string, unknown>>,
    scoped: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    try {
      if (refresh) await provider.refresh?.();
      staged.set(provider.id, (await this.loadProvider(provider)).entries);
      for (const layer of this.dynamicScopeEntries.keys())
        if (this.resolveProvider(layer) === provider)
          scoped.set(layer, (await this.loadProvider(provider, layer)).entries);
    } catch (error) {
      this.readiness.invalidate(provider.id, String(error));
      throw error;
    }
  }
  private loadProvider(
    provider: ConfigurationStorageProvider,
    layer = provider.layer,
  ) {
    return this.readiness.load(provider, layer, () =>
      this.authority.load(provider, layer),
    );
  }
  private autoFlush(): void {
    this.maintenance.scheduleFlush();
  }
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    return this.maintenance.batch(fn);
  }
  async flush(): Promise<void> {
    await this.maintenance.flush();
  }
  assertOpen(): void {
    if (this.closed)
      throw createWeaverError("SERVER_DEGRADED", "Service admission is closed");
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.readiness.invalidate("service-lifecycle", "Service is closing");
    this.closing = this.coordinator.run(() =>
      runIndependentCleanup([
        ...this.maintenance.stopSteps(),
        ...providerFlushSteps(this.providers),
        { name: "provider owners", run: () => this.authority.close() },
        { name: "runtime", run: () => this.runtime.dispose() },
      ]),
    );
    return this.closing;
  }
}
