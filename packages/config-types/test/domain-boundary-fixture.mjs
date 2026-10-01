// The same real exported-boundary matrix is also embedded in installed Node/browser probes.
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
  }
  let counterScopes = 0;
  for (const prototype of [Object.prototype, Array.prototype]) {
    for (const key of ["0", "1", "700"]) {
      const original = Object.getOwnPropertyDescriptor(prototype, key);
      let getters = 0, setters = 0, failure;
      try {
        Object.defineProperty(prototype, key, { configurable: true, get() { getters++; return "ambient"; }, set() { setters++; } });
        for (let repeat = 0; repeat < 2; repeat++) {
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
        }
      } catch (error) { failure = error; }
      finally { if (original) Object.defineProperty(prototype, key, original); else Reflect.deleteProperty(prototype, key); }
      if (failure) throw failure;
      check(getters === 0 && setters === 0, `domain numeric ${key}: ${getters}/${setters}`);
      counterScopes++;
    }
  }
  check(callbacks === 0, "callables must never execute during shape checks");
  return { cases: cases.length, counterScopes, callbacks };
}
