export function exerciseProjection(support, engine) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const expectCode = (action, code) => {
    try { action(); } catch (error) { check(error.code === code, `expected ${code}, got ${error.code}`); return; }
    throw Error(`missing ${code}`);
  };
  const reader = support.createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const owner = { name: "example host", contact: "host@example.org" };
  const schema = { type: "object", properties: {
    settings: { type: "object", properties: {
      public: { type: "string" }, missing: { type: "string" },
      sensitive: { type: "string", "x-weaver": { sensitive: true } },
      internal: { type: "string", "x-weaver": { visibility: "internal" } },
      admin: { type: "string", "x-weaver": { visibility: "admin" } },
      platform: { type: "string", "x-weaver": { visibility: "platform" } },
      secret: { type: "string" }, alias: { type: "string" },
    } },
    "literal.dot": { type: "string" }, "😀": { type: "string" },
    "é": { type: "string" }, "e\u0301": { type: "string" },
    list: { type: "array", items: { type: "object", properties: {
      public: { type: "string" }, sensitive: { type: "string", "x-weaver": { sensitive: true } },
    } } },
  } };
  for (const environment of ["test", "other"]) {
    for (const serviceId of ["example", "examples"]) {
      check(reader.register({ serviceId, environment, owner, schema,
        fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }] }).success, "service registration");
      check(reader.register({ serviceId, environment, owner, slotPath: "/plugins", providerId: "panel",
        schema: { type: "object", properties: { enabled: { type: "boolean" } } } }).success, "fragment registration");
    }
  }
  const settings = { public: "base", sensitive: "sensitive payload", internal: "internal payload",
    admin: "admin payload", platform: "platform payload", unknown: "unknown payload",
    secret: { _weaver: "secret-ref", key: "backend reference" },
    alias: { _weaver: "mount", source: "example.settings.sensitive" } };
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [], layers: [
    { layer: "base", providerId: "base-provider", rank: 0, entries: {
      example: { settings, "literal.dot": "dot", "😀": "astral", "é": "composed", "e\u0301": "decomposed",
        list: [{ public: "item", sensitive: "hidden item" }], plugins: { panel: { enabled: true } } },
      examples: { settings: { public: "other namespace" } },
    } },
    { layer: "user", providerId: "user-provider", rank: 1,
      entries: { example: { settings: { public: "effective", secret: "public override" } } } },
  ] });
  const context = { identity: { environment: "test", scopePath: [] }, revision: "revision-1" };
  const projection = support.createRegisteredReadProjection(reader, snapshot, context);
  check(projection.get("/example/settings/public") === "effective", "effective value");
  check(projection.getAtLayer("base", "/example/settings/public") === "base", "raw layer value");
  check(projection.get("/example/settings/missing") === undefined, "declared missing");
  expectCode(() => projection.get("/example/settings/unknown"), "SCHEMA_NOT_REGISTERED");
  for (const key of ["sensitive", "internal", "admin", "platform", "alias"])
    expectCode(() => projection.get(`/example/settings/${key}`), "FORBIDDEN");
  const published = projection.entries();
  check(Object.isFrozen(published) && Object.isFrozen(published.example.settings), "frozen graph");
  check(published.example.settings.public === "effective" && !Object.hasOwn(published.example.settings, "unknown"), "public siblings");
  check(projection.getNamespace("/example").settings.public === "effective", "namespace");
  check(projection.getNamespace("/examples").settings.public === "other namespace", "namespace boundary");
  check(projection.get("/example/literal.dot") === "dot" && projection.get("/example/😀") === "astral", "literal segments");
  check(projection.get("/example/é") !== projection.get("/example/e\u0301"), "no normalization");
  check(projection.get("/example/plugins/panel/enabled") === true, "fragment anchor");
  const denied = projection.inspect("/example/settings/sensitive");
  check(denied.effective.state === "redacted" && !Object.hasOwn(denied.effective, "value"), "redacted no value");
  const secret = projection.inspect("/example/settings/secret");
  check(secret.effective.value === "public override" && secret.contributions[0].state === "redacted", "raw reference cannot hide behind override");
  check(secret.contributions[1].value === "public override" && secret.effectiveLayer === "user", "same engine provenance");
  check(!JSON.stringify(published).includes("payload") && !JSON.stringify(secret).includes("backend reference"), "no disclosure");
  return { projection, snapshot, reader, context };
}

export const readProjectionExercise = `(${exerciseProjection.toString()})(support, engine);`;
