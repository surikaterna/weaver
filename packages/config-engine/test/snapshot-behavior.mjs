export function checkSnapshot(engine, assert) {
  const snapshot = engine.resolveConfigurationSnapshot({
    configuredRanks: [0, 1],
    ceilings: [{ path: ["cfg", "locked"], maxRank: 0 }],
    layers: [
      { layer: "core", providerId: "p0", rank: 0, entries: { cfg: { locked: 1, a: 1, b: 2 } } },
      { layer: "user", providerId: "p1", rank: 1, entries: { cfg: { locked: 9, a: 1, c: 3 } } },
    ],
  });
  const inspect = (...path) => engine.inspectResolvedPath(snapshot, path);
  assert.equal(inspect("cfg", "locked").effectiveValue, 1);
  assert.equal(inspect("cfg", "locked").effectiveLayer, "core");
  assert.equal(inspect("cfg", "a").effectiveLayer, "user");
  assert.equal(inspect("cfg").effectiveLayer, undefined);
  assert.equal(inspect("cfg").contributions.length, 2);
  assert.equal(Object.isFrozen(snapshot.entries.cfg), true);
  const entries = JSON.parse('{"__proto__":{"root":1},"cfg":{"__proto__":{"child":1},"constructor":{"prototype":2},"prototype":3}}');
  const higher = JSON.parse('{"__proto__":{"higher":2},"cfg":{"__proto__":{"higher":2}}}');
  const reserved = engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [], layers: [{ layer: "__proto__", providerId: "constructor", rank: 0, entries }, { layer: "user", providerId: "higher", rank: 1, entries: higher }] });
  const parent = engine.inspectResolvedPath(reserved, ["cfg"]);
  assert.equal(parent.effectiveLayer, undefined);
  assert.equal(Object.hasOwn(parent.effectiveValue, "__proto__"), true);
  assert.equal(Object.hasOwn(engine.configurationSnapshotSchema.parse(reserved).entries, "__proto__"), true);
  assert.equal(Object.hasOwn(engine.resolutionSnapshotInputSchema.parse({ configuredRanks: [0, 1], ceilings: [], layers: reserved.layers }).layers[0].entries, "__proto__"), true);
  const trace = reserved.trace.find(({ path }) => path[0] === "cfg" && path[1] === "__proto__");
  assert.equal(engine.resolutionTraceSchema.parse(trace).origin.providerId, "constructor");
  assert.equal(parent.effectiveValue.__proto__.higher, 2);
  assert.equal(reserved.trace.find(({ path }) => path[0] === "cfg" && path[1] === "__proto__" && path[2] === "higher").origin.providerId, "higher");
  assert.throws(() => engine.inspectResolvedPath(reserved, ["cfg", "__proto__"]), error => error.code === "VALIDATION_ERROR");
  assert.throws(() => engine.resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [{ path: ["__proto__"], maxRank: 0 }], layers: [] }), error => error.code === "VALIDATION_ERROR");
  assert.equal(Object.hasOwn(Object.prototype, "child"), false);
}
