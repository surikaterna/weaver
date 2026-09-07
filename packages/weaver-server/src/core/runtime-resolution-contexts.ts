import type { WeaverLogger } from "@weaver-conf/config-engine";
import type { SecretBackend } from "@weaver-conf/config-runtime";
import {
  formatScopePath,
  isConfigMount,
  isSecretReference,
  type ScopeInstance,
} from "@weaver-conf/config-types";
import type { ConfigDelta } from "../types/index";
import type { WeaverConfigService } from "./config-service-types";
import { filterProtectedConfigEntries } from "./protected-config-paths";
import { createResolutionPipeline } from "./resolution-pipeline";
import {
  projectRuntimeMutation,
  projectRuntimeRegistration,
  type ResolvedRuntimeProjectionContext,
} from "./schema-read-boundary";
import { parseScopeLayer } from "./scope-utils";

const EFFECTIVE_BASE_LAYER = "weaver-effective";

interface ContextState {
  rawEntries: Record<string, unknown>;
}

interface ContextRecord {
  readonly state: ContextState;
  readonly pipeline: ReturnType<typeof createResolutionPipeline>;
}

interface CapturedContext {
  readonly layer: string;
  readonly scopePath?: ScopeInstance[];
  readonly rawEntries: Record<string, unknown>;
}

interface RuntimeResolutionOptions {
  readonly getMergedState: (
    scopePath?: ScopeInstance[],
  ) => Record<string, unknown>;
  readonly secretBackend?: SecretBackend;
  readonly logger: WeaverLogger;
}

export interface RuntimeResolutionContexts {
  materialize(scopePath: ScopeInstance[]): void;
  resolve(scopePath?: ScopeInstance[]): Promise<Record<string, unknown>>;
  resolveSnapshot(scopePaths: ReadonlyArray<ScopeInstance[]>): Promise<{
    readonly base: ResolvedRuntimeProjectionContext;
    readonly scopes: ReadonlyArray<ResolvedRuntimeProjectionContext>;
  }>;
  publishMutation(
    service: WeaverConfigService,
    delta: ConfigDelta,
  ): Promise<void>;
  publishRegistration(
    service: WeaverConfigService,
    path: string,
  ): Promise<void>;
  onDelta(handler: (delta: ConfigDelta) => void): () => void;
  dispose(): Promise<void>;
}

const runtimeContexts = new WeakMap<
  WeaverConfigService,
  RuntimeResolutionContexts
>();

export function bindRuntimeResolutionContexts(
  service: WeaverConfigService,
  contexts: RuntimeResolutionContexts,
): void {
  runtimeContexts.set(service, contexts);
}

export async function disposeRuntimeResolutionContexts(
  service: WeaverConfigService,
): Promise<void> {
  await runtimeContexts.get(service)?.dispose();
  runtimeContexts.delete(service);
}

export function createRuntimeResolutionContexts(
  options: RuntimeResolutionOptions,
): RuntimeResolutionContexts {
  return new RuntimeResolutionContextManager(options);
}

class RuntimeResolutionContextManager implements RuntimeResolutionContexts {
  private readonly records = new Map<string, ContextRecord>();
  private readonly materialized = new Map<string, ScopeInstance[]>();
  private readonly handlers = new Set<(delta: ConfigDelta) => void>();
  private queue = Promise.resolve();

  constructor(private readonly options: RuntimeResolutionOptions) {}

  materialize(scopePath: ScopeInstance[]): void {
    if (scopePath.length === 0) return;
    this.materialized.set(formatScopePath(scopePath), [...scopePath]);
  }

  resolve(scopePath?: ScopeInstance[]): Promise<Record<string, unknown>> {
    const captured = this.capture(scopePath);
    return this.run(async () => (await this.resolveCaptured(captured)).entries);
  }

  resolveSnapshot(scopePaths: ReadonlyArray<ScopeInstance[]>): Promise<{
    readonly base: ResolvedRuntimeProjectionContext;
    readonly scopes: ReadonlyArray<ResolvedRuntimeProjectionContext>;
  }> {
    const base = this.capture();
    const scopes = scopePaths.map((scopePath) => this.capture(scopePath));
    return this.run(async () => ({
      base: await this.resolveCaptured(base),
      scopes: await Promise.all(
        scopes.map((item) => this.resolveCaptured(item)),
      ),
    }));
  }

