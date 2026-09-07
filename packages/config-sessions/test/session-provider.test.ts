import { createOverrideSessionProvider } from "../src/override-session-provider.js";

function createTestProvider() {
  const audits: Array<{ action: string }> = [];
  const controller = createOverrideSessionProvider({
    defaultDurationMs: 10_000,
    onAudit: (entry) => audits.push({ action: entry.action }),
    timer: {
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  });
  return { controller, audits };
}

describe("OverrideSessionProvider", () => {
  it("activates a session", () => {
    const { controller } = createTestProvider();
    const session = controller.activate({
      activatedBy: "admin",
      reason: "test",
    });
    expect(session.id).toBeTruthy();
    expect(session.activatedBy).toBe("admin");
    expect(session.isActive).toBe(true);
    expect(controller.isActive()).toBe(true);
  });

  it("throws when activating while session already active", () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    expect(() =>
      controller.activate({ activatedBy: "admin", reason: "again" }),
    ).toThrow();
  });

  it("deactivates a session and clears overrides", () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    const result = controller.deactivate();
    expect(result.sessionId).toBeTruthy();
    expect(result.overridesCleared).toBe(0);
    expect(controller.isActive()).toBe(false);
  });

  it("throws when deactivating with no active session", () => {
    const { controller } = createTestProvider();
    expect(() => controller.deactivate()).toThrow();
  });

  it("extends a session", () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    const extended = controller.extend(20_000);
    expect(extended.expiresAt).toBeTruthy();
  });

  it("provider write/load tracks overrides", async () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    const provider = controller.provider;
    expect(typeof provider.write).toBe("function");
    await provider.write("feature.x", true);
    const data = await provider.load();
    expect(data.entries.feature).toEqual({ x: true });
    expect(controller.getSession()?.overrides.feature).toEqual({ x: true });
  });

  it("provider preserves registered object anchors", async () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    const provider = controller.provider;
    const billing = { plan: "pro", limits: { seats: 10 } };

    await provider.write("billing", billing);
    await provider.write("_weaver.registry.schemas", {
      environments: { default: { schemas: { "/lynx": { kind: "service" } } } },
    });

    const data = await provider.load();
    expect(data.entries.billing).toEqual(billing);
    expect(data.entries._weaver).toEqual({
      registry: {
        schemas: {
          environments: {
            default: { schemas: { "/lynx": { kind: "service" } } },
          },
        },
      },
    });
  });

  it("provider remove clears override", async () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    expect(typeof controller.provider.write).toBe("function");
    expect(typeof controller.provider.remove).toBe("function");
    await controller.provider.write("feature.x", true);
    await controller.provider.remove("feature.x");
    const data = await controller.provider.load();
    expect(data.entries.feature).toEqual({});
  });

  it("deactivate reports correct overridesCleared count", async () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    expect(typeof controller.provider.write).toBe("function");
    await controller.provider.write("a", 1);
    await controller.provider.write("b", 2);
    const result = controller.deactivate();
    expect(result.overridesCleared).toBe(2);
  });

  it("emits audit events", () => {
    const { controller, audits } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    controller.extend();
    controller.deactivate();
    expect(audits.map((a) => a.action)).toEqual([
      "activate",
      "extend",
      "deactivate",
    ]);
  });

  it("dispose cleans up", () => {
    const { controller } = createTestProvider();
    controller.activate({ activatedBy: "admin", reason: "test" });
    controller.dispose();
    expect(controller.isActive()).toBe(false);
  });
});
