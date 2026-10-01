// This real registration/snapshot exercise is shared with installed Node/browser consumers.
function ancestorCheck(ok, message) { if (!ok) throw Error(message); }
function ancestorDenied(action) {
  try { action(); } catch (error) {
    ancestorCheck(error.code === "FORBIDDEN", "declared descendant denial category");
    const serialized = JSON.stringify({ message: error.message, details: error.details });
    ancestorCheck(!serialized.includes("SENSITIVE_PAYLOAD") && !serialized.includes("BACKEND_REFERENCE"), "payload-safe error");
    return;
  }
  throw Error("ancestor denial was masked");
}

function ancestorReader(support) {
  const reader = support.createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const leaf = { type: "string" };
  const object = { type: "object", properties: { public: leaf, missing: leaf,
    nested: { type: "object", properties: { public: leaf } } } };
  const array = { type: "array", items: object };
  const schema = { type: "object", properties: {
    sensitive: { ...object, "x-weaver": { sensitive: true } },
    sensitiveArray: { ...array, "x-weaver": { sensitive: true } },
    publicSource: object, alias: object, safeAlias: object, aliasArray: array, sharedSafe: object, sharedDenied: object,
    secret: { type: "object", properties: { key: leaf, nested: { type: "object", properties: { key: leaf } } } },
    mount: { type: "object", properties: { source: leaf } }, cycleA: object, cycleB: object,
    mixed: { type: "object", properties: { public: leaf, denied: { ...object, "x-weaver": { sensitive: true } } } },
  } };
  ancestorCheck(reader.register({ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema }).success, "real ancestor schema registration");
  return reader;
}

function ancestorSnapshot(engine) {
  const source = "example.sensitive";
  const raw = { sensitive: { public: "SENSITIVE_PAYLOAD" }, sensitiveArray: [{ public: "SENSITIVE_PAYLOAD" }],
    publicSource: { public: "public source", nested: { public: "nested source" } },
    alias: { _weaver: "mount", source }, safeAlias: { _weaver: "mount", source: "example.publicSource" },
    aliasArray: { _weaver: "mount", source: "example.sensitiveArray" },
    secret: { _weaver: "secret-ref", key: "BACKEND_REFERENCE", nested: { key: "BACKEND_REFERENCE" } },
    mount: { _weaver: "mount", source }, sharedDenied: { _weaver: "mount", source },
    cycleA: { _weaver: "mount", source: "example.cycleB" }, cycleB: { _weaver: "mount", source: "example.cycleA" },
    mixed: { public: "keep sibling", denied: { public: "SENSITIVE_PAYLOAD" } } };
  const shared = { public: "shared public value" };
  const layers = [
    { layer: "base", providerId: "p", rank: 0, entries: { example: raw } },
    { layer: "cleared", providerId: "c", rank: 1, entries: { example: { alias: null, safeAlias: null, cycleA: null, cycleB: null, sharedDenied: null } } },
    { layer: "resolved", providerId: "r", rank: 2, entries: { example: {
      alias: { public: "SENSITIVE_PAYLOAD", nested: { public: "SENSITIVE_PAYLOAD" } },
      aliasArray: [{ public: "SENSITIVE_PAYLOAD" }], safeAlias: { public: "public source", nested: { public: "nested source" } },
      cycleA: { public: "SENSITIVE_PAYLOAD" }, cycleB: { public: "SENSITIVE_PAYLOAD" }, sharedSafe: shared, sharedDenied: shared,
    } } },
  ];
  return { snapshot: engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1, 2], ceilings: [], layers }), raw };
}

function ancestorSurfaceChecks(projection, paths) {
  for (const suffix of paths) {
    const path = `/example/${suffix}`;
    ancestorDenied(() => projection.get(path));
    ancestorDenied(() => projection.getNamespace(path));
    ancestorDenied(() => projection.get(path) ?? "caller default");
    for (const layer of ["base", "cleared", "resolved", "absent"]) ancestorDenied(() => projection.getAtLayer(layer, path));
    const inspection = projection.inspect(path);
    ancestorCheck(inspection.effective.state === "redacted" && !Object.hasOwn(inspection.effective, "value"), "redacted descendant effective");
    for (const row of inspection.contributions) ancestorCheck(row.state !== "value" && !Object.hasOwn(row, "value"), "no contributor reference or payload");
    const serialized = JSON.stringify(inspection);
    ancestorCheck(!serialized.includes("SENSITIVE_PAYLOAD") && !serialized.includes("BACKEND_REFERENCE") && !serialized.includes("example.sensitive"), "serialized inspection safe");
    ancestorCheck(Object.isFrozen(inspection) && Object.isFrozen(inspection.contributions), "frozen denial DTO");
  }
}

function ancestorPublicChecks(projection) {
  ancestorCheck(projection.get("/example/safeAlias/public") === "public source", "public resolved alias descendant");
  ancestorCheck(projection.getAtLayer("resolved", "/example/safeAlias/nested/public") === "nested source", "public layer descendant");
  ancestorCheck(projection.getNamespace("/example/safeAlias").nested.public === "nested source", "public namespace");
  ancestorCheck(projection.get("/example/mixed/public") === "keep sibling", "partial aggregate is not a denied ancestor");
  ancestorCheck(projection.get("/example/sharedSafe/public") === "shared public value", "shared value context cannot inherit another alias denial");
  ancestorCheck(projection.get("/example/mixed").public === "keep sibling" && !Object.hasOwn(projection.get("/example/mixed"), "denied"), "mixed sibling pruning");
  ancestorCheck(projection.get("/example/publicSource/missing") === undefined, "ordinary declared missing");
  let unknown = false;
  try { projection.get("/example/publicSource/unknown"); } catch (error) { unknown = error.code === "SCHEMA_NOT_REGISTERED"; }
  ancestorCheck(unknown, "ordinary unknown category unchanged");
  const serialized = JSON.stringify(projection.entries());
  ancestorCheck(!serialized.includes("SENSITIVE_PAYLOAD") && !serialized.includes("BACKEND_REFERENCE") && !serialized.includes("example.sensitive"), "published entries safe");
}

export function exerciseAncestorProjection(support, engine) {
  const reader = ancestorReader(support);
  const { snapshot, raw } = ancestorSnapshot(engine);
  const projection = support.createRegisteredReadProjection(reader, snapshot, { identity: { environment: "test", scopePath: [] }, revision: "r" });
  const paths = ["alias", "alias/public", "alias/nested", "alias/nested/public", "alias/missing",
    "secret", "secret/key", "secret/nested", "secret/nested/key", "mount", "mount/source",
    "aliasArray", "aliasArray/0", "aliasArray/0/public", "cycleA/public", "cycleB/public", "sharedDenied/public"];
  ancestorCheck(projection.get("/example/sharedSafe/public") === "shared public value", "shared value public context first");
  ancestorSurfaceChecks(projection, paths);
  ancestorPublicChecks(projection);
  ancestorCheck(raw.secret.key === "BACKEND_REFERENCE" && !Object.isFrozen(raw.secret), "borrowed fixture untouched");
  return { reader, snapshot, projection, paths, denied: ancestorDenied };
}

export const ancestorProjectionExercise = `(() => { ${[ancestorCheck, ancestorDenied, ancestorReader, ancestorSnapshot,
  ancestorSurfaceChecks, ancestorPublicChecks, exerciseAncestorProjection].map(fn => fn.toString()).join("\n")}
  exerciseAncestorProjection(support, engine); })();`;
