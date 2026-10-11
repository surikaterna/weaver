// Policy validation engine — evaluates changePolicy rules for config writes

import type {
  ConfigurationAccessContext,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";

export type PolicyDecision =
  | { readonly outcome: "allowed" }
  | { readonly outcome: "requires-promotion"; readonly message: string }
  | { readonly outcome: "requires-emergency-auth"; readonly message: string }
  | { readonly outcome: "denied"; readonly reason: string };

/** Policy inputs are supplied by the trusted host, not authenticated by this utility. */
export type PolicyEvaluationContext = ConfigurationAccessContext;

/**
 * Evaluates whether a configuration change is allowed based on the key's
 * changePolicy, the caller's auth context, and the target layer.
 *
 * Decision flow:
 * 1. Check base write permission via the provided canWrite function
 * 2. Evaluate changePolicy (defaults to 'direct-allowed')
 */
export function evaluateChangePolicy(
  schema: ConfigurationPropertySchema,
  context: PolicyEvaluationContext,
  layer: string,
  canWrite: (
    ctx: ConfigurationAccessContext,
    layer: string,
    key: string,
    schema: ConfigurationPropertySchema | undefined,
  ) => boolean,
): PolicyDecision {
  // Step 1: Check base write permission
  if (!canWrite(context, layer, "", schema)) {
    return {
      outcome: "denied",
      reason: `Write denied: insufficient permissions for layer '${layer}'`,
    };
  }

  // Step 2: Evaluate changePolicy
  const policy = schema["x-weaver"]?.changePolicy ?? "direct-allowed";

  switch (policy) {
    case "direct-allowed":
      return { outcome: "allowed" };

    case "staging-gate":
      return {
        outcome: "requires-promotion",
        message:
          "Change requires staging validation before production deployment",
      };

    case "full-pipeline":
      return {
        outcome: "requires-promotion",
        message: "Change requires full CI/CD pipeline review",
      };

    case "emergency-override":
      return emergencyDecision(context);
  }
}

function emergencyDecision(context: PolicyEvaluationContext): PolicyDecision {
  if (
    context.trustedSession?.emergency === true &&
    typeof context.trustedSession.reason === "string" &&
    context.trustedSession.reason.trim().length > 0
  )
    return { outcome: "allowed" };
  return {
    outcome: "requires-emergency-auth",
    message: "This key requires emergency override authorization",
  };
}
