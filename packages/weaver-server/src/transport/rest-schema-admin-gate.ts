import type { WeaverConfigService } from "../core/config-service";
import type { RestRequest, RestResponse } from "./rest-adapter";
import { v1Error } from "./rest-route-boundary";
import type { SchemaRouteDeps } from "./rest-schema-routes";

const schemaRegistryAdminKey = "_weaver.registry.schemas";

export function adminDenied(
  request: RestRequest,
  deps: SchemaRouteDeps,
  operation: "read" | "write",
): RestResponse | null {
  const gate = deps.authGate;
  if (!gate) return null;
  if (!request.authContext) return authContextRequired(deps.configService);
  if (!request.authContext.isAdmin) {
    return v1Error(deps.configService, "FORBIDDEN", "Admin access required");
  }
  if (operation === "read")
    return gate.gateRead(
      gate.toAccessContext(request.authContext),
      schemaRegistryAdminKey,
    );
  try {
    if (typeof gate.gateSchemaWrite === "function") {
      const result: unknown = gate.gateSchemaWrite(
        gate.toAccessContext(request.authContext),
      );
      if (result === null) return null;
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // A missing or broken custom schema gate fails closed, without a data-write fallback.
  }
  return v1Error(deps.configService, "FORBIDDEN", "Schema write access denied");
}

export function authContextRequired(
  configService: WeaverConfigService,
): RestResponse {
  return v1Error(configService, "UNAUTHORIZED", "Authentication required");
}
