import type { ConfigurationServiceHostOptions } from "@weaver-conf/config-service";
import {
  type ConfigurationServiceOptions,
  type ConfigurationServiceProviderBinding,
  captureServiceData,
  configurationLayerDataSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { z } from "zod";

const selectionSchema = z.strictObject({
  providerId: z.string().min(1),
  layer: z.string().min(1),
});
type Selection = z.infer<typeof selectionSchema>;

/** Capture before ownership transfer; executing the returned loader performs IO. */
export function captureAuthorityRegistryLoader(
  configuration: ConfigurationServiceOptions,
  selection: Selection,
  schemaIdentityMaxPageSize = 200,
): () => Promise<NonNullable<ConfigurationServiceHostOptions["registry"]>> {
  const parsed = selectionSchema.safeParse(selection);
  if (!parsed.success) return invalidBinding();
  const binding = selectBinding(configuration, parsed.data);
  const load = captureLoad(binding);
  const pageSize = z.number().int().min(50).max(Number.MAX_SAFE_INTEGER);
  if (!pageSize.safeParse(schemaIdentityMaxPageSize).success)
    return invalidBinding();
  return async () => ({
    initial: await loadRegistry(load),
    storage: { kind: "provider", providerId: parsed.data.providerId },
    schemaIdentityMaxPageSize,
  });
}

function invalidBinding(): never {
  throw createWeaverError("VALIDATION_ERROR", "Invalid registry binding");
}

function selectBinding(
  configuration: ConfigurationServiceOptions,
  selection: Selection,
): ConfigurationServiceProviderBinding {
  const bindings = configuration.providers.filter(
    (binding) => binding.id === selection.providerId,
  );
  const binding = bindings[0];
  const slots = configuration.layers.filter(
    (slot) =>
      slot.kind !== "session" &&
      slot.providerIds.includes(selection.providerId),
  );
  const slot = slots[0];
  if (
    bindings.length !== 1 ||
    !binding ||
    slots.length !== 1 ||
    !slot ||
    slot.kind !== "fixed" ||
    slot.layer !== selection.layer ||
    binding.layer !== selection.layer ||
    (binding.scopePath?.length ?? 0) !== 0
  )
    return invalidBinding();
  if (
    binding.environment.kind === "environments" &&
    !binding.environment.environments.includes(
      configuration.identity.environment,
    )
  )
    return invalidBinding();
  return binding;
}

function member(provider: object, key: string): unknown {
  let current: object | null = provider;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor)) return invalidBinding();
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function captureLoad(
  binding: ConfigurationServiceProviderBinding,
): () => Promise<unknown> {
  const { provider, operation } = binding;
  if (
    member(provider, "id") !== binding.id ||
    member(provider, "layer") !== binding.layer
  )
    return invalidBinding();
  if (operation.kind === "read")
    throw createWeaverError(
      "UNSUPPORTED_OPERATION",
      "Registry bootstrap requires a fixed storage loader",
    );
  const key = operation.kind === "load" ? "load" : "loadLayer";
  const method = z
    .custom<(...args: string[]) => Promise<unknown>>(
      (value) => typeof value === "function",
    )
    .safeParse(member(provider, key));
  if (!method.success) return invalidBinding();
  const args = operation.kind === "load" ? [] : [operation.layer];
  return () => Reflect.apply(method.data, provider, args);
}

function ownField(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function loadRegistry(load: () => Promise<unknown>): Promise<unknown> {
  const layer = await loadLayer(load);
  const internal = ownField(layer.entries, "_weaver");
  const registry = ownField(internal, "registry");
  if (
    registry === undefined &&
    !(
      internal !== null &&
      typeof internal === "object" &&
      Object.hasOwn(internal, "registry")
    )
  )
    return undefined;
  const raw = ownField(registry, "schemas");
  if (raw === undefined || ownField(raw, "environments") === undefined)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Persisted registry metadata is unavailable",
    );
  return raw;
}

async function loadLayer(load: () => Promise<unknown>) {
  let raw: unknown;
  try {
    raw = await load();
  } catch {
    throw createWeaverError("SERVER_DEGRADED", "Registry storage unavailable");
  }
  const captured = captureServiceData(raw);
  const parsed = configurationLayerDataSchema.safeParse(
    captured.success ? captured.value : undefined,
  );
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid registry layer data");
  return parsed.data;
}
