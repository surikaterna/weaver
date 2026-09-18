import {
  fetchRegisteredSchemas,
  patchRegisteredPath as patchRegisteredPathRequest,
  postSchemaRegistration,
  putRegisteredObject,
  validateRegisteredEffective as validateRegisteredEffectiveRequest,
} from "./http-registered-transport";
import { createHttpContext, queryString } from "./http-transport-context";
import {
  namespaceMethods,
  readMethods,
  streamMethods,
  writeMethods,
} from "./http-transport-legacy";
import type { HttpTransportOptions } from "./http-transport-types";
import type { WeaverTransport } from "./transport";

export type {
  HttpTransportOptions,
  TransportError,
} from "./http-transport-types";

/** Creates the HTTP/SSE transport for a Weaver server. */
export function createHttpTransport(
  options: HttpTransportOptions,
): WeaverTransport & { readonly lastCheckpoint: number } {
  const context = createHttpContext(options);
  const registeredContext = {
    queryString,
    requestValidated: context.requester.requestValidated,
  };
  return {
    ...readMethods(context),
    ...namespaceMethods(context),
    ...writeMethods(context),
    ...registeredMethods(registeredContext),
    ...streamMethods(context.sse),
    get lastCheckpoint() {
      return context.sse.lastCheckpoint;
    },
  };
}

function registeredMethods(
  context: Parameters<typeof fetchRegisteredSchemas>[0],
): Pick<
  WeaverTransport,
  | "fetchSchemas"
  | "registerSchema"
  | "setRegisteredObject"
  | "patchRegisteredPath"
  | "validateRegisteredEffective"
> {
  return {
    async fetchSchemas() {
      return fetchRegisteredSchemas(context);
    },
    async registerSchema(request) {
      return postSchemaRegistration(context, request);
    },
    async setRegisteredObject(anchorPath, value, options) {
      return putRegisteredObject(context, anchorPath, value, options);
    },
    async patchRegisteredPath(path, value, options) {
      return patchRegisteredPathRequest(context, path, value, options);
    },
    async validateRegisteredEffective(options) {
      return validateRegisteredEffectiveRequest(context, options);
    },
  };
}
