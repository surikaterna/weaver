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
  const context = gate.toAccessContext(request.authContext);
  if (operation === "read")
    return gate.gateRead(context, schemaRegistryAdminKey);
  return gate.gateWrite(context, "admin", schemaRegistryAdminKey);
}

export function authContextRequired(
  configService: WeaverConfigService,
): RestResponse {
  return v1Error(configService, "UNAUTHORIZED", "Authentication required");
}
