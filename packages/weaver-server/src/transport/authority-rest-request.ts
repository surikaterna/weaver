import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type ConfigurationServiceIdentity,
  canonicalConfigurationPathSchema,
  captureServiceData,
  configurationServiceIdentitySchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { parseScopeQuery } from "../core/scope-utils";
import {
  authorityDeleteBodySchema,
  authorityPutBodySchema,
  authorityReadQuerySchema,
  authorityWriteQuerySchema,
} from "./authority-rest-contracts";
import type { RestRequest } from "./rest-adapter";
import { extractExpectedRevision } from "./rest-route-boundary";

export function invalidAuthorityRequest(): never {
  throw createWeaverError("VALIDATION_ERROR", "Invalid authority request");
}

function requestedIdentity(
  query: { env?: string | undefined; scope?: string | undefined },
  initial: ConfigurationServiceIdentity,
) {
  if (query.env !== undefined && query.env !== initial.environment)
    throw createWeaverError(
      "FORBIDDEN",
      "Requested identity is not authorized",
    );
  const scope = query.scope;
  if (
    scope !== undefined &&
    scope !== "" &&
    scope.split(",").some((term) => !/^[^:]+:[^:]+$/.test(term))
  )
    return invalidAuthorityRequest();
  const scopePath =
    scope === undefined
      ? initial.scopePath
      : scope === ""
        ? []
        : parseScopeQuery(scope);
  const identity = configurationServiceIdentitySchema.safeParse({
    environment: initial.environment,
    scopePath,
  });
  if (!identity.success) return invalidAuthorityRequest();
  return identity.data;
}

function writeCondition(request: RestRequest) {
  const token = extractExpectedRevision(request, { strictQuotes: true });
  if (
    token !== undefined &&
    (!token ||
      /[\s,\p{Cc}"]/u.test(token) ||
      token === "*" ||
      token.startsWith("W/"))
  )
    return invalidAuthorityRequest();
  return token === undefined ? {} : { ifRevision: token };
}

function hasJsonContentType(request: RestRequest): boolean {
  return /^application\/json(?:\s*;|$)/i.test(
    request.headers["content-type"] ?? "",
  );
}

function validateDeleteBody(request: RestRequest, value: unknown): void {
  // Unsupported media types leave the parsed body undefined despite a framed
  // entity. HTTP framing, not parser output alone, determines body absence.
  const hasEntity =
    request.headers["transfer-encoding"] !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0;
  if (hasEntity && (!hasJsonContentType(request) || value === undefined))
    invalidAuthorityRequest();
  if (
    value !== undefined &&
    !authorityDeleteBodySchema.safeParse(value).success
  )
    invalidAuthorityRequest();
}

function writeBody(method: "PUT" | "DELETE", request: RestRequest): unknown {
  const captured = captureServiceData(request.body);
  if (!captured.success) return invalidAuthorityRequest();
  if (method === "DELETE") {
    validateDeleteBody(request, captured.value);
    return undefined;
  }
  if (!hasJsonContentType(request)) return invalidAuthorityRequest();
  const body = authorityPutBodySchema.safeParse(captured.value);
  if (!body.success) return invalidAuthorityRequest();
  return body.data.value;
}

export function selectAuthorityRequest(
  method: "GET" | "PUT" | "DELETE",
  request: RestRequest,
  initial: ConfigurationServiceIdentity,
) {
  const path = canonicalConfigurationPathSchema.safeParse(
    `/${request.params.keyPath}`,
  );
  if (!path.success) return invalidAuthorityRequest();
  const parsed = parseCanonicalConfigPath(path.data);
  if (method === "GET") {
    const query = authorityReadQuerySchema.safeParse(request.query);
    if (!query.success) return invalidAuthorityRequest();
    return {
      method,
      path: path.data,
      parsed,
      identity: requestedIdentity(query.data, initial),
      inspect: query.data.inspect !== undefined,
    };
  }
  const query = authorityWriteQuerySchema.safeParse(request.query);
  if (!query.success) return invalidAuthorityRequest();
  return {
    method,
    path: path.data,
    parsed,
    identity: requestedIdentity(query.data, initial),
    options: { layer: query.data.layer, ...writeCondition(request) },
    value: writeBody(method, request),
  };
}
export type SelectedAuthorityRequest = ReturnType<
  typeof selectAuthorityRequest
>;
