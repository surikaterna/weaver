import {
  registeredSchemaDetailRequestSchema,
  registeredSchemaDetailResponseSchema,
  registeredSchemaIdentityListResponseSchema,
} from "@weaver-conf/config-types";
import type { RestRoute } from "./rest-adapter";
import { unavailable, v1Error, v1Response } from "./rest-route-boundary";
import { adminDenied } from "./rest-schema-admin-gate";
import type { SchemaRouteDeps } from "./rest-schema-routes";
import { parseAdminQuery } from "./rest-schemas";

export function schemaBrowseRoutes(deps: SchemaRouteDeps): RestRoute[] {
  return [identityListRoute(deps), exactDetailRoute(deps)];
}

function identityListRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "GET",
    path: "/v1/admin/schemas/identities",
    async handler(req) {
      const denied = adminDenied(req, deps, "read");
      if (denied) return denied;
      parseAdminQuery(req.query);
      if (!schemaRegistry) return unavailable(configService);
      const identities = registeredSchemaIdentityListResponseSchema.parse(
        schemaRegistry.listRegisteredSchemaIdentities(),
      );
      return v1Response(configService, 200, identities);
    },
  };
}

function exactDetailRoute(deps: SchemaRouteDeps): RestRoute {
  const { configService, schemaRegistry } = deps;
  return {
    method: "GET",
    path: "/v1/admin/schemas/anchors/*anchorPath",
    async handler(req) {
      const denied = adminDenied(req, deps, "read");
      if (denied) return denied;
      if (Object.keys(req.query).length !== 1 || !("env" in req.query)) {
        return v1Error(
          configService,
          "VALIDATION_ERROR",
          "Exactly one env query is required",
        );
      }
      if (!req.params.anchorPath || req.params.anchorPath.endsWith("/")) {
        return v1Error(
          configService,
          "VALIDATION_ERROR",
          "Noncanonical anchor path",
        );
      }
      const parsed = registeredSchemaDetailRequestSchema.parse({
        anchorPath: `/${req.params.anchorPath}`,
        environment: req.query.env,
      });
      if (!schemaRegistry) return unavailable(configService);
      const detail = schemaRegistry.getRegisteredSchema(
        parsed.anchorPath,
        parsed.environment,
      );
      if (!detail)
        return v1Error(
          configService,
          "NOT_FOUND",
          "Registered schema not found",
        );
      return v1Response(
        configService,
        200,
        registeredSchemaDetailResponseSchema.parse(detail),
      );
    },
  };
}
