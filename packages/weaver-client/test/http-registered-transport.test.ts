import type {
  FragmentSchemaRegistrationRequest,
  ServiceSchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import { ZodError } from "zod";
import {
  createHttpTransport,
  HttpServerResponseError,
  type TransportError,
} from "../src/index.js";

type HttpTransport = ReturnType<typeof createHttpTransport>;

interface OperationCase {
  readonly name: string;
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
    data: { schemas: { "/checkout": { type: "object" } } },
    expected: { "/checkout": { type: "object" } },
    run: (transport) => requireResult(transport.fetchSchemas?.()),
  },
  {
    name: "service registration",
    data: successfulRegistration,
    expected: successfulRegistration,
    run: (transport) =>
      requireResult(transport.registerServiceSchema?.(serviceRequest)),
  },
  {
    name: "fragment registration",
    data: successfulRegistration,
    expected: successfulRegistration,
    run: (transport) =>
      requireResult(transport.registerFragmentSchema?.(fragmentRequest)),
  },
  {
    name: "registered object write",
    data: { success: true, revision: "rev-2" },
    expected: { success: true, revision: "rev-2" },
    run: (transport) =>
      requireResult(transport.setRegisteredObject?.("/checkout", {})),
  },
  {
    name: "registered path patch",
    data: { success: true, revision: "rev-2" },
    expected: { success: true, revision: "rev-2" },
    run: (transport) =>
      requireResult(transport.patchRegisteredPath?.("/checkout/enabled", true)),
  },
  {
    name: "effective validation",
    data: { valid: true, errors: [] },
    expected: { valid: true, errors: [] },
    run: (transport) =>
      requireResult(
        transport.validateRegisteredEffective?.({ anchorPath: "/checkout" }),
      ),
  },
];

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

function errorResponse(status: number): Response {
  return new Response(
    JSON.stringify({
      data: null,
      meta: { revision: "rev-1" },
      error: {
        code: "VALIDATION_ERROR",
        message: "request rejected",
        details: { field: "anchorPath" },
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function sequenceFetch(entries: readonly (Response | Error)[]) {
  let callCount = 0;
  const fetch: typeof globalThis.fetch = async () => {
    const entry = entries[callCount++];
    if (!entry) throw new Error("Missing mock response");
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { fetch, calls: () => callCount };
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

  it.each(operations)("retries retryable $name statuses", async (operation) => {
    const mock = sequenceFetch([
      response(503, { unavailable: true }),
      response(200, operation.data),
    ]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.expected,
    );
    expect(mock.calls()).toBe(2);
  });

  it.each(operations)("retries $name network failures", async (operation) => {
    const mock = sequenceFetch([
      new Error("network failure"),
      response(200, operation.data),
    ]);
    await expect(operation.run(transportFor(mock.fetch))).resolves.toEqual(
      operation.expected,
    );
    expect(mock.calls()).toBe(2);
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
    expect(errors.some((error) => error.type === "timeout")).toBe(true);
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
