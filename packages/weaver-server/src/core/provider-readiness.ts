import {
  type ConfigurationLayerData,
  type ConfigurationStorageProvider,
  createWeaverError,
  type WeaverErrorInstance,
} from "@weaver-conf/config-types";

/** Failed candidates never replace live state; retained state is not a public fallback. */
export class ProviderReadiness {
  private readonly failures = new Map<string, WeaverErrorInstance>();
  constructor(private readonly onChange?: (ready: boolean) => void) {}
  private notify(ready: boolean): void {
    try {
      this.onChange?.(ready);
    } catch {
      /* Observability cannot change the storage outcome. */
    }
  }
  recovered(): void {
    if (this.failures.size === 0) this.notify(true);
  }
  validated(): void {
    this.failures.delete("configuration-contracts");
    this.recovered();
  }
  assertRecoverable(): void {
    for (const failure of this.failures.values())
      if (failure.code === "COMMIT_OUTCOME_UNKNOWN") throw failure;
  }
  assertReady(): void {
    const failure = this.failures.values().next().value;
    if (failure) throw failure;
  }
  failedIds(): string[] {
    return [...this.failures.keys()];
  }
  async load(
    provider: ConfigurationStorageProvider,
    layer?: string,
    loader?: () => Promise<ConfigurationLayerData>,
  ) {
    try {
      const data = loader
        ? await loader()
        : layer && provider.loadLayer
          ? await provider.loadLayer(layer)
          : await provider.load();
      if (this.failures.get(provider.id)?.code !== "COMMIT_OUTCOME_UNKNOWN")
        this.failures.delete(provider.id);
      return structuredClone(data);
    } catch (error) {
      const failure = createWeaverError(
        "PROVIDER_LOAD_FAILED",
        `Required provider "${provider.id}" failed to load`,
        {
          providerId: provider.id,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
      this.failures.set(provider.id, failure);
      this.notify(false);
      throw failure;
    }
  }
  fail(providerId: string, message: string): void {
    this.failures.set(
      providerId,
      createWeaverError("COMMIT_OUTCOME_UNKNOWN", message),
    );
    this.notify(false);
  }
  invalidate(providerId: string, message: string): void {
    this.failures.set(
      providerId,
      createWeaverError("PROVIDER_LOAD_FAILED", message),
    );
    this.notify(false);
  }
}

export function createProviderReadiness(onChange?: (ready: boolean) => void) {
  return new ProviderReadiness(onChange);
}
