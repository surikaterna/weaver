import assert from "node:assert/strict";
import { createRegistryAdapter } from "@weaver-conf/config-registry/internal/server-adapter";
import { serializeRegistry } from "@weaver-conf/config-registry/persistence";
import { principal } from "./authority.mjs";

export function persisted(requests, environment = "east") {
  const adapter = createRegistryAdapter({ defaultEnvironment: environment });
  for (const request of requests) {
    const prepared = adapter.prepare(request);
    assert.equal(prepared.result.success, true);
    prepared.publish();
  }
  return serializeRegistry(adapter.snapshot());
}

export function schemaClaims(input, permissions = ["read", "register"]) {
  const claims = principal(input, { schemaPermissions: permissions });
  claims.grants = [...input.schemas, ...["alpha", "beta"].map((serviceId) => ({ serviceId, environment: input.identity.environment }))]
    .map(({ serviceId, environment }) => ({ ...claims.grants[0], identity: { environment, scopePath: [] }, namespace: `/${serviceId}`, operations: [] }));
  return claims;
}
