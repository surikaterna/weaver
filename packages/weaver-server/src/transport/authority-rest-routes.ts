import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type ConfigurationAuthorityController,
  configurationMutationCommandSchema,
  createWeaverError,
  hydratedConfigurationInspectionSchema,
} from "@weaver-conf/config-types";
import type { ServerAuthorityOptions } from "../server-authority-options";
import {
  authorityValueResponseSchema,
  authorityWireValue,
} from "./authority-rest-contracts";
import {
  type AuthorityRequestContext,
  withAuthorityRequest,
} from "./authority-rest-principal";
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
  context: AuthorityRequestContext,
  selected: SelectedAuthorityRequest,
) {
  if (selected.method !== "GET") {
    const command = configurationMutationCommandSchema.safeParse({
      identity: context.identity,
      namespace: context.namespace,
      path: selected.path,
      ...selected.options,
      ...(selected.method === "PUT"
        ? { operation: "set", value: selected.value }
        : { operation: "remove" }),
    });
    if (!command.success)
      throw createWeaverError("VALIDATION_ERROR", "Invalid mutation command");
    return context.mutations
      .apply([command.data])
      .then((result) => authorityWriteResponse(result, context.identity));
  }
  const port = context.query;
  const relative = selected.parsed.segments.slice(
    parseCanonicalConfigPath(context.namespace).segments.length,
  );
  if (selected.inspect) {
    const inspection = hydratedConfigurationInspectionSchema.parse(
      port.inspect(relative),
    );
    return authoritySuccess(inspection, inspection.revision);
  }
  const { value: inspected, revision } = port.snapshot(relative);
  const value = inspected.state === "value" ? inspected.value : undefined;
  const data = authorityValueResponseSchema.parse({
    key: selected.parsed.storageKey,
    ...(value === undefined ? {} : { value: authorityWireValue(value) }),
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
