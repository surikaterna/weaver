// Ordinary exported contracts also run in installed Node/browser consumers.
export function exerciseDomainBoundaries(types, engine, registry) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  let callbacks = 0;
  const call = () => { callbacks++; };
  const identity = { environment: "test:雪", scopePath: [{ scopeId: "tenant", value: "a" }, { scopeId: "site", value: "" }] };
  const missing = { state: "missing" };
  const inspection = { path: "/example/literal.dot", identity, revision: "r", effective: missing,
    contributions: [{ layer: "base", providerId: "provider", state: "missing" }] };
  const reader = { identity, revision: "r", mode: "live", degradedProviders: [],
    get: call, getWithDefault: call, getAtLayer: call, getNamespace: call, inspect: call, onChange: call };
  const scoped = { namespace: "/example", identity, get: call, getWithDefault: call, getAtLayer: call,
    getNamespace: call, inspect: call, onChange: call, withScope: call, dispose: call };
  const cases = [
    [types.serviceIdSchema, "example", "_bad"],
    [types.providerIdSchema, "panel.dot", ".."],
    [types.registrationEnvironmentSchema, "test:雪", "constructor"],
    [types.publicConfigPathSchema, "/example/literal.dot/", "/_weaver/hidden"],
    [types.slotPathSchema, "/plugins", "/plugins/"],
    [types.canonicalConfigurationPathSchema, "/example/😀", "/example/.."],
    [types.relativeConfigurationPathSchema, ["literal.dot", "😀"], []],
    [types.configurationServiceIdentitySchema, identity, { ...identity, scopePath: [identity.scopePath[0], identity.scopePath[0]] }],
    [types.configurationInspectionValueSchema, { state: "value", value: { public: "yes" } }, { state: "redacted", value: "leak" }],
    [types.configurationLayerContributionSchema, inspection.contributions[0], { layer: "base", providerId: "", state: "missing" }],
    [types.hydratedConfigurationInspectionSchema, inspection, { ...inspection, effectiveLayer: "base" }],
    [types.configurationEffectiveChangeSchema, { path: "/example", identity, revision: "r", previous: missing, current: missing, cause: "reload", reloadBehavior: "hot" }, {}],
    [types.configurationServiceWriteOptionsSchema, { layer: "base" }, { layer: "" }],
    [types.configurationServiceWriteResultSchema, { success: false, error: { code: "FORBIDDEN", message: "denied" }, outcome: "rejected" }, { success: false, error: { code: "FORBIDDEN", message: "denied" }, outcome: "unknown" }],
    [types.hydratedConfigurationReaderSchema, reader, { ...reader, get: 1 }],
    [types.hydratedConfigurationServiceSchema, { ...reader, getForScope: call, preloadScope: call, set: call, remove: call, reloadProvider: call, flush: call, dispose: call }, reader],
    [types.hydratedScopedConfigurationServiceSchema, scoped, { ...scoped, namespace: "/" }],
    [types.hydratedServiceConfigurationServiceSchema, { ...scoped, getFromNamespace: call, pendingRestart: false, onRestartRequired: call, acknowledgeRestart: call }, scoped],
    [engine.canonicalConfigPathSchema, { path: "/example/literal.dot", segments: ["example", "literal.dot"], storageKey: "example[literal.dot]" }, { path: "/example", segments: ["other"], storageKey: "example" }],
    [engine.resolutionPathSchema, ["example", "literal.dot"], [1]],
    [engine.resolutionOriginSchema, { layer: "base", providerId: "p", rank: 0 }, { layer: "", providerId: "p", rank: 0 }],
    [engine.resolutionLayerSchema, { layer: "base", providerId: "p", rank: 0, entries: { example: "yes" } }, { layer: "base", providerId: "p", rank: Infinity, entries: {} }],
    [engine.resolutionCeilingSchema, { path: ["example"], maxRank: 0 }, { path: ["constructor"], maxRank: 0 }],
    [engine.resolutionSnapshotInputSchema, { configuredRanks: [0], layers: [], ceilings: [] }, { configuredRanks: [], layers: [], ceilings: [] }],
    [engine.configurationSnapshotSchema, { entries: {}, layers: [] }, { entries: [], layers: [] }],
    [engine.resolutionContributionSchema, { origin: { layer: "base", providerId: "p", rank: 0 }, present: false, value: undefined }, {}],
    [engine.resolvedPathInspectionSchema, { path: [], present: false, effectiveValue: undefined, contributions: [] }, { path: [1], present: false, effectiveValue: undefined, contributions: [] }],
  ];
  if (registry) {
    cases.push([registry.registeredReadProjectionContextSchema, { identity, revision: "r" }, { identity, revision: "" }]);
    cases.push([registry.registeredReadProjectionSchema, { get: call, getAtLayer: call, getNamespace: call, inspect: call, entries: call }, {}]);
    check(registry.registeredReadProjectionSchema.out.pick({ entries: true }).safeParse({ entries: call }).success, "native callable pick");
    check(registry.registeredReadProjectionContextSchema.out.unwrap().shape.revision.safeParse("r").success, "native context shape");
    const accessor = { getAtLayer: call, getNamespace: call, inspect: call, entries: call };
    Object.defineProperty(accessor, "get", { enumerable: true, get() { callbacks++; return call; } });
    check(!registry.registeredReadProjectionSchema.safeParse(accessor).success, "own callable accessor rejection");
    const parsed = registry.registeredReadProjectionSchema.parse({ get: call, getAtLayer: call, getNamespace: call, inspect: call, entries: call });
    check(parsed.get === call && parsed.entries === call, "captured callable identity");
    const reserved = { ...parsed };
    Object.defineProperty(reserved, "__proto__", { value: {}, enumerable: true });
    check(!registry.registeredReadProjectionSchema.safeParse(reserved).success, "strict callable metadata rejects reserved own fields");
  }
  const accessorIdentity = { scopePath: [] };
  Object.defineProperty(accessorIdentity, "environment", { enumerable: true, get() { callbacks++; return "test"; } });
  check(!types.configurationServiceIdentitySchema.safeParse(accessorIdentity).success, "own identity accessor rejection");
  const accessorOrigin = { providerId: "p", rank: 0 };
  Object.defineProperty(accessorOrigin, "layer", { enumerable: true, get() { callbacks++; return "base"; } });
  try { engine.resolutionOriginSchema.parse(accessorOrigin); throw Error("missing accessor rejection"); }
  catch (error) { check(error.code === "VALIDATION_ERROR", "typed snapshot accessor rejection"); }
  check(types.serviceIdSchema.min(2).safeParse("example").success, "native string extension");
  check(types.relativeConfigurationPathSchema.out.unwrap().rest(types.providerIdSchema).safeParse(["literal.dot", "panel"]).success, "native tuple rest");
  const identityObject = types.configurationServiceIdentitySchema.out.unwrap();
  check(identityObject.pick({ environment: true }).safeParse({ environment: "test" }).success, "native object pick");
  check(identityObject.omit({ scopePath: true }).safeParse({ environment: "test" }).success, "native object omit");
  check(identityObject.extend({ revision: types.hydratedConfigurationReaderSchema.out.shape.revision }).safeParse({ ...identity, revision: "r" }).success, "native object extend");
  check(engine.resolutionOriginSchema.out.unwrap().shape.rank.safeParse(0).success, "native origin shape");
  check(engine.canonicalConfigPathSchema.out.unwrap().shape.storageKey.safeParse("example").success, "native canonical shape");
  for (const [schema, good, bad] of cases) {
    check(schema.safeParse(good).success, "valid domain data");
    check(!schema.safeParse(bad).success, "invalid domain data");
    try { schema.parse(bad); throw Error("missing parse error"); }
    catch (error) { check(error.name === "ZodError", "ordinary invalid ZodError"); }
  }
  const path = engine.parseCanonicalConfigPath("/example/literal.dot");
  check(path.segments[1] === "literal.dot", "canonical literal segments");
  check(engine.canonicalConfigPathFromStorageKey(path.storageKey).path === path.path, "same storage codec");
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [
    { layer: "base", providerId: "p", rank: 0, entries: { example: { "literal.dot": "yes" } } },
  ] });
  check(engine.inspectResolvedPath(snapshot, ["example", "literal.dot"]).effectiveValue === "yes", "issued inspection");
  check(callbacks === 0, "callables must never execute during shape checks");
  return { cases: cases.length, callbacks };
}
