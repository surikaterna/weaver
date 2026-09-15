import {
  createWeaverError,
  defineWeaver,
  getBuiltinCatalogSource,
  type InternalCatalog,
  type InternalLayout,
  Layers,
  type ObjectConfigurationPropertySchema,
} from "@weaver-conf/config-types";
import { compileBuiltinContract } from "./builtin-contract";
import { immutableSchemaMap } from "./immutable-schema-map";
import { deepMerge } from "./merge";
import { deriveServicePath } from "./registration-paths";
import { composeRegisteredServiceSchema } from "./schema-slot-composition";

const source = getBuiltinCatalogSource();
const parseCatalog = compileBuiltinContract(source.contracts.catalog);
const parseLayout = compileBuiltinContract(source.contracts.layout);

/** Independent of the runtime registry: derive all application anchors from validated records. */
export function compileInternalRegistrations(
  input: InternalCatalog,
): ReadonlyMap<string, ObjectConfigurationPropertySchema> {
  const catalog = parseCatalog(input);
  const records = Object.values(catalog.registrations);
  const services = records.filter((record) => record.kind === "service");
  const fragments = records.filter((record) => record.kind === "fragment");
  const compiled = new Map<string, ObjectConfigurationPropertySchema>();
  for (const fragment of fragments) {
    if (
      !services.some(
        (service) =>
          service.request.serviceId === fragment.request.serviceId &&
          service.request.environment === fragment.request.environment,
      )
    )
      throw createWeaverError("VALIDATION_ERROR", "Orphan catalog fragment");
  }
  for (const service of services) {
    const children = fragments.filter(
      (fragment) =>
        fragment.request.serviceId === service.request.serviceId &&
        fragment.request.environment === service.request.environment,
    );
    const schema = composeRegisteredServiceSchema(
      service.request,
      children.map((child) => child.request),
    );
    compiled.set(
      `${deriveServicePath(service.request.serviceId).servicePath}:${service.request.environment}`,
      schema,
    );
  }
  return immutableSchemaMap(compiled);
}

/** Compile the existing LayerDefinition model; this binds no provider and performs no I/O. */
export function compileInternalLayout(input: InternalLayout) {
  const layout = parseLayout(input);
  const definitions = layout.layers.map((layer) => {
    if (layer.type === "static")
      return Layers.Static(layer.name, { merge: mergeInternalLayers });
    if (layer.type === "dynamic") {
      return Layers.Dynamic(layer.name, {
        merge: mergeInternalLayers,
        scopes: layer.config.scopeIds.flatMap((id) =>
          layout.scopes.filter((scope) => scope.id === id),
        ),
      });
    }
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Layer type ${layer.type} has no installed resolver support`,
    );
  });
  return defineWeaver(definitions);
}

function mergeInternalLayers(
  base: unknown,
  override: unknown,
): Record<string, unknown> {
  if (
    base === null ||
    override === null ||
    typeof base !== "object" ||
    typeof override !== "object" ||
    Array.isArray(base) ||
    Array.isArray(override)
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Layer snapshots must be objects",
    );
  return deepMerge(
    Object.fromEntries(Object.entries(base)),
    Object.fromEntries(Object.entries(override)),
  );
}
