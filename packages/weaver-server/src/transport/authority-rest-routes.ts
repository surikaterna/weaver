import {
  type ConfigurationAuthorityController,
  type ConfigurationAuthorityRequest,
  createWeaverError,
  hydratedConfigurationInspectionSchema,
} from "@weaver-conf/config-types";
import type { ServerAuthorityOptions } from "../server-authority-options";
import { authorityLeafResponseSchema } from "./authority-rest-contracts";
import { withAuthorityRequest } from "./authority-rest-principal";
import {
  type SelectedAuthorityRequest,
  selectAuthorityRequest,
} from "./authority-rest-request";
import {
  authoritySuccess,
  authorityWriteResponse,
} from "./authority-rest-response";
import type { RestRequest, RestRoute } from "./rest-adapter";

function execute(
  port: ConfigurationAuthorityRequest,
  selected: SelectedAuthorityRequest,
) {
  if (selected.method === "PUT")
    return port
      .set(selected.path, selected.value, selected.options)
      .then(authorityWriteResponse);
  if (selected.method === "DELETE")
    return port
      .remove(selected.path, selected.options)
      .then(authorityWriteResponse);
  if (selected.inspect) {
    const inspection = hydratedConfigurationInspectionSchema.parse(
      port.inspect(selected.path),
    );
    return authoritySuccess(inspection, inspection.revision);
  }
  const value = port.get(selected.path);
  const revision = port.revision;
  const data = authorityLeafResponseSchema.parse({
    key: selected.parsed.storageKey,
    ...(value === undefined ? {} : { value }),
  });
  return authoritySuccess(data, revision);
}

export function authorityRoutes(
  options: ServerAuthorityOptions,
  controller: ConfigurationAuthorityController,
  assertOpen: () => void,
): RestRoute[] {
  const handler =
    (method: "GET" | "PUT" | "DELETE") => async (request: RestRequest) => {
      if (!request.authContext)
        throw createWeaverError("UNAUTHORIZED", "Authentication required");
      const selected = selectAuthorityRequest(
        method,
        request,
        options.configuration.identity,
      );
      return withAuthorityRequest(
        options,
        controller,
        request.authContext,
        selected,
        assertOpen,
        (port) => execute(port, selected),
      );
    };
  return [
    { method: "GET", path: "/v1/config/*keyPath", handler: handler("GET") },
    { method: "PUT", path: "/v1/config/*keyPath", handler: handler("PUT") },
    {
      method: "DELETE",
      path: "/v1/config/*keyPath",
      handler: handler("DELETE"),
    },
  ];
}
