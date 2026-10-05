import type { AuthConfig } from "@weaver-conf/config-auth";
import {
  captureServiceData,
  createWeaverError,
  layerWritePolicySchema,
  type WeaverConfig,
} from "@weaver-conf/config-types";
import { z } from "zod";

export function invalidHost(): never {
  throw createWeaverError("VALIDATION_ERROR", "Invalid configuration host");
}
export function ownRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return invalidHost();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    return invalidHost();
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !field?.enumerable || !("value" in field))
      return invalidHost();
    Object.defineProperty(output, key, {
      value: field.value,
      enumerable: true,
    });
  }
  return output;
}
/** Trusted executable ports may be class instances, but getters are not ports. */
export function portMember(input: object, key: string): unknown {
  let current: object | null = input;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor)) return invalidHost();
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
export function capturePort(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object") return invalidHost();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const method = portMember(input, key);
    if (typeof method !== "function") return invalidHost();
    Object.defineProperty(output, key, {
      value: Function.prototype.bind.call(method, input),
      enumerable: true,
    });
  }
  return output;
}
export function captureData(input: unknown): unknown {
  const captured = captureServiceData(input);
  if (!captured.success) return invalidHost();
  return captured.value;
}
const roleSetSchema = z
  .custom<ReadonlySet<string>>(
    (value) =>
      value instanceof Set &&
      Object.getPrototypeOf(value) === Set.prototype &&
      Reflect.ownKeys(value).length === 0,
  )
  .transform((value) => new Set(z.array(z.string()).parse([...value])));
const weaverSchema = z.custom<WeaverConfig>((value) => {
  if (!value || typeof value !== "object") return false;
  return ["getRank", "getLayer", "getLayersByType"].every(
    (key) => typeof portMember(value, key) === "function",
  );
});
const authSchema = z.strictObject({
  weaverConfig: weaverSchema,
  visibilityRoles: z.strictObject({
    admin: roleSetSchema,
    platform: roleSetSchema,
  }),
  layerWritePolicies: z.array(layerWritePolicySchema).readonly(),
  dynamicScopeRoles: roleSetSchema,
  sessionLayer: z.string().min(1).optional(),
  elevatedSessionMode: z.string().min(1).optional(),
});
export function captureAuthConfig(input: unknown): AuthConfig {
  const fields = ownRecord(input);
  const parsed = authSchema.parse({
    ...fields,
    visibilityRoles: ownRecord(fields.visibilityRoles),
    layerWritePolicies: captureData(fields.layerWritePolicies),
  });
  return { ...parsed, weaverConfig: captureWeaver(parsed.weaverConfig) };
}
function captureWeaver(input: WeaverConfig): WeaverConfig {
  const methods = capturePort(input, [
    "getRank",
    "getLayer",
    "getLayersByType",
  ]);
  const callable = <T>() => z.custom<T>((value) => typeof value === "function");
  return {
    layers: z
      .custom<WeaverConfig["layers"]>(Array.isArray)
      .parse(captureData(portMember(input, "layers"))),
    rankMap: new Map(
      z
        .custom<ReadonlyMap<string, number>>(
          (value) =>
            value instanceof Map &&
            Object.getPrototypeOf(value) === Map.prototype &&
            Reflect.ownKeys(value).length === 0,
        )
        .parse(portMember(input, "rankMap")),
    ),
    layerNames: z
      .array(z.string().min(1))
      .readonly()
      .parse(captureData(portMember(input, "layerNames"))),
    getRank: callable<WeaverConfig["getRank"]>().parse(methods.getRank),
    getLayer: callable<WeaverConfig["getLayer"]>().parse(methods.getLayer),
    getLayersByType: callable<WeaverConfig["getLayersByType"]>().parse(
      methods.getLayersByType,
    ),
  };
}
export function validateAuthLayers(
  config: AuthConfig,
  layers: readonly string[],
): void {
  const names = config.weaverConfig.layerNames;
  if (
    names.length !== layers.length ||
    names.some(
      (name, rank) =>
        name !== layers[rank] || config.weaverConfig.getRank(name) !== rank,
    )
  )
    invalidHost();
  if (
    config.sessionLayer !== undefined &&
    !layers.includes(config.sessionLayer)
  )
    invalidHost();
  const seen = new Set<string>();
  for (const policy of config.layerWritePolicies) {
    if (
      !layers.includes(policy.layer) ||
      seen.has(policy.layer) ||
      policy.constraints?.length
    )
      invalidHost();
    seen.add(policy.layer);
  }
}
