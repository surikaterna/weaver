import type {
  ConfigurationPropertySchema,
  ConfigurationRole,
} from "./property-schema";
import type { ConfigurationLayer, ScopeInstance } from "./types";

/** Identity and role context for evaluating configuration access permissions. */
export interface ConfigurationAccessContext {
  userId: string;
  roles: ReadonlyArray<ConfigurationRole>;
  assignedScopes?: ReadonlyArray<ScopeInstance> | undefined;
  /** Host-verified policy input; never a native authority credential. */
  readonly trustedSession?:
    | {
        readonly id: string;
        readonly emergency: boolean;
        readonly reason: string;
      }
    | undefined;
}

/** Constraint applied to a layer write policy (e.g., scope or user restriction). */
export interface LayerWriteConstraint {
  scopeRestriction?: "own-scope" | "own-user" | undefined;
}

/** Defines which roles may write to a specific layer, with optional constraints. */
export interface LayerWritePolicy {
  layer: ConfigurationLayer | string;
  allowedRoles: ReadonlyArray<ConfigurationRole>;
  constraints?: ReadonlyArray<LayerWriteConstraint> | undefined;
}

/** A fragment of configuration schema owned by a specific team or service. */
export interface ConfigurationSchemaFragment {
  readonly description: string;
  readonly schemaVersion: number;
  readonly owner: string;
  readonly configuration: ConfigurationPropertySchema;
}

/** Full declaration of a service's configuration needs — schema, namespaces, and access. */
export interface ServiceConfigurationDeclaration {
  readonly serviceId: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly owner: string;
  readonly namespaces?: ReadonlyArray<string> | undefined;
  readonly configuration: ConfigurationPropertySchema;
  readonly reads?: ReadonlyArray<string> | undefined;
  readonly fragments?:
    | Readonly<Record<string, ConfigurationSchemaFragment>>
    | undefined;
  readonly instanceConfig?:
    | {
        readonly instanceKey: string;
        readonly maxInstances?: number | undefined;
      }
    | undefined;
}

/** Access policy granting a service permission to specific namespaces and scopes. */
export interface ServiceAccessPolicy {
  readonly serviceId: string;
  readonly allowedNamespaces: ReadonlyArray<string>;
  readonly allowedReads: ReadonlyArray<string>;
  readonly allowedSecrets: boolean;
  readonly scopeAccess: "all" | ReadonlyArray<string>;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt?: string | undefined;
}
