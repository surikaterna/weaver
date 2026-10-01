import assert from "node:assert/strict";
import { test } from "node:test";
import * as support from "../dist/index.js";
import * as engine from "@weaver-conf/config-engine";
import { hydratedConfigurationInspectionSchema } from "@weaver-conf/config-types";
import { exerciseAncestorProjection } from "./read-projection-ancestor-fixture.mjs";

test("dynamic ancestor denial covers all direct surfaces without collateral public-sibling denial", () => {
  const { projection, paths } = exerciseAncestorProjection(support, engine);
  for (const suffix of paths) assert.ok(hydratedConfigurationInspectionSchema.safeParse(projection.inspect(`/example/${suffix}`)).success);
});

for (const length of [3000, 10000]) {
  for (const sensitive of [false, true]) {
  test(`registered ${sensitive ? "denied" : "public"} source proof follows ${length} aliases iteratively before descendant narrowing`, () => {
    const reader = support.createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
    const object = { type: "object", properties: { public: { type: "string" } } };
    assert.equal(reader.register({ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [],
      schema: { type: "object", properties: { source: sensitive ? { ...object, "x-weaver": { sensitive: true } } : object, links: { type: "object", additionalProperties: object } } } }).success, true);
    const links = {};
    for (let index = 0; index < length; index++) {
      Object.defineProperty(links, `n${index}`, { value: { _weaver: "mount", source: index + 1 === length ? "example.source" : `example.links.n${index + 1}` }, enumerable: true });
    }
    const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1, 2], ceilings: [], layers: [
      { layer: "base", providerId: "p", rank: 0, entries: { example: { source: { public: "known public" }, links } } },
      { layer: "cleared", providerId: "c", rank: 1, entries: { example: { links: { n0: null } } } },
      { layer: "resolved", providerId: "r", rank: 2, entries: { example: { links: { n0: { public: "known public" } } } } },
    ] });
    const projection = support.createRegisteredReadProjection(reader, snapshot, { identity: { environment: "test", scopePath: [] }, revision: "r" });
    if (sensitive) {
      assert.throws(() => projection.get("/example/links/n0/public"), { code: "FORBIDDEN" });
      assert.throws(() => projection.getAtLayer("resolved", "/example/links/n0/public"), { code: "FORBIDDEN" });
    } else {
      assert.equal(projection.get("/example/links/n0/public"), "known public");
      assert.equal(projection.getAtLayer("resolved", "/example/links/n0/public"), "known public");
    }
    assert.equal(projection.inspect("/example/links/n0/public").contributions[0].state, "redacted");
    assert.equal(projection.inspect("/example/links/n0/public").effective.state, sensitive ? "redacted" : "value");
  });
  }
}

for (const prototype of [Object.prototype, Array.prototype]) {
  for (const key of ["0", "1", "700"]) {
    test(`ancestor proof and denial descendants own numeric ${key} scratch on ${prototype === Object.prototype ? "object" : "array"}`, () => {
      const { reader, snapshot, paths } = exerciseAncestorProjection(support, engine);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      let getters = 0, setters = 0, failure;
      try {
        Object.defineProperty(prototype, key, { configurable: true, get() { getters++; return "ambient"; }, set() { setters++; } });
        const projection = support.createRegisteredReadProjection(reader, snapshot, { identity: { environment: "test", scopePath: [] }, revision: "r" });
        for (const suffix of paths) {
          const path = `/example/${suffix}`;
          assert.throws(() => projection.get(path), { code: "FORBIDDEN" });
          assert.throws(() => projection.getAtLayer("resolved", path), { code: "FORBIDDEN" });
          assert.throws(() => projection.getNamespace(path), { code: "FORBIDDEN" });
          const inspection = projection.inspect(path);
          if (inspection.effective.state !== "redacted") throw Error("missing ancestor denial");
        }
        if (projection.get("/example/mixed/public") !== "keep sibling") throw Error("collateral denial");
      } catch (error) { failure = error; }
      finally { if (descriptor) Object.defineProperty(prototype, key, descriptor); else Reflect.deleteProperty(prototype, key); }
      assert.equal(failure, undefined); assert.equal(getters, 0); assert.equal(setters, 0);
    });
  }
}
