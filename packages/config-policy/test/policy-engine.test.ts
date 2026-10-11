import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import type { PolicyEvaluationContext } from "../src/policy-engine.js";
import { evaluateChangePolicy } from "../src/policy-engine.js";

function makeSchema(changePolicy?: string): ConfigurationPropertySchema {
  return {
    type: "string",
    "x-weaver": { changePolicy } as never,
  };
}

function makeContext(
  overrides?: Partial<PolicyEvaluationContext>,
): PolicyEvaluationContext {
  return { userId: "u1", roles: ["admin"], ...overrides };
}

const allowWrite = () => true;
const denyWrite = () => false;

describe("evaluateChangePolicy", () => {
  it("denies when base write check fails", () => {
    const result = evaluateChangePolicy(
      makeSchema(),
      makeContext(),
      "app",
      denyWrite,
    );
    expect(result.outcome).toBe("denied");
  });

  it("allows direct-allowed policy", () => {
    const result = evaluateChangePolicy(
      makeSchema("direct-allowed"),
      makeContext(),
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("allowed");
  });

  it("defaults to direct-allowed when no policy set", () => {
    const schema: ConfigurationPropertySchema = { type: "string" };
    const result = evaluateChangePolicy(
      schema,
      makeContext(),
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("allowed");
  });

  it("requires promotion for staging-gate", () => {
    const result = evaluateChangePolicy(
      makeSchema("staging-gate"),
      makeContext(),
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("requires-promotion");
  });

  it("requires promotion for full-pipeline", () => {
    const result = evaluateChangePolicy(
      makeSchema("full-pipeline"),
      makeContext(),
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("requires-promotion");
  });

  it("requires emergency auth when no override reason", () => {
    const result = evaluateChangePolicy(
      makeSchema("emergency-override"),
      makeContext(),
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("requires-emergency-auth");
  });

  it("allows emergency-override with proper session and reason", () => {
    const ctx = makeContext({
      trustedSession: { id: "verified", emergency: true, reason: "hotfix" },
    });
    const result = evaluateChangePolicy(
      makeSchema("emergency-override"),
      ctx,
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("allowed");
  });

  it("denies emergency-override with empty reason", () => {
    const ctx = makeContext({
      trustedSession: { id: "verified", emergency: true, reason: "" },
    });
    const result = evaluateChangePolicy(
      makeSchema("emergency-override"),
      ctx,
      "app",
      allowWrite,
    );
    expect(result.outcome).toBe("requires-emergency-auth");
  });
});
