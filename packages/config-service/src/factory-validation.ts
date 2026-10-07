import { createRegistryAdapter } from "@weaver-conf/config-registry/internal/server-adapter";
import { parsePersistedRegistry } from "@weaver-conf/config-registry/persistence";
import {
  type ConfigurationServiceOptions,
  configurationServiceOptionsSchema,
  createWeaverError,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import {
  invalidHost,
  validateAuthLayers,
} from "./authority/authority-contract-capture";
import { captureWriters } from "./authority/provider-write";
import { rejectCeilings } from "./ceiling-presence";
import { selectBindings, validateStack } from "./layer-stack";
import { captureBinding } from "./provider-binding";
import {
  type ConfigurationServiceHostOptions,
  configurationServiceHostOptionsSchema,
} from "./service-host";

const unsupportedKeys = [
  "merge",
  "strategy",
  "customMerge",
  "trustedEmergency",
  "emergency",
];
function rejectUnsupported(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  for (const key of unsupportedKeys)
    if (Object.hasOwn(input, key))
      throw createWeaverError(
        "UNSUPPORTED_OPERATION",
        "Custom resolution options are unsupported",
      );
}
function parseOptions(
  input: ConfigurationServiceOptions,
): ConfigurationServiceOptions {
  rejectUnsupported(input);
  const parsed = configurationServiceOptionsSchema.safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.some(
      (issue) =>
        issue.code === "unrecognized_keys" &&
        issue.keys.some((key) => unsupportedKeys.includes(key)),
    );
    throw createWeaverError(
      unsupported ? "UNSUPPORTED_OPERATION" : "VALIDATION_ERROR",
      "Invalid configuration service options",
    );
  }
  return parsed.data;
}
export function validateFactory(
  input: ConfigurationServiceOptions,
  hostInput?: ConfigurationServiceHostOptions,
) {
  try {
    const options = parseOptions(input);
    const host = configurationServiceHostOptionsSchema.parse(
      hostInput === undefined ? {} : hostInput,
    );
    validateStack(options);
    validateHost(host, options);
    const captured = options.providers.map(captureBinding);
    validateWatchOwnership(captured);
    const writers = captureWriters(captured, host.writers, options.identity);
    const selected = selectBindings(options, captured, options.identity);
    const adapter = registerSchemas(options, host);
    const registryStorage = selectRegistryStorage(host, selected);
    if (
      registryStorage &&
      options.schemas.length &&
      !writers.has(registryStorage.captured)
    )
      throw createWeaverError(
        "WRITE_UNAVAILABLE",
        "Registry seed storage is read-only",
      );
    return {
      options,
      captured,
      writers,
      selected,
      registry: adapter.reader,
      adapter,
      registryStorage,
      host,
    };
  } catch (error) {
    if (error instanceof WeaverErrorInstance) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      Object.hasOwn(error, "code")
    )
      throw error;
    throw createWeaverError("VALIDATION_ERROR", "Invalid factory capabilities");
  }
}

function validateWatchOwnership(
  captured: readonly ReturnType<typeof captureBinding>[],
): void {
  const watched = captured
    .filter((item) => item.watch)
    .map((item) => item.binding.provider);
  if (new Set(watched).size !== watched.length) invalidHost();
}

function selectRegistryStorage(
  host: ConfigurationServiceHostOptions,
  selected: ReturnType<typeof selectBindings>,
) {
  const storage = host.registry?.storage;
  if (storage?.kind !== "provider") return undefined;
  const binding = selected.find(
    (item) => item.captured.binding.id === storage.providerId,
  );
  if (binding?.kind !== "fixed") invalidHost();
  return binding;
}

function validateHost(
  host: ConfigurationServiceHostOptions,
  options: ConfigurationServiceOptions,
): void {
  if (host.registry?.initial !== undefined && options.schemas.length)
    invalidHost();
  if (host.authConfig)
    validateAuthLayers(
      host.authConfig,
      options.layers.map((slot) => slot.layer),
    );
}
function registerSchemas(
  options: ConfigurationServiceOptions,
  host: ConfigurationServiceHostOptions,
) {
  const registry = createRegistryAdapter(
    {
      defaultEnvironment: options.identity.environment,
      ...(host.registry?.schemaIdentityMaxPageSize === undefined
        ? {}
        : {
            schemaIdentityMaxPageSize: host.registry.schemaIdentityMaxPageSize,
          }),
    },
    parsePersistedRegistry(host.registry?.initial),
  );
  for (const request of options.schemas) {
    const prepared = registry.prepare(request);
    const result = prepared.result;
    if (!result.success)
      throw createWeaverError(
        result.error?.code ?? "VALIDATION_ERROR",
        "Schema registration failed",
      );
    prepared.publish();
  }
  for (const request of options.schemas) rejectCeilings(request.schema);
  for (const entry of registry.snapshot().schemas.values())
    rejectCeilings(entry.schema);
  return registry;
}
