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
}