  publishMutation(
    service: WeaverConfigService,
    delta: ConfigDelta,
  ): Promise<void> {
    const captures = this.affectedContexts(delta.layer);
    return this.publish(async () =>
      projectRuntimeMutation(
        service,
        delta,
        await Promise.all(captures.map((item) => this.resolveCaptured(item))),
      ),
    );
  }

  publishRegistration(
    service: WeaverConfigService,
    path: string,
  ): Promise<void> {
    const captures = this.affectedContexts();
    return this.publish(async () =>
      projectRuntimeRegistration(
        service,
        path,
        await Promise.all(captures.map((item) => this.resolveCaptured(item))),
      ),
    );
  }

  onDelta(handler: (delta: ConfigDelta) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    await this.run(async () => {
      for (const record of this.records.values()) {
        (await record.pipeline).dispose();
      }
      this.records.clear();
      this.materialized.clear();
      this.handlers.clear();
    });
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private capture(scopePath?: ScopeInstance[]): CapturedContext {
    return {
      layer: contextId(scopePath),
      ...(scopePath ? { scopePath } : {}),
      rawEntries: filterProtectedConfigEntries(
        this.options.getMergedState(scopePath),
      ),
    };
  }

  private affectedContexts(layer?: string): CapturedContext[] {
    const scope = layer ? parseScopeLayer(layer) : null;
    const captures: CapturedContext[] = [];
    if (scope === null) captures.push(this.capture());
    for (const scopePath of this.materialized.values()) {
      if (scope && !containsScope(scopePath, scope)) continue;
      captures.push(this.capture(scopePath));
    }
    return captures;
  }

  private async resolveCaptured(
    captured: CapturedContext,
  ): Promise<ResolvedRuntimeProjectionContext> {
    const record = this.contextRecord(captured);
    record.state.rawEntries = captured.rawEntries;
    const pipeline = await record.pipeline;
    pipeline.rebuildMountMap();
    await pipeline.refreshSecrets(captured.rawEntries);
    const resolved = pipeline.resolveEntries(
      captured.rawEntries,
      "",
      captured.rawEntries,
    );
    return {
      layer: captured.layer,
      ...(captured.scopePath ? { scopePath: captured.scopePath } : {}),
      entries: removeUnresolvedMarkers(resolved),
    };
  }

  private contextRecord(captured: CapturedContext): ContextRecord {
    const current = this.records.get(captured.layer);
    if (current) return current;
    const state = { rawEntries: captured.rawEntries };
    const record = {
      state,
      pipeline: createResolutionPipeline({
        getMergedState: () => state.rawEntries,
        getBaseEntries: () => state.rawEntries,
        ...(this.options.secretBackend
          ? { secretBackend: this.options.secretBackend }
          : {}),
      }),
    };
    this.records.set(captured.layer, record);
    return record;
  }

  private dispatch(deltas: ReadonlyArray<ConfigDelta>): void {
    for (const delta of deltas) {
      for (const handler of [...this.handlers]) {
        try {
          handler(delta);
        } catch (error: unknown) {
          this.logError("[config] delta listener failed:", error);
        }
      }
    }
  }

  private async publish(
    job: () => Promise<ReadonlyArray<ConfigDelta>>,
  ): Promise<void> {
    try {
      await this.run(async () => this.dispatch(await job()));
    } catch (error: unknown) {
      this.logError("[config] runtime projection failed:", error);
    }
  }

  private logError(message: string, error: unknown): void {
    try {
      this.options.logger.error(message, error);
    } catch {
      // Logging must not change committed write semantics.
    }
  }
}

function contextId(scopePath?: ScopeInstance[]): string {
  return scopePath?.length ? formatScopePath(scopePath) : EFFECTIVE_BASE_LAYER;
}

function containsScope(
  scopePath: ReadonlyArray<ScopeInstance>,
  scope: { readonly scopeId: string; readonly value: string },
): boolean {
  return scopePath.some(
    (item) => item.scopeId === scope.scopeId && item.value === scope.value,
  );
}

function removeUnresolvedMarkers(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) => {
      const resolved = removeUnresolvedValue(value);
      return resolved === undefined ? [] : [[key, resolved]];
    }),
  );
}

function removeUnresolvedValue(value: unknown): unknown {
  if (isConfigMount(value) || isSecretReference(value)) return undefined;
  if (Array.isArray(value)) return value.map(removeUnresolvedValue);
  if (value === null || typeof value !== "object") return value;
  return removeUnresolvedMarkers(Object.fromEntries(Object.entries(value)));
}
