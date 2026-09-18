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
  readonly status: number;
  readonly wrongStatus: number;
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
    status: 200,
    wrongStatus: 201,
    run: (transport) => requireResult(transport.fetchSchemas?.()),
  },
  {
    name: "service registration",
    kind: "mutation",
    data: registrationResponse,
    status: 201,
    wrongStatus: 200,
    run: (transport) =>
      requireResult(transport.registerSchema?.(serviceRequest)),
  },
  {
    name: "fragment registration",
    kind: "mutation",
    data: registrationResponse,
    status: 201,
    wrongStatus: 200,
    run: (transport) =>
      requireResult(transport.registerSchema?.(fragmentRequest)),
  },
  {
    name: "registered object write",
    kind: "mutation",
    data: { success: true, revision: "rev-2" },
    status: 200,
    wrongStatus: 201,
    run: (transport) =>
      requireResult(transport.setRegisteredObject?.("/checkout", {})),
  },
  {
    name: "registered path patch",
    kind: "mutation",
    data: { success: true, revision: "rev-2" },
    status: 200,
    wrongStatus: 201,
    run: (transport) =>
      requireResult(transport.patchRegisteredPath?.("/checkout/enabled", true)),
  },
  {
    name: "effective validation",
    kind: "read",
    data: { valid: true, errors: [] },
    status: 200,
    wrongStatus: 201,
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

function envelopeResponse(
  status: number,
  envelope: unknown,
  contentType = "application/json",
): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": contentType },
  });
}

function response(
  status: number,
  data: unknown,
  contentType = "application/json",
): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: { revision: "rev-1", timestamp: new Date(0).toISOString() },
    }),
    { status, headers: { "Content-Type": contentType } },
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

function malformedJsonValues(): readonly unknown[] {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = new Array(1);
  const extraArray = Object.assign([], { extra: true });
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => "hidden",
  });
  const symbolProperty = { value: true };
  Object.defineProperty(symbolProperty, Symbol("hidden"), {
    enumerable: true,
    value: true,
  });
  const nonEnumerable = Object.defineProperty({}, "hidden", { value: true });
  return [
    undefined,
    () => true,
    Symbol("value"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    { nested: undefined },
    cycle,
    sparse,
    extraArray,
    accessor,
    symbolProperty,
    nonEnumerable,
    new Date(0),
    new Map(),
    Object.create({ inherited: true }),
  ];
}

async function setWithOptions(
  transport: HttpTransport,
  options: unknown,
): Promise<unknown> {
  const operation = transport.setRegisteredObject;
  if (!operation) throw new Error("Registered operation is unsupported");
  return Reflect.apply(operation, transport, ["/checkout", {}, options]);
}

async function validateWithOptions(
  transport: HttpTransport,
  options: unknown,
): Promise<unknown> {
  const operation = transport.validateRegisteredEffective;
  if (!operation) throw new Error("Registered operation is unsupported");
  return Reflect.apply(operation, transport, [options]);
}

