export type SchemaValidationPathSegment = string | number;

export type SchemaValidationErrorCode =
  | "invalid-type"
  | "invalid-value"
  | "missing-required"
  | "unknown-property"
  | "invalid-path"
  | "invalid-schema";

export interface SchemaValidationError {
  readonly code: SchemaValidationErrorCode;
  readonly path: string;
  readonly segments: readonly SchemaValidationPathSegment[];
  readonly message: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaValidationError[];
}
