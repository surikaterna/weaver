import { weaverErrorSchema } from "@weaver-conf/config-types";
import { z } from "zod";
import { fetchWithRetry, type RetryOptions } from "./http-retry";
import type { TransportError } from "./http-transport-types";

const serverErrorSchema = weaverErrorSchema.strict();
const responseEnvelopeSchema = z
  .strictObject({
    data: z.unknown(),
    meta: z
      .strictObject({
        revision: z.string().optional(),
        timestamp: z.string().optional(),
      })
      .optional(),
    error: serverErrorSchema.optional(),
  })
  .superRefine((envelope, context) => {
    if (envelope.error !== undefined && envelope.data !== null) {
      context.addIssue({
        code: "custom",
        message: "Error responses must contain null data",
        path: ["data"],
      });
    }
  });

export type HttpServerError = z.infer<typeof serverErrorSchema>;

export class HttpServerResponseError extends Error {
  readonly code: HttpServerError["code"];
  readonly statusCode: number;
  readonly details?: Record<string, unknown> | undefined;

  constructor(error: HttpServerError, statusCode: number) {
    super(`[${error.code}] ${error.message}`);
    this.name = "HttpServerResponseError";
    this.code = error.code;
    this.statusCode = statusCode;
    this.details = error.details;
  }
}

export class HttpResponseContractError extends Error {
  readonly statusCode: number;
  readonly path: string;

  constructor(statusCode: number, path: string) {
    super(`HTTP ${statusCode} response from ${path} violated its contract`);
    this.name = "HttpResponseContractError";
    this.statusCode = statusCode;
    this.path = path;
  }
}

export interface ValidatedRequestOptions<T> {
  readonly acceptedStatuses?: ReadonlySet<number> | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly mapServerError?: ((error: HttpServerError) => T) | undefined;
}

interface HttpRequesterOptions {
  readonly baseUrl: string;
  readonly buildHeaders: () => Record<string, string>;
  readonly fetchFn: typeof globalThis.fetch;
  readonly onError: ((error: TransportError) => void) | undefined;
  readonly retry: Required<RetryOptions>;
  readonly timeout: number;
}

function reportParseError(
  error: unknown,
  statusCode: number,
  onError: HttpRequesterOptions["onError"],
): void {
  const message = error instanceof Error ? error.message : String(error);
  onError?.({
    type: "parse",
    message: `Failed to parse response: ${message}`,
    statusCode,
    retryable: false,
  });
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  statusCode: number,
  onError: HttpRequesterOptions["onError"],
): T {
  try {
    return schema.parse(data);
  } catch (error) {
    reportParseError(error, statusCode, onError);
    throw error;
  }
}

export function createHttpRequester(options: HttpRequesterOptions) {
  return {
    request: (method: string, path: string, body?: unknown) =>
      request(options, method, path, body),
    requestValidated: <T>(
      method: string,
      path: string,
      schema: z.ZodType<T>,
      body?: unknown,
      requestOptions?: ValidatedRequestOptions<T>,
    ) => requestValidated(options, method, path, schema, body, requestOptions),
  };
}

async function requestEnvelope(
  options: HttpRequesterOptions,
  method: string,
  path: string,
  body?: unknown,
  requestHeaders?: Record<string, string>,
) {
  const response = await fetchResponse(
    options,
    method,
    path,
    body,
    requestHeaders,
  );
  let rawResponse: unknown;
  try {
    rawResponse = await response.json();
  } catch (error) {
    reportParseError(error, response.status, options.onError);
    throw new Error(`Failed to parse response from ${path}`);
  }
  let envelope: z.infer<typeof responseEnvelopeSchema>;
  try {
    envelope = responseEnvelopeSchema.parse(rawResponse);
  } catch (error) {
    reportParseError(error, response.status, options.onError);
    throw error;
  }
  if (response.ok && envelope.error !== undefined) {
    return rejectUnexpectedStatus(options, response, path);
  }
  return { response, envelope };
}

function reportServerError(
  options: HttpRequesterOptions,
  error: HttpServerError,
  status: number,
  method: string,
): void {
  options.onError?.({
    type: "server",
    message: error.message,
    statusCode: status,
    retryable: isReadMethod(method) && status >= 500,
  });
}

function rejectUnexpectedStatus(
  options: HttpRequesterOptions,
  response: Response,
  path: string,
): never {
  const error = new HttpResponseContractError(response.status, path);
  reportParseError(error, response.status, options.onError);
  throw error;
}

async function request(
  options: HttpRequesterOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const { response, envelope } = await requestEnvelope(
    options,
    method,
    path,
    body,
  );
  if (response.ok) return envelope.data;
  if (envelope.error) {
    reportServerError(options, envelope.error, response.status, method);
    throw new HttpServerResponseError(envelope.error, response.status);
  }
  return rejectUnexpectedStatus(options, response, path);
}

async function requestValidated<T>(
  options: HttpRequesterOptions,
  method: string,
  path: string,
  responseSchema: z.ZodType<T>,
  body?: unknown,
  requestOptions?: ValidatedRequestOptions<T>,
): Promise<T> {
  const { response, envelope } = await requestEnvelope(
    options,
    method,
    path,
    body,
    requestOptions?.headers,
  );
  if (response.ok) {
    return parseResponse(
      responseSchema,
      envelope.data,
      response.status,
      options.onError,
    );
  }
  if (envelope.error) {
    reportServerError(options, envelope.error, response.status, method);
    if (requestOptions?.mapServerError) {
      const mapped = requestOptions.mapServerError(envelope.error);
      return parseResponse(
        responseSchema,
        mapped,
        response.status,
        options.onError,
      );
    }
    throw new HttpServerResponseError(envelope.error, response.status);
  }
  if (!requestOptions?.acceptedStatuses?.has(response.status)) {
    return rejectUnexpectedStatus(options, response, path);
  }
  return parseResponse(
    responseSchema,
    envelope.data,
    response.status,
    options.onError,
  );
}

function fetchResponse(
  options: HttpRequesterOptions,
  method: string,
  path: string,
  body?: unknown,
  requestHeaders?: Record<string, string>,
): Promise<Response> {
  return fetchWithRetry(
    `${options.baseUrl}${path}`,
    {
      method,
      headers: { ...options.buildHeaders(), ...requestHeaders },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    {
      ...options,
      retry: isReadMethod(method)
        ? options.retry
        : { ...options.retry, maxAttempts: 1 },
    },
  );
}

/** Mutations are not replayed because their completion is ambiguous. */
function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
