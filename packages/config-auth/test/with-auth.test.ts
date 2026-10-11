import { defineWeaver, Layers } from "@weaver-conf/config-types";
import type { AuthConfig } from "../src/auth.js";
import { withAuth } from "../src/auth.js";

const weaverConfig = defineWeaver([
  Layers.Static("core"),
  Layers.Static("app"),
  Layers.Dynamic("user"),
  Layers.Ephemeral("session"),
]);

const authConfig: AuthConfig = {
  weaverConfig,
  visibilityRoles: {
    admin: new Set(["admin"]),
    platform: new Set(["admin", "platform-eng"]),
  },
  layerWritePolicies: [
    { layer: "core", allowedRoles: ["admin"] },
    { layer: "app", allowedRoles: ["admin", "developer"] },
    { layer: "user", allowedRoles: ["admin", "user"] },
    { layer: "session", allowedRoles: ["admin", "user"] },
  ],
  dynamicScopeRoles: new Set(["admin"]),
  sessionLayer: "session",
};

describe("withAuth", () => {
  const auth = withAuth(authConfig);

  describe("canRead", () => {
    it("allows public visibility for any role", () => {
      const ctx = { userId: "u1", roles: ["user"] as const };
      expect(
        auth.canRead(ctx, "k", {
          type: "string",
          "x-weaver": { visibility: "public" },
        }),
      ).toBe(true);
    });

    it("denies admin visibility without admin role", () => {
      const ctx = { userId: "u1", roles: ["user"] as const };
      expect(
        auth.canRead(ctx, "k", {
          type: "string",
          "x-weaver": { visibility: "admin" },
        }),
      ).toBe(false);
    });

    it("allows admin visibility with admin role", () => {
      const ctx = { userId: "u1", roles: ["admin"] as const };
      expect(
        auth.canRead(ctx, "k", {
          type: "string",
          "x-weaver": { visibility: "admin" },
        }),
      ).toBe(true);
    });

    it("denies internal visibility always", () => {
      const ctx = { userId: "u1", roles: ["admin"] as const };
      expect(
        auth.canRead(ctx, "k", {
          type: "string",
          "x-weaver": { visibility: "internal" },
        }),
      ).toBe(false);
    });
  });

  describe("canWrite", () => {
    it("denies write to layer without matching role", () => {
      const ctx = { userId: "u1", roles: ["user"] as const };
      expect(auth.canWrite(ctx, "core", "k", undefined)).toBe(false);
    });

    it("allows write to layer with matching role", () => {
      const ctx = { userId: "u1", roles: ["admin"] as const };
      expect(auth.canWrite(ctx, "core", "k", undefined)).toBe(true);
    });

    it("denies write when writeRestriction not met", () => {
      const ctx = { userId: "u1", roles: ["developer"] as const };
      const schema = {
        type: "string" as const,
        "x-weaver": { writeRestriction: ["admin"] },
      };
      expect(auth.canWrite(ctx, "app", "k", schema)).toBe(false);
    });

    it("blocks session write for blocked sessionMode property", () => {
      const ctx = { userId: "u1", roles: ["user"] as const };
      const schema = {
        type: "string" as const,
        "x-weaver": { sessionMode: "blocked" as const },
      };
      expect(auth.canWrite(ctx, "session", "k", schema)).toBe(false);
    });

    it("allows restricted sessionMode with elevated mode", () => {
      const ctx = {
        userId: "u1",
        roles: ["user"] as const,
        trustedSession: { id: "verified", emergency: true, reason: "incident" },
      };
      const schema = {
        type: "string" as const,
        "x-weaver": { sessionMode: "restricted" as const },
      };
      expect(auth.canWrite(ctx, "session", "k", schema)).toBe(true);
    });
  });

  describe("filterVisibleKeys", () => {
    it("filters out keys the caller cannot read", () => {
      const ctx = { userId: "u1", roles: ["user"] as const };
      const entries = { pub: "yes", secret: "no" };
      const schemaMap = new Map([
        [
          "pub",
          {
            type: "string" as const,
            "x-weaver": { visibility: "public" as const },
          },
        ],
        [
          "secret",
          {
            type: "string" as const,
            "x-weaver": { visibility: "internal" as const },
          },
        ],
      ]);
      const result = auth.filterVisibleKeys(ctx, entries, schemaMap);
      expect(result.pub).toBe("yes");
      expect(result.secret).toBe(undefined);
    });
  });
});
