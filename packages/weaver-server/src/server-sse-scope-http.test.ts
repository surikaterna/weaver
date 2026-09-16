import { createWeaverError } from "@weaver-conf/config-types";
import { vi } from "vitest";
import { startStandaloneFixture } from "../test/standalone-fixture";
import { hostForControl } from "./core/config-service-internal";

const origin = "https://scope-client.example";
const malformedScopes = [
  "",
  "tenant",
  "tenant:",
  ":acme",
  "tenant:acme/",
  "tenant:acme,",
  "tenant:acme//region:eu",
  "tenant:acme,,region:eu",
  "tenant:acme/region:",
  "tenant:acme:extra",
  "tenant:acme/region:eu:extra",
  "tenant: acme",
  "/tenant:acme",
];

async function startObservedServer() {
  const server = await startStandaloneFixture({
    schemas: {
      app: {
        type: "object",
        default: {},
        additionalProperties: false,
        properties: {
          base: { type: "string" },
          value: { type: "string" },
          region: { type: "string" },
        },
      },
    },
    paths: [
      [{ scopeId: "tenant", value: "acme" }],
      [{ scopeId: "tenant", value: "dynamic" }],
      [{ scopeId: "tenant", value: "other" }],
      [
        { scopeId: "tenant", value: "acme" },
        { scopeId: "region", value: "eu" },
      ],
    ],
    corsOrigins: [origin],
    entries: { app: { base: "BASE_DATA" } },
    scopedEntries: {
      "tenant:acme": { app: { value: "ACME_DATA" } },
      "tenant:dynamic": { app: { value: "DYNAMIC_DATA" } },
      "tenant:other": { app: { value: "OTHER_TENANT_DATA" } },
      "region:eu": { app: { region: "EU_DATA" } },
    },
  });
  const service = server.runtime.configService;
  const tenant = hostForControl(service).providers.find(
    (provider) => provider.layer === "tenant",
  );
  if (!service) throw new Error("Expected real config service");
  if (!tenant?.loadLayer) throw new Error("Expected dynamic scope provider");
  const load = vi.fn(tenant.loadLayer.bind(tenant));
  tenant.loadLayer = load;
  return {
    server,
    service,
    load,
    resolve: vi.spyOn(service, "resolveAll"),
    subscribe: vi.spyOn(service, "onDelta"),
  };
}

async function getEvents(port: number, scope?: string) {
  const query =
    scope === undefined ? "" : `?scope=${encodeURIComponent(scope)}`;
  return fetch(`http://localhost:${port}/v1/events${query}`, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(5000),
  });
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Stream ended before an SSE event");
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

function expectJsonError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("content-type")).not.toContain("event-stream");
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
}

describe("standalone HTTP SSE scope ingress (weaver-becr/weaver-s64i)", () => {
  describe("malformed scope preflight", () => {
    let sharedFixture:
      | Awaited<ReturnType<typeof startObservedServer>>
      | undefined;

    beforeAll(async () => {
      sharedFixture = await startObservedServer();
    });

    beforeEach(() => {
      const fixture = getSharedFixture(sharedFixture);
      fixture.load.mockClear();
      fixture.resolve.mockClear();
      fixture.subscribe.mockClear();
    });

    afterAll(async () => {
      const fixture = getSharedFixture(sharedFixture);
      sharedFixture = undefined;
      await fixture.server.close();
      vi.restoreAllMocks();
    });

    it.each(
      malformedScopes,
    )("rejects raw scope=%j before I/O or subscription", async (scope) => {
      const fixture = getSharedFixture(sharedFixture);
      const response = await getEvents(fixture.server.port, scope);
      expectJsonError(response, 400);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(JSON.stringify(body)).not.toContain("_DATA");
      expect(fixture.load).not.toHaveBeenCalled();
      expect(fixture.resolve).not.toHaveBeenCalled();
      expect(fixture.subscribe).not.toHaveBeenCalled();
    });
  });

  describe("stateful scope ingress", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
      "tenant:unknown",
      "missing:unknown",
      "tenant:acme/region:unknown",
    ])("rejects unprovisioned %s without warming", async (scope) => {
      const fixture = await startObservedServer();
      try {
        const response = await getEvents(fixture.server.port, scope);
        expectJsonError(response, 404);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ error: { code: "SCOPE_NOT_FOUND" } });
        expect(JSON.stringify(body)).not.toContain("_DATA");
        expect(fixture.resolve).not.toHaveBeenCalled();
        expect(fixture.subscribe).not.toHaveBeenCalled();
        expect(fixture.load.mock.calls).toEqual([]);
      } finally {
        await fixture.server.close();
      }
    });

    it("maps a typed membership denial to403 before stream headers", async () => {
      const fixture = await startObservedServer();
      const admission = fixture.service.assertScopeMembership?.bind(
        fixture.service,
      );
      if (!admission) throw new Error("Expected scope admission");
      const deny = vi.fn(admission);
      fixture.service.assertScopeMembership = deny;
      deny.mockRejectedValueOnce(
        createWeaverError("FORBIDDEN", "Scope access denied", {
          private: "SECRET",
        }),
      );
      try {
        const response = await getEvents(fixture.server.port, "tenant:dynamic");
        expectJsonError(response, 403);
        expect(await response.json()).toEqual({
          error: { code: "FORBIDDEN", message: "Scope access denied" },
        });
        expect(fixture.resolve).not.toHaveBeenCalled();
        expect(fixture.subscribe).not.toHaveBeenCalled();
      } finally {
        await fixture.server.close();
      }
    });

    it.each([
      undefined,
      "tenant:acme",
      "tenant:dynamic",
      "tenant:acme/region:eu",
      "tenant:acme,region:eu",
    ])("keeps valid scope=%s snapshots and live updates working", async (scope) => {
      const fixture = await startObservedServer();
      try {
        const response = await getEvents(fixture.server.port, scope);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(response.headers.get("access-control-allow-origin")).toBe(
          origin,
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Expected SSE response stream");
        const snapshot = await readEvent(reader);
        expect(snapshot).toContain("event: snapshot");
        expect(snapshot).toContain("BASE_DATA");
        expect(snapshot).not.toContain("OTHER_TENANT_DATA");
        expect(snapshot).not.toContain("_weaver");
        if (scope) {
          expect(snapshot).toContain(
            scope.includes("dynamic") ? "DYNAMIC_DATA" : "ACME_DATA",
          );
        }
        await fixture.service.set("platform", "app.base", "UPDATED_BASE");
        const change = await readEvent(reader);
        expect(change).toContain("event: change");
        expect(change).toContain("UPDATED_BASE");
        if (scope)
          expect(change).toContain(`"layer":"${scope.replaceAll(",", "/")}"`);
        if (scope) expect(change).not.toContain("OTHER_TENANT_DATA");
        await reader.cancel();
      } finally {
        await fixture.server.close();
      }
    });
  });
});

function getSharedFixture(
  fixture: Awaited<ReturnType<typeof startObservedServer>> | undefined,
) {
  if (!fixture) throw new Error("Expected shared malformed-scope fixture");
  return fixture;
}
