import {
  type ConfigurationPropertySchema,
  publicConfigPathSchema,
  type RegisteredEffectiveValidationResponse,
  type SchemaRegistrationRequest,
  type SchemaRegistrationResponse,
  type ScopeDefinition,
  type ScopeInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import { type RefinementCtx, z } from "zod";
import type {
  ConfigDelta,
  ConfigSnapshot,
  GetOptions,
  ResolveOptions,
  Unsubscribe,
} from "./types";

/** Options for write operations — target layer, environment, and optimistic concurrency. */
export interface WriteOptions {
  layer?: string;
  environment?: string;
  ifRevision?: string;
}

export type { WriteResult };

export interface EffectiveValidationOptions {
  readonly anchorPath: string;
  readonly environment?: string | undefined;
  readonly scopePath?: readonly ScopeInstance[] | undefined;
}

const forbiddenOptionKeys = new Set(["__proto__", "constructor", "prototype"]);
const optionRecordSchema = z.unknown().superRefine(validateOptionRecord);
const scopeWirePartSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(":") && !value.includes(","), {
    message: "Scope components cannot contain ':' or ','",
  });
const httpScopeInstanceSchema = optionRecordSchema.pipe(
  z.strictObject({
    scopeId: scopeWirePartSchema,
    value: scopeWirePartSchema,
  }),
);

export const effectiveValidationOptionsSchema: z.ZodType<EffectiveValidationOptions> =
  optionRecordSchema.pipe(
    z.strictObject({
      anchorPath: publicConfigPathSchema,
      environment: z.string().min(1).optional(),
      scopePath: z.array(httpScopeInstanceSchema).readonly().optional(),
    }),
  );

function validateOptionRecord(value: unknown, context: RefinementCtx): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    context.addIssue({ code: "custom", message: "Options must be an object" });
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    context.addIssue({
      code: "custom",
      message: "Options must use a plain prototype",
    });
  }
  for (const key of Reflect.ownKeys(value))
    validateOptionKey(value, key, context);
}

function validateOptionKey(
  value: object,
  key: PropertyKey,
  context: RefinementCtx,
): void {
  const path = [typeof key === "symbol" ? key.toString() : key];
  if (typeof key !== "string" || forbiddenOptionKeys.has(key)) {
    context.addIssue({
      code: "custom",
      path,
      message: "Option property is not allowed",
    });
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    context.addIssue({
      code: "custom",
      path,
      message: "Options require enumerable data properties",
    });
  } else if (descriptor.value === undefined) {
    context.addIssue({
      code: "custom",
      path,
      message: "Present option properties cannot be undefined",
    });
  }
}

/**
 * Transport interface for communicating with a Weaver configuration backend.
 * Implementations handle reads, writes, subscriptions, scopes, and schema operations.
 */
export interface WeaverTransport {
  // Reads
  resolveAll(options?: ResolveOptions): Promise<ConfigSnapshot>;
  get(key: string, options?: GetOptions): Promise<unknown>;
  getNamespace(
    prefix: string,
    options?: GetOptions,
  ): Promise<Record<string, unknown>>;
  inspect(key: string): Promise<unknown>;
  subscribe(handler: (delta: ConfigDelta) => void): Unsubscribe;

  // Writes
  set(
    key: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  setMany(
    entries: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  remove(key: string, options?: WriteOptions): Promise<WriteResult>;

  // Scopes
  listScopes(): Promise<ScopeDefinition[]>;
  listScopeValues(
    scopeId: string,
    parentScope?: ScopeInstance[],
  ): Promise<string[]>;

  // Schemas
  fetchSchemas?(): Promise<Record<string, ConfigurationPropertySchema>>;
  registerSchema?(
    request: SchemaRegistrationRequest,
  ): Promise<SchemaRegistrationResponse>;
  setRegisteredObject?(
    anchorPath: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  patchRegisteredPath?(
    path: string,
    value: unknown,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  validateRegisteredEffective?(
    options: EffectiveValidationOptions,
  ): Promise<RegisteredEffectiveValidationResponse>;

  // Lifecycle
  close(): Promise<void>;
}
