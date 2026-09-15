import { createPromotionEngine } from "../../src/core/promotion-engine.ts";
import { createTestService } from "../setup-service.ts";
const createWeaverConfigService = (options) => createTestService(options, {
  db: { type: "object", properties: { host: { type: "string" } }, additionalProperties: false },
  feature: { type: "object", properties: { flag: { type: "boolean" } }, additionalProperties: false },
  app: { type: "object", properties: { key: { type: "string" } }, additionalProperties: false },
});
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

function createTestProvider(id, layer, entries, writable = true) {
  let data = JSON.parse(JSON.stringify(entries));
  return {
    id,
    layer,
    writable,
    async load() { return { entries: JSON.parse(JSON.stringify(data)) }; },
    async write(key, value) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepRemove(data, key);
      return { success: true };
    },
  };
}

describe("PromotionEngine", () => {
  test("promote copies value from source to target environment", async () => {
    const provider = createTestProvider("p1", "platform", { db: { host: "staging-db" } });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "staging",
    });
    const engine = createPromotionEngine({ configService });

    const result = await engine.promote({
      key: "db.host",
      fromEnvironment: "staging",
      toEnvironment: "production",
      layer: "platform",
      actor: "admin",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("direct");
  });

  test("promote returns NOT_FOUND for missing key", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "staging",
    });
    const engine = createPromotionEngine({ configService });

    const result = await engine.promote({
      key: "db.nonexistent",
      fromEnvironment: "staging",
      toEnvironment: "production",
      layer: "platform",
      actor: "admin",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  test("promote rejects non-promotable layers", async () => {
    const provider = createTestProvider("p1", "user", { app: { key: "val" } });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const engine = createPromotionEngine({ configService });

    const result = await engine.promote({
      key: "app.key",
      fromEnvironment: "dev",
      toEnvironment: "prod",
      layer: "user",
      actor: "admin",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("POLICY_VIOLATION");
  });

  test("direct promotion method writes value", async () => {
    const provider = createTestProvider("p1", "platform", { feature: { flag: true } });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const engine = createPromotionEngine({ configService });

    const result = await engine.promote({
      key: "feature.flag",
      fromEnvironment: "dev",
      toEnvironment: "prod",
      layer: "platform",
      actor: "admin",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("direct");
    const val = await configService.get("feature.flag");
    expect(val).toBe(true);
  });
});
