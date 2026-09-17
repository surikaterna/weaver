import {
  deepRemove,
  deepSet,
  normalizeStorageWritePath,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import { WeaverErrorInstance } from "@weaver-conf/config-types";
import type { ConfigDelta } from "../types/index";
import type { ConfigAuthority } from "./config-authority";
import { snapshotMutationInput } from "./config-mutation-input";
import type { ValidatedCandidate } from "./config-pipeline";
import {
  internalOperationId,
  internalPermission,
} from "./config-service-internal";
import {
  prepareRegisteredObjectWrite,
  prepareRegisteredPatchWrite,
} from "./config-service-schema-writes";
import type {
  SchemaWriteContext,
  WeaverConfigService,
  WriteContext,
} from "./config-service-types";
import { hasScopedLayerIo } from "./config-service-write-state";
import {
  normalizeBatchEntries,
  validateBoundSetMany,
  validatePublicWrite,
} from "./schema-write-boundary";
import { normalizeScopeLayer, parseScopeLayer } from "./scope-utils";

const isInternal = internalPermission;

interface MutationHost {
  readonly service: () => WeaverConfigService;
  readonly environment: string;
  readonly authority: ConfigAuthority;
  readonly revision: () => string;
  readonly ready: (internal: boolean) => void;
  readonly validateCandidate: (
    provider: ConfigurationStorageProvider,
    layer: string,
    entries: Record<string, unknown>,
    internal: boolean,
    key: string,
    options?: WriteContext,
  ) => Promise<ValidatedCandidate | undefined>;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
  readonly getLayerValue: (layer: string, key: string) => Promise<unknown>;
  readonly layerEntries: (
    provider: ConfigurationStorageProvider,
    layer: string,
    dynamic: boolean,
  ) => Record<string, unknown>;
  readonly install: (
    provider: ConfigurationStorageProvider,
    layer: string,
    dynamic: boolean,
    entries: Record<string, unknown>,
    validation?: ValidatedCandidate,
    candidate?: Record<string, unknown>,
  ) => void;
  readonly publish: (
    delta: ConfigDelta,
    validation?: ValidatedCandidate,
  ) => Promise<void>;
  readonly autoFlush: () => void;
  readonly warn: (message: string) => void;
  readonly failedCommit: (
    provider: ConfigurationStorageProvider,
    message: string,
  ) => void;
}
interface Target {
  readonly provider: ConfigurationStorageProvider;
  readonly layer: string;
  readonly dynamic: boolean;
  readonly entries: Record<string, unknown>;
}
function failure(code: string, message: string): WriteResult {
  return { success: false, error: { code, message } };
}

/** Non-reentrant executors. The service coordinator covers preparation through publication. */
export class ConfigServiceMutations {
  constructor(private readonly host: MutationHost) {}
  private preflight(options?: WriteContext): WriteResult | null {
    try {
      this.host.ready(isInternal(options));
    } catch (error) {
      return failure(
        error instanceof WeaverErrorInstance ? error.code : "SERVER_DEGRADED",
        String(error),
      );
    }
    if (
      options?.expectedRevision !== undefined &&
      options.expectedRevision !== this.host.revision()
    )
      return failure(
        "REVISION_CONFLICT",
        `Revision conflict: expected ${options.expectedRevision}, current is ${this.host.revision()}`,
      );
    return null;
  }
  private async target(layer: string): Promise<Target | WriteResult> {
    const provider = this.host.resolveProvider(layer);
    if (!provider)
      return failure("LAYER_NOT_FOUND", `No provider for layer "${layer}"`);
    if (!provider.writable)
      return failure("READONLY", `Provider for layer "${layer}" is read-only`);
    const parsed = parseScopeLayer(layer);
    const dynamic = parsed !== null && provider.layer === parsed.scopeId;
    const canonical = normalizeScopeLayer(layer);
    if (dynamic && !hasScopedLayerIo(provider))
      return failure(
        "LAYER_NOT_FOUND",
        `Provider for base scope layer "${provider.layer}" does not support scoped writes for "${layer}"`,
      );
    try {
      if (parsed) await this.host.getLayerValue(layer, "");
    } catch (error) {
      return failure(
        error instanceof WeaverErrorInstance
          ? error.code
          : "PROVIDER_LOAD_FAILED",
        String(error),
      );
    }
    return {
      provider,
      layer: canonical,
      dynamic,
      entries: this.host.layerEntries(provider, canonical, dynamic),
    };
  }
  set(
    layer: string,
    key: string,
    value: unknown,
    options?: WriteContext,
  ): Promise<WriteResult> {
    return this.mutate(layer, key, value, false, options);
  }
  remove(
    layer: string,
    key: string,
    options?: WriteContext,
  ): Promise<WriteResult> {
    return this.mutate(layer, key, undefined, true, options);
  }
  private async mutate(
    layer: string,
    input: string,
    value: unknown,
    remove: boolean,
    options?: WriteContext,
  ): Promise<WriteResult> {
    try {
      return await this.executeMutation(layer, input, value, remove, options);
    } catch (error) {
      return failure(
        error instanceof WeaverErrorInstance ? error.code : "VALIDATION_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  private async executeMutation(
    layer: string,
    input: string,
    value: unknown,
    remove: boolean,
    options?: WriteContext,
  ): Promise<WriteResult> {
    const path = normalizeStorageWritePath(input);
    if (!path.ok) return { success: false, error: path.error };
    const key = path.value;
    const denial = internalPermission(options, key)
      ? null
      : validatePublicWrite(key);
    if (denial) return denial;
    const conflict = this.preflight(options);
    if (conflict) return conflict;
    const ownedValue = snapshotMutationInput(value);
    const target = await this.target(layer);
    if ("success" in target) return target;
    const entries = this.candidateEntries(target, key, ownedValue, remove);
    const validation = await this.host.validateCandidate(
      target.provider,
      target.layer,
      entries,
      isInternal(options),
      key,
      options,
    );
    const result = await this.commit(
      target,
      key,
      ownedValue,
      remove,
      entries,
      options,
      validation,
    );
    if (!result.success) return { ...result, revision: this.host.revision() };
    await this.publishCommitted(
      layer,
      key,
      ownedValue,
      remove,
      options,
      validation,
    );
    return { success: true, revision: this.host.revision() };
  }
  private async publishCommitted(
    layer: string,
    key: string,
    value: unknown,
    remove: boolean,
    options?: WriteContext,
    validation?: ValidatedCandidate,
  ): Promise<void> {
    if (!isInternal(options))
      await this.host.publish(
        {
          action: remove ? "remove" : "set",
          key,
          value: remove ? null : value,
          layer,
          environment: options?.environment ?? this.host.environment,
          timestamp: new Date().toISOString(),
        },
        validation,
      );
    this.host.autoFlush();
  }
  private candidateEntries(
    target: Target,
    key: string,
    value: unknown,
    remove: boolean,
  ): Record<string, unknown> {
    if (typeof value === "string" && value.length > 1_048_576)
      this.host.warn(
        `[weaver] Value for key "${key}" exceeds 1MB (${value.length} bytes)`,
      );
    const entries = structuredClone(target.entries);
    if (remove) deepRemove(entries, key);
    else deepSet(entries, key, value);
    return entries;
  }
  private async commit(
    target: Target,
    key: string,
    value: unknown,
    remove: boolean,
    candidate: Record<string, unknown>,
    options?: WriteContext,
    validation?: ValidatedCandidate,
  ): Promise<WriteResult> {
    try {
      const result = target.provider.authority
        ? await this.host.authority.commit(
            target.provider,
            target.layer,
            key,
            value,
            remove,
            internalOperationId(options),
          )
        : {
            result: await this.basicCommit(target, key, value, remove),
            snapshot: undefined,
          };
      if (!result.result.success) {
        if (result.result.error?.code === "COMMIT_OUTCOME_UNKNOWN")
          this.host.failedCommit(target.provider, result.result.error.message);
        return result.result;
      }
      this.host.install(
        target.provider,
        target.layer,
        target.dynamic,
        result.snapshot?.entries ?? candidate,
        validation,
        candidate,
      );
      return result.result;
    } catch (error) {
      this.host.failedCommit(target.provider, String(error));
      return failure(
        "COMMIT_OUTCOME_UNKNOWN",
        `Provider did not acknowledge the operation: ${String(error)}`,
      );
    }
  }
  private basicCommit(
    target: Target,
    key: string,
    value: unknown,
    remove: boolean,
  ): Promise<WriteResult> {
    if (target.dynamic && hasScopedLayerIo(target.provider))
      return remove
        ? target.provider.removeLayer(target.layer, key)
        : target.provider.writeLayer(target.layer, key, value);
    return remove
      ? target.provider.remove(key)
      : target.provider.write(key, value);
  }
  async setMany(
    layer: string,
    entries: Record<string, unknown>,
    options?: WriteContext,
  ): Promise<WriteResult> {
    const normalized = normalizeBatchEntries(entries);
    if (!normalized.success) return normalized.result;
    for (const key of Object.keys(normalized.entries)) {
      const denial = isInternal(options) ? null : validatePublicWrite(key);
      if (denial) return denial;
    }
    const conflict = this.preflight(options);
    if (conflict) return conflict;
    if (!Object.keys(normalized.entries).length)
      return { success: true, revision: this.host.revision() };
    const target = await this.target(layer);
    if ("success" in target) return target;
    const validation = isInternal(options)
      ? null
      : validateBoundSetMany(
          this.host.service(),
          normalized.entries,
          target.entries,
        );
    if (validation) return validation;
    const candidate = structuredClone(target.entries);
    for (const [key, value] of Object.entries(normalized.entries))
      deepSet(candidate, key, value);
    try {
      await this.host.validateCandidate(
        target.provider,
        target.layer,
        candidate,
        isInternal(options),
        Object.keys(normalized.entries)[0] ?? "",
      );
    } catch (error) {
      return failure("VALIDATION_ERROR", String(error));
    }
    const { expectedRevision: _expected, ...context } = options ?? {};
    for (const [key, value] of Object.entries(normalized.entries)) {
      const result = await this.mutate(layer, key, value, false, context);
      if (!result.success) return result;
    }
    return { success: true, revision: this.host.revision() };
  }
  async setRegisteredObject(
    layer: string,
    path: string,
    value: unknown,
    options: SchemaWriteContext,
  ): Promise<WriteResult> {
    const conflict = this.preflight(options);
    if (conflict) return conflict;
    const prepared = await prepareRegisteredObjectWrite(
      path,
      value,
      options,
      this.host.environment,
    );
    if (!prepared.success) return prepared.result;
    return this.set(layer, prepared.key, prepared.value, options);
  }
  async patchRegisteredPath(
    layer: string,
    path: string,
    value: unknown,
    options: SchemaWriteContext,
  ): Promise<WriteResult> {
    const conflict = this.preflight(options);
    if (conflict) return conflict;
    const prepared = await prepareRegisteredPatchWrite(
      path,
      value,
      options,
      this.host.environment,
      (key) => this.host.getLayerValue(layer, key),
    );
    if (!prepared.success) return prepared.result;
    return this.set(layer, prepared.key, prepared.value, options);
  }
}
