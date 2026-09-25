import type { WeaverError } from "./errors";
import type { ConfigurationPropertySchema } from "./property-schema";

/** Accountable owner contact metadata for schema registrations. */
export interface RegistrationOwner {
  readonly name: string;
  readonly contact: string;
}

/** Service-owned fragment slot declaration. */
export interface FragmentSlotDeclaration {
  readonly slotPath: string;
  readonly accepts: "object";
}

export interface SchemaRegistrationAuditMetadata {
  readonly subject?: string | undefined;
  readonly actor?: string | undefined;
}

/** Path-first service schema registration request. */
export interface ServiceSchemaRegistrationRequest {
  readonly serviceId: string;
  readonly environment: string;
  readonly owner: RegistrationOwner;
  readonly schema: ConfigurationPropertySchema;
  readonly schemaVersion?: string | undefined;
  readonly fragmentSlots: ReadonlyArray<FragmentSlotDeclaration>;
}

/** Path-first fragment schema registration request. */
export interface FragmentSchemaRegistrationRequest {
  readonly serviceId: string;
  readonly providerId: string;
  readonly slotPath: string;
  readonly environment: string;
  readonly owner: RegistrationOwner;
  readonly schema: ConfigurationPropertySchema;
  readonly schemaVersion?: string | undefined;
}

export interface FragmentSlotRegistrationMetadata {
  readonly serviceId: string;
  readonly servicePath: string;
  readonly slotPath: string;
  readonly canonicalSlotPath: string;
  readonly environment: string;
  readonly providerId: string;
  readonly owner: RegistrationOwner;
  readonly accepts: "object";
  readonly schemaVersion?: string | undefined;
  readonly audit?: SchemaRegistrationAuditMetadata | undefined;
}

export type SchemaRegistrationRequest =
  | ServiceSchemaRegistrationRequest
  | FragmentSchemaRegistrationRequest;

/** Canonical path metadata derived from a schema registration request. */
export interface SchemaRegistrationMetadata {
  readonly serviceId: string;
  readonly servicePath: string;
  readonly environment: string;
  readonly providerId: string;
  readonly owner: RegistrationOwner;
  readonly schemaVersion?: string | undefined;
  readonly canonicalSlotPath?: string | undefined;
  readonly fragmentPath?: string | undefined;
  readonly audit?: SchemaRegistrationAuditMetadata | undefined;
}

/** Result returned by path-first schema registration endpoints. */
export interface SchemaRegistrationResponse {
  readonly success: boolean;
  readonly isNewSchema: boolean;
  readonly hasBreakingChanges: boolean;
  readonly metadata?: SchemaRegistrationMetadata | undefined;
  readonly breakingChanges?: ReadonlyArray<string> | undefined;
  readonly error?: WeaverError | undefined;
}
