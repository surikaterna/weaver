import {
  type ConfigurationAuthorityController,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { ServerAuthorityOptions } from "../server-authority-options";
import { authorityFailure } from "./authority-rest-response";
import { authorityRoutes } from "./authority-rest-routes";
import type {
  RestAdapter,
  RestRequest,
  RestResponse,
  RestRoute,
} from "./rest-adapter";
import { corsHeaders, matchPath } from "./rest-helpers";

export function createAuthorityRestAdapter(
  options: ServerAuthorityOptions,
  controller: ConfigurationAuthorityController,
  assertOpen: () => void,
  origins: string[] = [],
): RestAdapter {
  const routes = authorityRoutes(options, controller, assertOpen);
  return {
    routes,
    async handleRequest(method, path, request) {
      const headers = corsHeaders(
        origins,
        request.headers.origin,
        request.headers["access-control-request-headers"],
      );
      if (method === "OPTIONS") return { status: 204, body: null, headers };
      let response: RestResponse;
      try {
        assertOpen();
        if (!request.authContext)
          throw createWeaverError("UNAUTHORIZED", "Authentication required");
        response = await dispatch(routes, method, path, request);
      } catch (error) {
        response = authorityFailure(error);
      }
      return { ...response, headers: { ...response.headers, ...headers } };
    },
  };
}

async function dispatch(
  routes: readonly RestRoute[],
  method: string,
  path: string,
  request: RestRequest,
) {
  if (path === "/v1/config/batch") return unsupported();
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (route.method === method && params)
      return route.handler({ ...request, params });
  }
  if (
    [
      "config",
      "events",
      "admin",
      "registered",
      "scopes",
      "schemas",
      "sessions",
    ].some((name) => path === `/v1/${name}` || path.startsWith(`/v1/${name}/`))
  )
    return unsupported();
  throw createWeaverError("NOT_FOUND", "Unknown authority route");
}
function unsupported(): never {
  throw createWeaverError(
    "UNSUPPORTED_OPERATION",
    "Route unavailable in authority mode",
  );
}
