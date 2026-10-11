import {
  assertPublicConfigPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import { createWeaverError } from "@weaver-conf/config-types";
import type { SchemaIdentityPages } from "./identity-pages";
import type {
  CanonicalSchemaRegistryReader,
  RegisteredSchemaAnchor,
  RegistryProjectionReader,
} from "./registry-contracts";
import {
  type RegistryState,
  type SchemaEntry,
  schemaKey,
} from "./registry-state";

export function createRegistryReader(
  state: () => RegistryState,
  pages: SchemaIdentityPages,
  defaultEnvironment: string,
): CanonicalSchemaRegistryReader {
  return {
    ...createRegistryProjectionReader(state, defaultEnvironment),
    getSchema(serviceId, environment) {
      try {
        const { servicePath } = deriveServicePath(serviceId);
        return structuredClone(
          state().schemas.get(schemaKey(servicePath, environment))?.schema ??
            null,
        );
      } catch {
        return null;
      }
    },
    listAll() {
      return structuredClone(listSchemas(state()));
    },
    listRegisteredSchemaIdentityPage(input) {
      return pages.page(input);
    },
    getRegisteredSchema(path, environment) {
      const entry = state().schemas.get(schemaKey(path, environment));
      return entry?.path === path && entry.environment === environment
        ? registeredAnchorFromEntry(entry)
        : null;
    },
  };
}

export function createRegistryProjectionReader(
  state: () => RegistryState,
  defaultEnvironment: string,
): RegistryProjectionReader {
  return Object.freeze({
    resolveAnchor(path: string, environment?: string) {
      return findRegisteredAnchor(
        state().schemas.values(),
        path,
        environment ?? defaultEnvironment,
      );
    },
    listRegisteredSchemaIdentities() {
      return structuredClone(listSchemaIdentities(state()));
    },
  });
}

export function listSchemas(state: RegistryState) {
  const result: Record<string, SchemaEntry["schema"]> = {};
  for (const entry of state.schemas.values()) {
    const key = `${entry.path}:${entry.environment}`;
    if (Object.hasOwn(result, key)) {
      throw createWeaverError(
        "SCHEMA_CONFLICT",
        `Ambiguous legacy schema registry key "${key}"; use exact identity/detail lookup`,
      );
    }
    result[key] = entry.schema;
  }
  return result;
}

// Identity projections never traverse schema bodies.
export function listSchemaIdentities(state: RegistryState) {
  return {
    anchors: [...state.schemas.values()].map(({ kind, path, environment }) => ({
      kind,
      path,
      environment,
    })),
    slots: [...state.slots.values()].map(
      ({ canonicalSlotPath, environment, accepts }) => ({
        kind: "slot" as const,
        path: canonicalSlotPath,
        environment,
        accepts,
      }),
    ),
  };
}

function findRegisteredAnchor(
  entries: Iterable<SchemaEntry>,
  path: string,
  environment: string,
): RegisteredSchemaAnchor | null {
  const normalizedPath = normalizeAnchorLookupPath(path);
  if (normalizedPath === null) return null;
  let match: SchemaEntry | null = null;
  for (const entry of entries) {
    if (entry.environment !== environment) continue;
    if (!isAnchorPathMatch(entry.path, normalizedPath)) continue;
    if (match === null || entry.path.length > match.path.length) match = entry;
  }
  return match === null ? null : registeredAnchorFromEntry(match);
}

function registeredAnchorFromEntry(entry: SchemaEntry): RegisteredSchemaAnchor {
  return {
    kind: entry.kind,
    path: entry.path,
    schema: structuredClone(entry.schema),
    environment: entry.environment,
    metadata: structuredClone(entry.metadata),
  };
}

function isAnchorPathMatch(anchorPath: string, path: string): boolean {
  return path === anchorPath || path.startsWith(`${anchorPath}/`);
}

function normalizeAnchorLookupPath(path: string): string | null {
  try {
    return assertPublicConfigPath(path);
  } catch {
    return null;
  }
}
