// Policy validation — checks changePolicy assignments for security conventions

import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

/** A detected policy violation with severity and suggested fix. */
export interface PolicyViolation {
  readonly key: string;
  readonly violation: string;
  readonly severity: "error" | "warning";
  readonly currentPolicy: string;
  readonly suggestedPolicy?: string | undefined;
}

/** Property schema input keyed by its full configuration path. */
export type PolicySchemaMap = ReadonlyMap<string, ConfigurationPropertySchema>;

const SECURITY_SENSITIVE_PATTERN = /password|secret|apiKey|token|credential/i;

/**
 * Validates changePolicy assignments against security conventions.
 *
 * Rules:
 * 1. Security-sensitive key names with direct-allowed → error
 * 2. Internal visibility with direct-allowed → warning
 * 3. Restart-required reload behavior with direct-allowed → warning
 */
export function validateChangePolicies(
  schemas: PolicySchemaMap,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  for (const [key, schema] of schemas) {
    const policy = schema["x-weaver"]?.changePolicy ?? "direct-allowed";

    // Rule 1: Security-sensitive key names should not use direct-allowed
    if (SECURITY_SENSITIVE_PATTERN.test(key) && policy === "direct-allowed") {
      violations.push({
        key,
        violation: `Security-sensitive key "${key}" uses "${policy}" policy`,
        severity: "error",
        currentPolicy: policy,
        suggestedPolicy: "full-pipeline",
      });
    }

    // Rule 2: Internal visibility with direct-allowed
    if (
      schema["x-weaver"]?.visibility === "internal" &&
      policy === "direct-allowed"
    ) {
      violations.push({
        key,
        violation: `Internal-visibility key "${key}" uses "${policy}" policy`,
        severity: "warning",
        currentPolicy: policy,
        suggestedPolicy: "staging-gate",
      });
    }

    // Rule 3: Restart-required reload behavior with direct-allowed
    if (
      schema["x-weaver"]?.reloadBehavior === "restart-required" &&
      policy === "direct-allowed"
    ) {
      violations.push({
        key,
        violation: `Restart-required key "${key}" uses "${policy}" policy`,
        severity: "warning",
        currentPolicy: policy,
        suggestedPolicy: "staging-gate",
      });
    }

    // Rule 4: Sensitive keys must not have public visibility
    if (
      schema["x-weaver"]?.sensitive === true &&
      schema["x-weaver"]?.visibility === "public"
    ) {
      violations.push({
        key,
        violation: `Sensitive key "${key}" has public visibility`,
        severity: "error",
        currentPolicy: policy,
        suggestedPolicy: undefined,
      });
    }
  }

  return violations;
}