describe("registered HTTP response contracts", () => {
  it.each(
    operations,
  )("parses successful $name responses", async (operation) => {
    const mock = sequenceFetch([response(operation.status, operation.data)]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.name === "schema listing"
        ? { "/checkout": { type: "object" } }
        : operation.data,
    );
  });

  it.each(operations)("rejects malformed $name data", async (operation) => {
    const errors: TransportError[] = [];
    const mock = sequenceFetch([
      response(operation.status, { malformed: true }),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch, (error) => errors.push(error))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(errors).toEqual([expect.objectContaining({ type: "parse" })]);
    expect(mock.calls()).toBe(1);
  });

  it.each(
    operations,
  )("rejects malformed non-success $name envelopes", async (operation) => {
    const malformed = new Response(
      JSON.stringify({
        data: operation.data,
        meta: { revision: "rev-1", timestamp: "1970-01-01T00:00:00.000Z" },
        error: { message: "bad" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    await expect(
      operation.run(transportFor(sequenceFetch([malformed]).fetch)),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each(
    operations,
  )("rejects non-error non-success $name responses", async (operation) => {
    await expect(
      operation.run(transportFor(sequenceFetch([response(400, null)]).fetch)),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
  });

  it.each(
    operations,
  )("rejects an unlisted 2xx for $name", async (operation) => {
    const mock = sequenceFetch([
      response(operation.wrongStatus, operation.data),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
    expect(mock.calls()).toBe(1);
  });

  it.each(
    operations.flatMap((operation) =>
      [
        'Application/JSON; Charset="utf-8"',
        'application/json; profile="a;b"',
        'application/json; profile="a\\"b"',
        'Application/JSON \t;\t x \t= \t"" ; x=opaque',
      ].map((contentType) => ({ contentType, operation })),
    ),
  )("accepts JSON media parameters for $operation.name", async ({
    contentType,
    operation,
  }) => {
    const mock = sequenceFetch([
      response(operation.status, operation.data, contentType),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).resolves.toBeDefined();
    expect(mock.calls()).toBe(1);
  });

  it.each(
    operations.flatMap((operation) =>
      [
        undefined,
        "text/html",
        "application/problem+json",
        "application/json;",
        'application/json; profile="unterminated',
        'application/json; profile="dangling\\',
        "application/json; =value",
        "application/json; profile",
        "application/json; profile=",
        "application/json; profile=value;;next=value",
        "application/json; profile=value value",
        "application/json; profile=value/other",
        "application/json; profile=value\\other",
        'application/json; profile="value"garbage',
        "application/json; profile=\u0001",
        "application/json; profile=café",
      ].map((contentType) => ({ contentType, operation })),
    ),
  )("rejects invalid media $contentType for $operation.name", async ({
    operation,
    contentType,
  }) => {
    const body = JSON.stringify({
      data: operation.data,
      meta: { revision: "rev-1", timestamp: "1970-01-01T00:00:00.000Z" },
    });
    const headers = contentType ? { "Content-Type": contentType } : undefined;
    const mock = sequenceFetch([
      new Response(body, { status: operation.status, headers }),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
    expect(mock.calls()).toBe(1);
  });

  const malformedEnvelopes = [
    {
      name: "missing data",
      value: { meta: { revision: "r", timestamp: "t" } },
    },
    { name: "missing meta", value: { data: null } },
    {
      name: "missing revision",
      value: { data: null, meta: { timestamp: "t" } },
    },
    {
      name: "missing timestamp",
      value: { data: null, meta: { revision: "r" } },
    },
    {
      name: "unknown envelope field",
      value: {
        data: null,
        meta: { revision: "r", timestamp: "t" },
        extra: true,
      },
    },
    {
      name: "unknown meta field",
      value: {
        data: null,
        meta: { revision: "r", timestamp: "t", extra: true },
      },
    },
  ];

  it.each(
    operations.flatMap((operation) =>
      malformedEnvelopes.map((malformed) => ({ malformed, operation })),
    ),
  )("rejects $malformed.name for $operation.name", async ({
    malformed,
    operation,
  }) => {
    const mock = sequenceFetch([
      envelopeResponse(operation.status, malformed.value),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mock.calls()).toBe(1);
  });

  it.each(
    operations,
  )("rejects success-with-error for $name", async (operation) => {
    const mock = sequenceFetch([errorResponse(operation.status)]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
    expect(mock.calls()).toBe(1);
  });

  it.each(
    operations,
  )("rejects non-null error data for $name", async (operation) => {
    const mock = sequenceFetch([
      envelopeResponse(400, {
        data: operation.data,
        meta: { revision: "rev-1", timestamp: "now" },
        error: { code: "VALIDATION_ERROR", message: "bad" },
      }),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mock.calls()).toBe(1);
  });
});

describe("registered HTTP retry classification", () => {
  it.each(readOperations)("retries $name after 503", async (operation) => {
    const mock = sequenceFetch([
      errorResponse(503, "SERVER_DEGRADED"),
      response(operation.status, operation.data),
    ]);
    await operation.run(transportFor(mock.fetch));
    expect(mock.calls()).toBe(2);
  });

  it.each(readOperations)("retries $name after 429", async (operation) => {
    const mock = sequenceFetch([
      errorResponse(429),
      response(operation.status, operation.data),
    ]);
    await operation.run(transportFor(mock.fetch));
    expect(mock.calls()).toBe(2);
  });

  it.each(
    readOperations,
  )("retries $name after a network failure", async (operation) => {
    const mock = sequenceFetch([
      new Error("temporary network failure"),
      response(operation.status, operation.data),
    ]);
    await operation.run(transportFor(mock.fetch));
    expect(mock.calls()).toBe(2);
  });

  it.each(
    mutationOperations,
  )("does not replay $name after 503", async (operation) => {
    const mock = sequenceFetch([
      errorResponse(503, "SERVER_DEGRADED"),
      response(operation.status, operation.data),
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
      response(operation.status, operation.data),
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

  it.each(
    readOperations,
  )("parses a malformed terminal 503 for $name only after retries", async (operation) => {
    const malformed = envelopeResponse(503, {
      data: null,
      meta: { revision: "rev-1", timestamp: "now" },
    });
    const mock = sequenceFetch([errorResponse(503), malformed]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
    expect(mock.calls()).toBe(2);
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

  it.each(
    malformedJsonValues(),
  )("rejects lossy registered JSON value %# before fetch", async (value) => {
    const mock = sequenceFetch([]);
    const transport = transportFor(mock.fetch);
    await expect(
      requireResult(transport.setRegisteredObject?.("/checkout", value)),
    ).rejects.toThrow();
    expect(mock.calls()).toBe(0);
  });

  it("rejects lossy registration defaults before fetch", async () => {
    const mock = sequenceFetch([]);
    const transport = transportFor(mock.fetch);
    await expect(
      transport.registerSchema?.({
        ...serviceRequest,
        schema: { type: "object", default: Number.NaN },
      }),
    ).rejects.toThrow("non-finite");
    expect(mock.calls()).toBe(0);
  });

  it("matches native JSON for the accepted shallow corpus", async () => {
    const shared = { enabled: true };
    const nullRecord = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullRecord, "__proto__", {
      enumerable: true,
      value: "data",
    });
    nullRecord.constructor = "constructor-data";
    nullRecord.prototype = "prototype-data";
    const ordered: Record<string, unknown> = { beta: true };
    ordered["10"] = "ten";
    ordered["2"] = "two";
    ordered.alpha = false;
    const sharedValue = { left: shared, right: shared };
    const escapedKey = "control\n\u0000\uD800";
    const values: unknown[] = [
      null,
      true,
      false,
      'quote" slash\\ control\n lone\uD800',
      0,
      -12,
      1.25,
      1e21,
      1e-7,
      [null, { nested: [true, "text"] }],
      ordered,
      nullRecord,
      { [escapedKey]: escapedKey },
      sharedValue,
    ];
    const mock = sequenceFetch(
      values.map(() => response(200, { success: true, revision: "rev-2" })),
    );
    const transport = transportFor(mock.fetch);
    for (const [index, value] of values.entries()) {
      await requireResult(transport.setRegisteredObject?.("/checkout", value));
      expect(mock.requests[index]?.init?.body).toBe(JSON.stringify({ value }));
    }
    expect(mock.requests.at(-1)?.init?.body).toContain(
      '"left":{"enabled":true},"right":{"enabled":true}',
    );
    expect(sharedValue.left).toBe(sharedValue.right);
    expect(Object.getPrototypeOf(nullRecord)).toBeNull();
  });

  it("serializes a depth-6000 value with one fetch", async () => {
    const depth = 6_000;
    let value: unknown = null;
    for (let level = 0; level < depth; level++) value = { next: value };
    const mock = sequenceFetch([
      response(200, { success: true, revision: "rev-2" }),
    ]);
    await requireResult(
      transportFor(mock.fetch).setRegisteredObject?.("/checkout", value),
    );
    const expected = `{"value":${'{"next":'.repeat(depth)}null${"}".repeat(depth)}}`;
    expect(mock.requests[0]?.init?.body).toBe(expected);
    expect(mock.calls()).toBe(1);
  });

  it("rejects accessors without invoking their getter", async () => {
    let getterCalls = 0;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterCalls++;
        return "hidden";
      },
    });
    const mock = sequenceFetch([]);
    await expect(
      requireResult(
        transportFor(mock.fetch).setRegisteredObject?.("/checkout", value),
      ),
    ).rejects.toThrow();
    expect(getterCalls).toBe(0);
    expect(mock.calls()).toBe(0);
  });

  it.each([
    { extra: true },
    { layer: undefined },
    { environment: "" },
    { ifRevision: "" },
    Object.create({ layer: "tenant" }),
    Object.defineProperty({}, "__proto__", { enumerable: true, value: {} }),
    Object.defineProperty({}, "layer", {
      enumerable: true,
      get: () => "tenant",
    }),
    Object.defineProperty({}, "hidden", { value: true }),
    Object.defineProperty({}, Symbol("hidden"), {
      enumerable: true,
      value: true,
    }),
  ])("rejects unsafe write options %# before fetch", async (options) => {
    const mock = sequenceFetch([]);
    await expect(
      setWithOptions(transportFor(mock.fetch), options),
    ).rejects.toThrow();
    expect(mock.calls()).toBe(0);
  });

  it.each([
    { anchorPath: "/checkout", extra: true },
    { anchorPath: "/checkout", environment: undefined },
    { anchorPath: "/checkout", environment: "" },
    Object.assign(Object.create({ environment: "prod" }), {
      anchorPath: "/checkout",
    }),
    { anchorPath: "/checkout", scopePath: [{ scopeId: "", value: "acme" }] },
    { anchorPath: "/checkout", scopePath: [{ scopeId: "tenant", value: "" }] },
    {
      anchorPath: "/checkout",
      scopePath: [{ scopeId: "tenant:", value: "acme" }],
    },
    {
      anchorPath: "/checkout",
      scopePath: [{ scopeId: "tenant", value: "a,cme" }],
    },
  ])("rejects unsafe effective options %# before fetch", async (options) => {
    const mock = sequenceFetch([]);
    await expect(
      validateWithOptions(transportFor(mock.fetch), options),
    ).rejects.toThrow();
    expect(mock.calls()).toBe(0);
  });

  it("omits an empty scope query", async () => {
    const mock = sequenceFetch([response(200, { valid: true, errors: [] })]);
    await requireResult(
      transportFor(mock.fetch).validateRegisteredEffective?.({
        anchorPath: "/checkout",
        scopePath: [],
      }),
    );
    expect(mock.requests[0]?.input).toBe(
      "http://localhost:3399/v1/registered/effective/checkout",
    );
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
