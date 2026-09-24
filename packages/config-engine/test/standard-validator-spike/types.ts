import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import type {
  SchemaValidationError,
  SchemaValidationOptions,
  SchemaValidationPathSegment,
  SchemaValidationResult,
} from "../../src/schema-validation.js";

export type SpikeMode = "partial" | "effective";
export type AdapterId =
  | "baseline"
  | "cfworker"
  | "ajv-runtime"
  | "ajv-standalone";

export interface RawError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly message: string;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  readonly schemaPath?: string | undefined;
}

export interface AdapterCapabilities {
  readonly composition: boolean;
  readonly dynamicSchemas: boolean;
  readonly interpreted: boolean;
  readonly runtimeCodeGeneration: boolean;
}

export interface ValidationObservation {
  readonly normalized: SchemaValidationResult;
  readonly raw: readonly unknown[];
  readonly threw?: string | undefined;
}

export interface CompiledValidation {
  readonly compileMs: number;
  validate(value: unknown): ValidationObservation;
}

export interface ValidatorAdapter {
  readonly id: AdapterId;
  readonly version: string;
  readonly capabilities: AdapterCapabilities;
  compile(
    schema: ConfigurationPropertySchema,
    mode: SpikeMode,
  ): CompiledValidation;
  validatePatch(
    schema: ConfigurationPropertySchema,
    path: string | readonly SchemaValidationPathSegment[],
    value: unknown,
    options?: SchemaValidationOptions,
  ): ValidationObservation;
  reset(): void;
  register(id: string, schema: ConfigurationPropertySchema): number;
  validateRegistered(
    id: string,
    value: unknown,
    mode: SpikeMode,
  ): ValidationObservation;
}

export interface Fixture {
  readonly id: string;
  readonly category: string;
  readonly schema: ConfigurationPropertySchema;
  readonly value: unknown;
  readonly mode?: SpikeMode | undefined;
  readonly patch?:
    | {
        readonly path: string | readonly SchemaValidationPathSegment[];
        readonly options?: SchemaValidationOptions | undefined;
      }
    | undefined;
  readonly expectedValid: boolean;
  readonly expectedFirst?:
    | Pick<SchemaValidationError, "code" | "path">
    | undefined;
  readonly admitted?: boolean | undefined;
  readonly dynamic?: boolean | undefined;
  readonly security?: boolean | undefined;
}

export interface MatrixCell {
  readonly adapter: AdapterId;
  readonly valid: boolean;
  readonly normalizedParity: boolean;
  readonly raw: readonly unknown[];
  readonly normalized: SchemaValidationResult;
  readonly compileMs: number;
  readonly elapsedMs: number;
  readonly threw?: string | undefined;
}

export interface MatrixRow {
  readonly id: string;
  readonly category: string;
  readonly admitted: boolean;
  readonly expected: SchemaValidationResult;
  readonly owner: string;
  readonly actual: readonly MatrixCell[];
}

export interface MatrixArtifact {
  readonly schemaVersion: 1;
  readonly fixtureCount: number;
  readonly deterministicRuns: number;
  readonly rows: readonly MatrixRow[];
  readonly summary: Readonly<Record<AdapterId, AdapterSummary>>;
}

export interface AdapterSummary {
  readonly total: number;
  readonly parity: number;
  readonly admittedTotal: number;
  readonly admittedParity: number;
  readonly throws: number;
  readonly eligible: boolean;
  readonly failures: readonly string[];
}

export interface BenchmarkSeries {
  readonly adapter: AdapterId;
  readonly case: string;
  readonly kind: "compile" | "hot";
  readonly operations: number;
  readonly warmups: number;
  readonly samples: readonly number[];
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly throughputPerSecond?: number | undefined;
}

export function errorObservation(
  error: unknown,
  normalized: SchemaValidationResult,
): ValidationObservation {
  return {
    normalized,
    raw: [],
    threw:
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
  };
}
