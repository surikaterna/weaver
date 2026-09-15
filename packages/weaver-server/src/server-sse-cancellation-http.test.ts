import { get } from "node:http";
import { vi } from "vitest";
import { startStandaloneFixture } from "../test/standalone-fixture";
import * as core from "./core/config-service";
import * as sse from "./transport/sse-adapter";

function barrier() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function observeCreation() {
  const services: core.WeaverConfigService[] = [];
  const adapters: sse.SSEAdapter[] = [];
  const attempts: Promise<sse.SSEClient>[] = [];
  const createService = core.createWeaverConfigService;
  const createAdapter = sse.createSSEAdapter;
  vi.spyOn(core, "createWeaverConfigService").mockImplementation(
    async (options) => {
      const service = await createService(options);
      services.push(service);
      return service;
    },
  );
  vi.spyOn(sse, "createSSEAdapter").mockImplementation((options) => {
    const adapter = createAdapter(options);
    const createClient = adapter.createClient;
    vi.spyOn(adapter, "createClient").mockImplementation((options, signal) => {
      const pending = createClient(options, signal);
      attempts.push(pending);
      return pending;
    });
    adapters.push(adapter);
    return adapter;
  });
  return { services, adapters, attempts };
}

async function setup() {
  const observed = observeCreation();
  const server = await startStandaloneFixture({
    paths: [[{ scopeId: "tenant", value: "acme" }]],
  });
  const service = server.runtime.configService;
  const adapter = observed.adapters[0];
  if (!service || !adapter)
    throw new Error("Expected real service and adapter");
  const membership = barrier();
  const started = barrier();
  const admission = service.assertScopeMembership?.bind(service);
  if (!admission) throw new Error("Expected canonical scope admission");
  service.assertScopeMembership = vi.fn(async (path, signal) => {
    await admission(path, signal);
    started.open();
    await membership.promise;
  });
  return {
    server,
    adapter,
    membership,
    started,
    attempts: observed.attempts,
    resolve: vi.spyOn(service, "resolveAll"),
    subscribe: vi.spyOn(service, "onDelta"),
  };
}

describe("HTTP SSE pending membership cancellation (weaver-becr/weaver-s64i)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "disconnect",
    "shutdown",
  ])("%s cannot publish a connection after cleanup", async (action) => {
    const fixture = await setup();
    const statuses: number[] = [];
    const request = get(
      `http://localhost:${fixture.server.port}/v1/events?scope=tenant:acme`,
      (response) => {
        statuses.push(response.statusCode ?? 0);
        response.resume();
      },
    );
    request.on("error", () => {});
    const socketClosed = new Promise<void>((resolve) =>
      request.once("close", resolve),
    );
    try {
      await fixture.started.promise;
      const pending = fixture.attempts[0];
      if (!pending) throw new Error("Expected pending SSE attempt");
      const canceled = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      if (action === "shutdown") await fixture.server.close();
      else request.destroy();
      await socketClosed;
      await canceled;
      expect(fixture.adapter.clientCount).toBe(0);
      fixture.membership.open();
      await fixture.membership.promise;
      await Promise.resolve();
      expect(fixture.adapter.clientCount).toBe(0);
      expect(fixture.resolve).not.toHaveBeenCalled();
      expect(fixture.subscribe).not.toHaveBeenCalled();
      expect(statuses).toEqual([]);
    } finally {
      fixture.membership.open();
      request.destroy();
      await fixture.server.close();
    }
  });
});
