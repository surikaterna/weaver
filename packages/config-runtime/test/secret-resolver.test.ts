import type { SecretReference } from "@weaver-conf/config-types";
import type { SecretBackend } from "../src/secret-resolver";
import { createSecretResolver } from "../src/secret-resolver";

function makeRef(provider: string, uri: string): SecretReference {
  return { _weaver: "secret-ref", provider, uri };
}

describe("createSecretResolver", () => {
  test("resolves secrets on init", async () => {
    const backend: SecretBackend = {
      resolve: async (ref) => `resolved:${ref.uri}`,
    };

    const entries = {
      database: { password: makeRef("vault", "db/password") },
      api: { key: makeRef("kms", "api/key") },
    };

    const resolver = await createSecretResolver(entries, { backend });

    expect(resolver.getResolved("database.password")).toBe(
      "resolved:db/password",
    );
    expect(resolver.getResolved("api.key")).toBe("resolved:api/key");
    resolver.dispose();
  });

  test("getResolved returns cached plaintext (sync)", async () => {
    let callCount = 0;
    const backend: SecretBackend = {
      resolve: async (ref) => {
        callCount++;
        return `secret:${ref.uri}`;
      },
    };

    const entries = { secret: makeRef("vault", "my-secret") };
    const resolver = await createSecretResolver(entries, { backend });

    // First call resolves during init
    expect(callCount).toBe(1);

    // Subsequent getResolved calls are sync cache hits (no new resolve calls)
    expect(resolver.getResolved("secret")).toBe("secret:my-secret");
    expect(resolver.getResolved("secret")).toBe("secret:my-secret");
    expect(callCount).toBe(1);
    resolver.dispose();
  });

  test("hasSecret returns true for secret keys", async () => {
    const backend: SecretBackend = {
      resolve: async () => "value",
    };

    const entries = {
      secret: makeRef("vault", "x"),
      plain: "not-a-secret",
    };

    const resolver = await createSecretResolver(entries, { backend });

    expect(resolver.hasSecret("secret")).toBe(true);
    expect(resolver.hasSecret("plain")).toBe(false);
    resolver.dispose();
  });

  test("refresh picks up new secrets", async () => {
    const backend: SecretBackend = {
      resolve: async (ref) => `v:${ref.uri}`,
    };

    const resolver = await createSecretResolver({}, { backend });

    expect(resolver.hasSecret("new.key")).toBe(false);

    await resolver.refresh({
      new: { key: makeRef("vault", "new-secret") },
    });

    expect(resolver.hasSecret("new.key")).toBe(true);
    expect(resolver.getResolved("new.key")).toBe("v:new-secret");
    resolver.dispose();
  });

  test("refresh removes stale secrets", async () => {
    const backend: SecretBackend = {
      resolve: async (ref) => `v:${ref.uri}`,
    };

    const entries = { old: makeRef("vault", "old-secret") };
    const resolver = await createSecretResolver(entries, { backend });

    expect(resolver.getResolved("old")).toBe("v:old-secret");

    // Refresh with entries that no longer include "old"
    await resolver.refresh({ something: "else" });

    expect(resolver.hasSecret("old")).toBe(false);
    expect(resolver.getResolved("old")).toBe(undefined);
    resolver.dispose();
  });

  test("scans arrays without colliding with dotted object keys", async () => {
    const backend: SecretBackend = {
      resolve: async (ref) => `resolved:${ref.uri}`,
    };
    const resolver = await createSecretResolver(
      {
        "group.one": [makeRef("vault", "compound")],
        group: { one: [makeRef("vault", "nested")] },
      },
      { backend },
    );

    expect(resolver.getResolved("[group.one].0")).toBe("resolved:compound");
    expect(resolver.getResolved("group.one.0")).toBe("resolved:nested");
    expect(resolver.getResolved("group.one[0]")).toBe("resolved:nested");
    resolver.dispose();
  });

  test("dispose stops timer", async () => {
    const backend: SecretBackend = {
      resolve: async () => "value",
    };

    const entries = { s: makeRef("vault", "x") };
    const resolver = await createSecretResolver(entries, {
      backend,
      refreshIntervalMs: 50,
    });

    // Should not throw
    resolver.dispose();
    resolver.dispose(); // Double dispose is safe
  });

  test("background refresh calls resolveAll", async () => {
    let resolveCount = 0;
    const backend: SecretBackend = {
      resolve: async (ref) => {
        resolveCount++;
        return `v${resolveCount}:${ref.uri}`;
      },
    };

    const entries = { s: makeRef("vault", "x") };
    const resolver = await createSecretResolver(entries, {
      backend,
      refreshIntervalMs: 30,
    });

    // Initial resolve happened
    expect(resolveCount).toBe(1);
    expect(resolver.getResolved("s")).toBe("v1:x");

    // Wait for at least one background refresh
    await new Promise((r) => setTimeout(r, 80));

    expect(resolveCount > 1).toBeTruthy();
    resolver.dispose();
  });
});
