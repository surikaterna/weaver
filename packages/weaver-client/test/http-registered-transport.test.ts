import type {
  FragmentSchemaRegistrationRequest,
  ServiceSchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import { ZodError } from "zod";
import {
  createHttpTransport,
  HttpResponseContractError,
  HttpServerResponseError,
  type TransportError,
} from "../src/index.js";

type HttpTransport = ReturnType<typeof createHttpTransport>;

interface OperationCase {
  readonly name: string;
  readonly kind: "read" | "mutation";
  readonly data: unknown;
  run(transport: HttpTransport): Promise<unknown>;
}

const serviceRequest: ServiceSchemaRegistrationRequest = {
  serviceId: "checkout",
  environment: "default",
  owner: { name: "Checkout", contact: "checkout@example.com" },
  schema: { type: "object" },
  fragmentSlots: [],
};

const fragmentRequest: FragmentSchemaRegistrationRequest = {
  serviceId: "checkout",
  providerId: "payments",
  slotPath: "/payment",
  environment: "default",
  owner: { name: "Payments", contact: "payments@example.com" },
  schema: { type: "object" },
};

const registrationResponse = {
  success: true,
  isNewSchema: true,
  hasBreakingChanges: false,
};

const operations: readonly OperationCase[] = [
  {
    name: "schema listing",
    kind: "read",
    data: { schemas: { "/checkout": { type: "object" } } },
    run: (transport) => requireResult(transport.fetchSchemas?.()),
  },
  {
    name: "service registration",
    kind: "mutation",
    data: registrationResponse,
    run: (transport) =>
      requireResult(transport.registerSchema?.(serviceRequest)),
  },
  {
    name: "fragment registration",
    kind: "mutation",
    data: registrationResponse,
    run: (transport) =>
      requireResult(transport.registerSchema?.(fragmentRequest)),
  },
  {
    name: "registered object write",
    kind: "mutation",
    data: { success: true, revision: "rev-2" },
    run: (transport) =>
      requireResult(transport.setRegisteredObject?.("/checkout", {})),
  },
  {
    name: "registered path patch",
    kind: "mutation",
    data: { success: true, revision: "rev-2" },
    run: (transport) =>
      requireResult(transport.patchRegisteredPath?.("/checkout/enabled", true)),
  },
  {
    name: "effective validation",
    kind: "read",
    data: { valid: true, errors: [] },
    run: (transport) =>
      requireResult(
        transport.validateRegisteredEffective?.({ anchorPath: "/checkout" }),
      ),
  },
];

const readOperations = operations.filter(
  (operation) => operation.kind === "read",
);
const mutationOperations = operations.filter(
  (operation) => operation.kind === "mutation",
);

async function requireResult<T>(result: Promise<T> | undefined): Promise<T> {
  if (!result) throw new Error("Registered operation is unsupported");
  return result;
}

function response(status: number, data: unknown): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: { revision: "rev-1", timestamp: new Date(0).toISOString() },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number, code = "VALIDATION_ERROR"): Response {
  return new Response(
    JSON.stringify({
      data: null,
      meta: { revision: "rev-1", timestamp: new Date(0).toISOString() },
      error: {
        code,
        message: "request rejected",
        details: { field: "anchorPath" },
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function sequenceFetch(entries: readonly (Response | Error)[]) {
  let callCount = 0;
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), ...(init ? { init } : {}) });
    const entry = entries[callCount++];
    if (!entry) throw new Error("Missing mock response");
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { fetch, calls: () => callCount, requests };
}

function transportFor(
  fetch: typeof globalThis.fetch,
  onError?: (error: TransportError) => void,
  timeout = 10,
) {
  return createHttpTransport({
    baseUrl: "http://localhost:3399",
    fetch,
    onError,
    retry: { maxAttempts: 2, baseDelay: 0, maxDelay: 0 },
    timeout,
  });
}

describe("registered HTTP response contracts", () => {
  it.each(
    operations,
  )("parses successful $name responses", async (operation) => {
    const mock = sequenceFetch([response(200, operation.data)]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.name === "schema listing"
        ? { "/checkout": { type: "object" } }
        : operation.data,
    );
  });

  it.each(operations)("rejects malformed $name data", async (operation) => {
    const errors: TransportError[] = [];
    const mock = sequenceFetch([response(200, { malformed: true })]);
    await expect(
      operation.run(transportFor(mock.fetch, (error) => errors.push(error))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(errors).toEqual([expect.objectContaining({ type: "parse" })]);
  });

  it.each(
    operations,
  )("rejects malformed non-success $name envelopes", async (operation) => {
    const malformed = new Response(
      JSON.stringify({ data: operation.data, error: { message: "bad" } }),
      { status: 400 },
    );
    await expect(
      operation.run(transportFor(sequenceFetch([malformed]).fetch)),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each(
    operations,
  )("rejects non-error non-success $name responses", async (operation) => {
    await expect(
      operation.run(
        transportFor(sequenceFetch([response(400, operation.data)]).fetch),
      ),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
  });
});

describe("registered HTTP retry classification", () => {
  it.each(readOperations)("retries $name after 503", async (operation) => {
    const mock = sequenceFetch([
      errorResponse(503, "SERVER_DEGRADED"),
      response(200, operation.data),
    ]);
    await operation.run(transportFor(mock.fetch));
    expect(mock.calls()).toBe(2);
  });

  it.each(
    readOperations,
  )("retries $name after a network failure", async (operation) => {
    const mock = sequenceFetch([
      new Error("temporary network failure"),
      response(200, operation.data),
    ]);
    await operation.run(transportFor(mock.fetch));
    expect(mock.calls()).toBe(2);
  });

  it.each(
    mutationOperations,
  )("does not replay $name after 503", async (operation) => {
    const mock = sequenceFetch([
      errorResponse(503, "SERVER_DEGRADED"),
      response(200, operation.data),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).resolves.toMatchObject({
      success: false,
    });
    expect(mock.calls()).toBe(1);
  });

  it.each(
    mutationOperations,
  )("does not replay $name after a network failure", async (operation) => {
    const mock = sequenceFetch([
      new Error("ambiguous completion"),
      response(200, operation.data),
    ]);
    await expect(operation.run(transportFor(mock.fetch))).rejects.toThrow(
      "ambiguous completion",
    );
    expect(mock.calls()).toBe(1);
  });

  it.each(
    mutationOperations,
  )("does not replay timed out $name", async (operation) => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
    };
    await expect(
      operation.run(transportFor(fetch, undefined, 1)),
    ).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });
});

describe("registered HTTP request contracts", () => {
  it("uses canonical encoded paths and D1 wire aliases", async () => {
    const mock = sequenceFetch([
      response(200, { success: true, revision: "rev-2" }),
      response(200, { valid: true, errors: [] }),
    ]);
    const transport = transportFor(mock.fetch);
    await requireResult(
      transport.patchRegisteredPath?.(
        "/check out/café/what?/hash#/100%/a!$&'()*+,;=:@-._~",
        true,
        { layer: "tenant", environment: "prod", ifRevision: "rev-1" },
      ),
    );
    await requireResult(
      transport.validateRegisteredEffective?.({
        anchorPath: "/checkout",
        environment: "prod",
        scopePath: [
          { scopeId: "tenant", value: "acme" },
          { scopeId: "region", value: "eu" },
        ],
      }),
    );

    expect(mock.requests[0]?.input).toBe(
      "http://localhost:3399/v1/registered/paths/check%20out/caf%C3%A9/what%3F/hash%23/100%25/a!$&'()*+,;=:@-._~?layer=tenant&env=prod",
    );
    expect(new Headers(mock.requests[0]?.init?.headers).get("If-Match")).toBe(
      '"rev-1"',
    );
    expect(mock.requests[1]?.input).toBe(
      "http://localhost:3399/v1/registered/effective/checkout?env=prod&scope=tenant%3Aacme%2Cregion%3Aeu",
    );
  });

  it("validates registration and write requests before fetch", async () => {
    const mock = sequenceFetch([]);
    const transport = transportFor(mock.fetch);
    await expect(
      transport.registerSchema?.({ ...serviceRequest, serviceId: "Bad/id" }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      transport.setRegisteredObject?.("checkout", { enabled: true }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      transport.patchRegisteredPath?.("/checkout", true, { layer: "" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mock.calls()).toBe(0);
  });

  it("rejects paths D1 cannot represent before fetch", async () => {
    const mock = sequenceFetch([]);
    const transport = transportFor(mock.fetch);
    await expect(
      transport.setRegisteredObject?.("/checkout/a%2Fb", {}),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      transport.setRegisteredObject?.("/checkout/a\\b", {}),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mock.calls()).toBe(0);
  });

  it("preserves validated typed server errors", async () => {
    const mock = sequenceFetch([errorResponse(403, "FORBIDDEN")]);
    const error = await transportFor(mock.fetch)
      .fetchSchemas?.()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpServerResponseError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
      details: { field: "anchorPath" },
    });
  });

  it("accepts typed 422 effective validation data", async () => {
    const validation = {
      valid: false,
      errors: [
        {
          code: "invalid-type",
          path: "/checkout/enabled",
          segments: ["checkout", "enabled"],
          message: "Expected boolean",
        },
      ],
    };
    const mock = sequenceFetch([response(422, validation)]);
    await expect(
      requireResult(
        transportFor(mock.fetch).validateRegisteredEffective?.({
          anchorPath: "/checkout",
        }),
      ),
    ).resolves.toEqual(validation);
    expect(mock.calls()).toBe(1);
  });
});
