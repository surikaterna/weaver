import {
  type CanonicalSchemaRegistryReader,
  createCanonicalSchemaRegistry,
} from "@weaver-conf/config-registry";
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
    const writers = captureWriters(captured, host.writers, options.identity);
    const selected = selectBindings(options, captured, options.identity);
    const registry = host.registry ?? registerSchemas(options);
    const signature = registrySignature(registry, true);
    const assertRegistryStable = () => {
      if (host.registry && registrySignature(registry, false) !== signature)
        throw createWeaverError("FORBIDDEN", "Configuration registry changed");
    };
    return {
      options,
      captured,
      writers,
      selected,
      registry,
      host,
      assertRegistryStable,
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

function validateHost(
  host: ConfigurationServiceHostOptions,
  options: ConfigurationServiceOptions,
): void {
  if (host.registry && options.schemas.length) invalidHost();
  if (
    (host.hostAuthority || host.onAuthorityReady) &&
    (!host.hostAuthority || !host.authConfig)
  )
    invalidHost();
  if (host.authConfig)
    validateAuthLayers(
      host.authConfig,
      options.layers.map((slot) => slot.layer),
    );
}
function registerSchemas(
  options: ConfigurationServiceOptions,
): CanonicalSchemaRegistryReader {
  const registry = createCanonicalSchemaRegistry({
    defaultEnvironment: options.identity.environment,
  });
  for (const request of options.schemas) {
    const result = registry.register(request);
    if (!result.success)
      throw (
        result.error ??
        createWeaverError("VALIDATION_ERROR", "Schema registration failed")
      );
  }
  for (const request of options.schemas) rejectCeilings(request.schema);
  return registry;
}
function registrySignature(
  registry: CanonicalSchemaRegistryReader,
  checkCeilings: boolean,
): string {
  const identities = registry.listRegisteredSchemaIdentities();
  const details = identities.anchors.map((identity) => {
    const detail = registry.getRegisteredSchema(
      identity.path,
      identity.environment,
    );
    if (!detail) invalidHost();
    if (checkCeilings) rejectCeilings(detail.schema);
    return detail;
  });
  return JSON.stringify([identities, details]);
}
