import { createAuditService } from "@weaver-conf/weaver-server";

function makeEntry(overrides = {}) {
  return {
    domain: "config",
    timestamp: "2026-01-01T00:00:00Z",
    actor: "user1",
    action: "set",
    key: "app.feature",
    layer: "service",
    environment: "production",
    isEmergencyOverride: false,
    oldValue: "old",
    newValue: "new",
    ...overrides,
  };
}

describe("AuditService", () => {
  it("sends entry to all sinks", async () => {
    const recorded1 = [];
    const recorded2 = [];
    const sink1 = { record: async (e) => recorded1.push(e) };
    const sink2 = { record: async (e) => recorded2.push(e) };
    const service = createAuditService({ sinks: [sink1, sink2] });

    await service.record(makeEntry());

    expect(recorded1.length).toBe(1);
    expect(recorded2.length).toBe(1);
  });

  it("masks sensitive values", async () => {
    const recorded = [];
    const sink = { record: async (e) => recorded.push(e) };
    const service = createAuditService({
      sinks: [sink],
      sensitiveKeys: new Set(["secret.key"]),
    });

    await service.record(makeEntry({ key: "secret.key", oldValue: "s3cr3t", newValue: "n3w" }));

    expect(recorded[0].oldValue).toBe("***");
    expect(recorded[0].newValue).toBe("***");
  });

  it("does not mask non-sensitive keys", async () => {
    const recorded = [];
    const sink = { record: async (e) => recorded.push(e) };
    const service = createAuditService({
      sinks: [sink],
      sensitiveKeys: new Set(["secret.key"]),
    });

    await service.record(makeEntry({ key: "normal.key" }));

    expect(recorded[0].oldValue).toBe("old");
    expect(recorded[0].newValue).toBe("new");
  });

  it("continues if one sink fails", async () => {
    const recorded = [];
    const failSink = { record: async () => { throw new Error("fail"); } };
    const goodSink = { record: async (e) => recorded.push(e) };
    const service = createAuditService({ sinks: [failSink, goodSink] });

    await service.record(makeEntry());

    expect(recorded.length).toBe(1);
  });

  it("accepts all action types", async () => {
    const recorded = [];
    const sink = { record: async (e) => recorded.push(e) };
    const service = createAuditService({ sinks: [sink] });

    const actions = ["set", "remove", "promote", "rollback", "override", "provision"];
    for (const action of actions) {
      await service.record(makeEntry({ action }));
    }

    expect(recorded.length).toBe(6);
  });
});
