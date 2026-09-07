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
  readonly expected: unknown;
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

const successfulRegistration = {
  success: true,
  isNewSchema: true,
  hasBreakingChanges: false,
};

const operations: readonly OperationCase[] = [
  {
    name: "schema listing",
    kind: "read",
    data: { schemas: { "/checkout": { type: "object" } } },
    expected: { "/checkout": { type: "object" } },
    run: (transport) => requireResult(transport.fetchSchemas?.()),
  },
  {
    name: "service registration",
    kind: "mutation",
    data: successfulRegistration,
    expected: successfulRegistration,
    run: (transport) =>
      requireResult(transport.registerServiceSchema?.(serviceRequest)),
  },
  {
    name: "fragment registration",
    kind: "mutation",
    data: successfulRegistration,
    expected: successfulRegistration,
    run: (transport) =>
      requireResult(transport.registerFragmentSchema?.(fragmentRequest)),
  },
  {
    name: "registered object write",
    kind: "mutation",
    data: { success: true, revision: "rev-2" },
    expected: { success: true, revision: "rev-2" },
    run: (transport) =>
      requireResult(transport.setRegisteredObject?.("/checkout", {})),
  },
  {
    name: "registered path patch",
    kind: "mutation",
    data: { success: true, revision: "rev-2" },
    expected: { success: true, revision: "rev-2" },
    run: (transport) =>
      requireResult(transport.patchRegisteredPath?.("/checkout/enabled", true)),
  },
  {
    name: "effective validation",
    kind: "read",
    data: { valid: true, errors: [] },
    expected: { valid: true, errors: [] },
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
  return new Response(JSON.stringify({ data, meta: { revision: "rev-1" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code = "VALIDATION_ERROR"): Response {
  return new Response(
    JSON.stringify({
      data: null,
      meta: { revision: "rev-1" },
      error: {
        code,
        message: "request rejected",
        details: { field: "anchorPath" },
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function malformedErrorResponse(status: number, data: unknown): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: { revision: "rev-1" },
      error: { message: "missing code" },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function sequenceFetch(entries: readonly (Response | Error)[]) {
  let callCount = 0;
  const inits: (RequestInit | undefined)[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    inits.push(init);
    const entry = entries[callCount++];
    if (!entry) throw new Error("Missing mock response");
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { fetch, calls: () => callCount, inits };
}

function transportFor(
  fetch: typeof globalThis.fetch,
  onError?: (error: TransportError) => void,
) {
  return createHttpTransport({
    baseUrl: "http://localhost:3399",
    fetch,
    onError,
    retry: { maxAttempts: 2, baseDelay: 0, maxDelay: 0 },
    timeout: 10,
  });
}

describe("registered HTTP transport response contracts", () => {
  it.each(
    operations,
  )("parses successful $name responses", async (operation) => {
    const mock = sequenceFetch([response(200, operation.data)]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.expected,
    );
  });

  it.each(
    operations,
  )("rejects malformed $name data with ZodError", async (operation) => {
    const errors: TransportError[] = [];
    const mock = sequenceFetch([response(200, { malformed: true })]);
    await expect(
      operation.run(transportFor(mock.fetch, (error) => errors.push(error))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(errors.at(-1)?.type).toBe("parse");
  });

  it.each(
    readOperations,
  )("retries retryable $name statuses", async (operation) => {
    const mock = sequenceFetch([
      response(503, { unavailable: true }),
      response(200, operation.data),
    ]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.expected,
    );
    expect(mock.calls()).toBe(2);
  });

  it.each(
    readOperations,
  )("retries $name network failures", async (operation) => {
    const mock = sequenceFetch([
      new Error("network failure"),
      response(200, operation.data),
    ]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.expected,
    );
    expect(mock.calls()).toBe(2);
  });

  it.each(
    operations,
  )("rejects non-error non-2xx $name responses as contract errors", async (operation) => {
    const errors: TransportError[] = [];
    const mock = sequenceFetch([response(400, operation.data)]);
    await expect(
      operation.run(transportFor(mock.fetch, (error) => errors.push(error))),
    ).rejects.toBeInstanceOf(HttpResponseContractError);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type).toBe("parse");
  });

  it.each(
    operations,
  )("rejects malformed non-2xx $name error envelopes", async (operation) => {
    const errors: TransportError[] = [];
    const mock = sequenceFetch([malformedErrorResponse(400, operation.data)]);
    await expect(
      operation.run(transportFor(mock.fetch, (error) => errors.push(error))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(errors).toEqual([expect.objectContaining({ type: "parse" })]);
  });
});

describe("registered HTTP transport failures", () => {
  it("parses normal 422 effective-validation results", async () => {
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

  it.each(operations)("aborts timed out $name requests", async (operation) => {
    const errors: TransportError[] = [];
    let aborted = false;
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("timed out", "AbortError"));
          },
          { once: true },
        );
      });
    const transport = createHttpTransport({
      baseUrl: "http://localhost:3399",
      fetch,
      onError: (error) => errors.push(error),
      retry: { maxAttempts: 1 },
      timeout: 1,
    });
    await expect(operation.run(transport)).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
    expect(errors).toEqual([
      expect.objectContaining({ type: "timeout", retryable: false }),
    ]);
  });

  it.each(
    mutationOperations,
  )("does not retry retryable $name statuses", async (operation) => {
    const mock = sequenceFetch([
      errorResponse(503),
      response(200, operation.data),
    ]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).resolves.toMatchObject({ success: false });
    expect(mock.calls()).toBe(1);
  });

  it.each(
    mutationOperations,
  )("does not replay $name after ambiguous network failure", async (operation) => {
    const mock = sequenceFetch([
      new Error("ambiguous completion"),
      response(200, operation.data),
    ]);
    await expect(operation.run(transportFor(mock.fetch))).rejects.toThrow(
      "ambiguous completion",
    );
    expect(mock.calls()).toBe(1);
  });

  it.each([
    {
      name: "registered object PUT",
      run: (transport: HttpTransport) =>
        requireResult(
          transport.setRegisteredObject?.(
            "/checkout",
            { enabled: true },
            {
              ifRevision: "rev-1",
            },
          ),
        ),
    },
    {
      name: "registered path PATCH",
      run: (transport: HttpTransport) =>
        requireResult(
          transport.patchRegisteredPath?.("/checkout/enabled", true, {
            ifRevision: "rev-1",
          }),
        ),
    },
  ])("does not replay ambiguous conditional $name", async (operation) => {
    const mock = sequenceFetch([new Error("ambiguous completion")]);
    await expect(operation.run(transportFor(mock.fetch))).rejects.toThrow(
      "ambiguous completion",
    );
    expect(mock.calls()).toBe(1);
    expect(new Headers(mock.inits[0]?.headers).get("If-Match")).toBe('"rev-1"');
    expect(mock.inits[0]?.body).toBeDefined();
  });

  it("preserves typed schema-listing server errors and details", async () => {
    const mock = sequenceFetch([errorResponse(400)]);
    const error = await transportFor(mock.fetch)
      .fetchSchemas?.()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpServerResponseError);
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: { field: "anchorPath" },
    });
    expect(mock.calls()).toBe(1);
  });

  it.each(
    operations.slice(1, 5),
  )("returns detailed non-retryable $name failures", async (operation) => {
    const mock = sequenceFetch([errorResponse(400)]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "request rejected",
        details: { field: "anchorPath" },
      },
    });
    expect(mock.calls()).toBe(1);
  });

  it.each([
    {
      name: "service registration",
      run: (transport: HttpTransport) =>
        requireResult(transport.registerServiceSchema?.(serviceRequest)),
    },
    {
      name: "fragment registration",
      run: (transport: HttpTransport) =>
        requireResult(transport.registerFragmentSchema?.(fragmentRequest)),
    },
  ])("preserves $name Weaver error codes", async (operation) => {
    const mock = sequenceFetch([errorResponse(409, "SCHEMA_CONFLICT")]);
    await expect(
      operation.run(transportFor(mock.fetch)),
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "SCHEMA_CONFLICT",
        message: "request rejected",
        details: { field: "anchorPath" },
      },
    });
  });

  it("preserves typed effective-validation server errors and details", async () => {
    const mock = sequenceFetch([errorResponse(400)]);
    const error = await transportFor(mock.fetch)
      .validateRegisteredEffective?.({ anchorPath: "/checkout" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpServerResponseError);
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: { field: "anchorPath" },
    });
  });
});
