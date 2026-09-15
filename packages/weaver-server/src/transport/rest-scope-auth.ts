import { createWeaverError, httpStatusForError } from "../types/index";
import type { RestRequest, RestResponse } from "./rest-adapter";
import { errorEnvelope, v1Headers } from "./rest-helpers";
import type { RouteFactoryDeps } from "./rest-routes";

export function gateScopeAdministration(
  req: RestRequest,
  deps: RouteFactoryDeps,
): RestResponse | null {
  if (!deps.authGate || req.authContext?.isAdmin) return null;
  const code = req.authContext ? "FORBIDDEN" : "UNAUTHORIZED";
  const revision = deps.configService.revision;
  return {
    status: httpStatusForError(code),
    headers: v1Headers(revision),
    body: errorEnvelope(
      createWeaverError(code, "Admin scope access required"),
      revision,
    ),
  };
}
