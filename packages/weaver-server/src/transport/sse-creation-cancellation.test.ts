import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { vi } from "vitest";
import { createTestService } from "../../test/setup-service";
import { createSSEAdapter } from "./sse-adapter";

function barrier() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function setup() {
  const tenant = createInMemoryStorageProvider({
    id: "dynamic",
    layer: "tenant",
  });
  await tenant.loadLayer?.("tenant:dynamic");
  const region = createInMemoryStorageProvider({
    id: "region",
    layer: "region",
  });
  await region.loadLayer?.("region:eu");
  const service = await createTestService(
    {
      environment: "dev",
      providers: [
        tenant,
        region,
        createInMemoryStorageProvider({
          id: "base",
          layer: "platform",
          initialEntries: { app: { safe: "BASE" } },
        }),
        createInMemoryStorageProvider({ id: "static", layer: "tenant:acme" }),
      ],
    },
    {
      app: {
        type: "object",
        properties: { safe: { type: "string" } },
        additionalProperties: false,
      },
    },
    [
      [{ scopeId: "tenant", value: "acme" }],
      [{ scopeId: "tenant", value: "dynamic" }],
      [
        { scopeId: "tenant", value: "dynamic" },
        { scopeId: "region", value: "eu" },
      ],
    ],
  );
  if (!tenant.loadLayer) throw new Error("Expected dynamic provider");
  const load = vi.fn(tenant.loadLayer.bind(tenant));
  tenant.loadLayer = load;
  const original = service.assertScopeMembership?.bind(service);
  if (!original) throw new Error("Expected scope admission");
  const admission = vi.fn(original);
  service.assertScopeMembership = admission;
  return {
    adapter: createSSEAdapter({ configService: service }),
    load,
    admission,
    validateAdmission: original,
    resolve: vi.spyOn(service, "resolveAll"),
    subscribe: vi.spyOn(service, "onDelta"),
  };
}

describe("SSE pending creation ownership (weaver-becr/weaver-s64i)", () => {
  it.each([
    undefined,
    "tenant:acme",
  ])("closeAll cancels scope=%s before its first continuation", async (scope) => {
    const fixture = await setup();
    const pending = fixture.adapter.createClient(scope ? { scope } : undefined);
    const canceled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    fixture.adapter.closeAll();
    await canceled;
    expect(fixture.adapter.clientCount).toBe(0);
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(fixture.load).not.toHaveBeenCalled();
    const later = await fixture.adapter.createClient();
    expect(fixture.adapter.clientCount).toBe(1);
    later.close();
  });

  it.each([
    "closeAll",
    "disconnect",
  ])("%s cancels delayed membership without waiting or warming", async (action) => {
    const fixture = await setup();
    const started = barrier();
    const membership = barrier();
    fixture.admission.mockImplementationOnce(async (path, signal) => {
      await fixture.validateAdmission(path, signal);
      started.open();
      await membership.promise;
    });
    const connection = new AbortController();
    const pending = fixture.adapter.createClient(
      { scope: "tenant:dynamic/region:eu" },
      connection.signal,
    );
    const canceled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    if (action === "closeAll") fixture.adapter.closeAll();
    else connection.abort();
    await canceled;
    expect(fixture.adapter.clientCount).toBe(0);
    membership.open();
    await membership.promise;
    await Promise.resolve();
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(fixture.adapter.clientCount).toBe(0);
    expect(fixture.admission).toHaveBeenCalledTimes(1);
    expect(fixture.load).not.toHaveBeenCalled();
  });

  it("does not start membership for an already disconnected caller", async () => {
    const fixture = await setup();
    const connection = new AbortController();
    connection.abort();
    await expect(
      fixture.adapter.createClient(
        { scope: "tenant:dynamic" },
        connection.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("cleans an already subscribed client when canceled during snapshot resolution", async () => {
    const fixture = await setup();
    const started = barrier();
    const snapshot = barrier();
    const unsubscribe = vi.fn();
    fixture.subscribe.mockReturnValueOnce(unsubscribe);
    fixture.resolve.mockImplementationOnce(async () => {
      started.open();
      await snapshot.promise;
      return {
        entries: { app: { safe: "BASE" } },
        scopes: {},
        revision: "test",
        timestamp: "test",
      };
    });
    const pending = fixture.adapter.createClient();
    const canceled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    fixture.adapter.closeAll();
    await canceled;
    expect(fixture.adapter.clientCount).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    snapshot.open();
    await snapshot.promise;
    expect(fixture.adapter.clientCount).toBe(0);
  });

  it("keeps established connection cancellation idempotent", async () => {
    const fixture = await setup();
    const unsubscribe = vi.fn();
    fixture.subscribe.mockReturnValueOnce(unsubscribe);
    const connection = new AbortController();
    const client = await fixture.adapter.createClient(
      undefined,
      connection.signal,
    );
    connection.abort();
    fixture.adapter.closeAll();
    client.close();
    expect(fixture.adapter.clientCount).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.messages).toHaveLength(1);
  });
});
