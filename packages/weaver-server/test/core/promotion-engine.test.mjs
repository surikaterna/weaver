import { createPromotionEngine } from "../../src/core/promotion-engine.ts";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { registerTestService, registerTestSchema } from "../fixtures/schema-authority.mjs";

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
    const registry = await registerTestService(configService, "db", "staging", { host: { type: "string" } });
    await registerTestSchema(registry, "db", "production", { host: { type: "string" } });
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
      key: "nonexistent",
      fromEnvironment: "staging",
      toEnvironment: "production",
      layer: "platform",
      actor: "admin",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  test("promote rejects non-promotable layers", async () => {
    const provider = createTestProvider("p1", "user", { "key": "val" });
    const configService = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });
    const engine = createPromotionEngine({ configService });

    const result = await engine.promote({
      key: "key",
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
    const registry = await registerTestService(configService, "feature", "dev", { flag: { type: "boolean" } });
    await registerTestSchema(registry, "feature", "prod", { flag: { type: "boolean" } });
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
