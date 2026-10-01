function chain(depth, leaf) {
  let value = leaf;
  for (let index = 0; index < depth; index++) value = { next: value };
  return value;
}

export function checkCompactSnapshots(engine, assert) {
  const layer = (entries, rank) => ({ layer: rank ? "user" : "core", providerId: `p${rank}`, rank, entries });
  const resolve = (layers, ceilings = []) => engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1, 2], layers, ceilings });
  for (const depth of [3000, 10000]) checkDeep(engine, assert, depth, layer, resolve);
  checkDeepInheritedWorklists(engine, assert);
  for (const depth of [4, 8, 12, 30]) {
    let value = { leaf: 1 };
    for (let index = 0; index < depth; index++) value = { left: value, right: value };
    const snapshot = resolve([layer({ cfg: value }, 0)]);
    const path = ["cfg", ...Array(depth).fill("left"), "leaf"];
    assert.equal(engine.inspectResolvedPath(snapshot, path).effectiveProviderId, "p0");
    assert.equal(snapshot.entries.cfg.left, snapshot.entries.cfg.right);
    assert.notEqual(snapshot.entries.cfg, value);
    assert.equal(Object.isFrozen(value), false);
    assert.equal(Object.hasOwn(snapshot, "trace"), false);
    checkPolicyAliases(engine, assert, value, depth, layer, resolve);
  }
}

function checkDeep(engine, assert, depth, layer, resolve) {
  const low = chain(depth, { leaf: 1, retained: 2, own: undefined });
  const high = chain(depth, { leaf: 1, extra: 3, own: undefined });
  const path = ["cfg", ...Array(depth).fill("next")];
  assert.equal(engine.deepMerge({}, { cfg: low }).cfg, low);
  const initial = resolve([layer({ cfg: low }, 0)]);
  assert.equal(engine.inspectResolvedPath(initial, [...path, "own"]).present, true);
  const snapshot = resolve([layer({ cfg: low }, 0), layer({ cfg: high }, 1)]);
  assert.equal(engine.inspectResolvedPath(snapshot, [...path, "leaf"]).effectiveProviderId, "p1");
  assert.equal(engine.inspectResolvedPath(snapshot, [...path, "retained"]).effectiveProviderId, "p0");
  assert.equal(engine.inspectResolvedPath(snapshot, [...path, "own"]).effectiveProviderId, "p0");
  assert.equal(engine.inspectResolvedPath(snapshot, ["cfg"]).effectiveLayer, undefined);
  assert.equal(engine.inspectResolvedPath(snapshot, ["cfg"]).effectiveValue, snapshot.entries.cfg);
  const legacy = engine.deepMerge({ cfg: low }, { cfg: high });
  let leaf = legacy.cfg;
  for (let index = 0; index < depth; index++) leaf = leaf.next;
  assert.equal(leaf.retained, 2);
  assert.equal(leaf.leaf, 1);
  checkDeepCallbacks(engine, assert, low, high);
  const reset = resolve([layer({ cfg: low }, 0), layer({ cfg: null }, 1), layer({ cfg: high }, 2)]);
  assert.equal(engine.inspectResolvedPath(reset, [...path, "retained"]).present, false);
  assert.equal(engine.inspectResolvedPath(reset, [...path, "own"]).effectiveProviderId, "p2");
  const atomic = resolve([layer({ cfg: low }, 0), layer({ cfg: [high] }, 1)]);
  assert.equal(engine.inspectResolvedPath(atomic, ["cfg", "0", ...path.slice(1), "leaf"]).effectiveProviderId, "p1");
  const afterArray = resolve([layer({ cfg: [] }, 0), layer({ cfg: high }, 1)]);
  assert.equal(engine.inspectResolvedPath(afterArray, [...path, "own"]).effectiveProviderId, "p1");
  checkDeepCeilings(engine, assert, depth, path, layer, resolve);
  for (const fake of [{ ...snapshot }, engine.configurationSnapshotSchema.parse(snapshot)]) {
    assert.throws(() => engine.inspectResolvedPath(fake, path), error => error.code === "VALIDATION_ERROR");
  }
}

function checkDeepInheritedWorklists(engine, assert) {
  const wide = { leaf: 1 };
  for (let index = 0; index < 699; index++) wide[`field${index}`] = index;
  const value = chain(10000, wide);
  const path = ["cfg", ...Array(10000).fill("next"), "leaf"];
  let getters = 0, setters = 0, inspection;
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "700");
  Object.defineProperty(Object.prototype, "700", { configurable: true, get() { getters++; }, set() { setters++; } });
  try {
    const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [{ path, maxRank: 0 }], layers: [{ layer: "core", providerId: "p", rank: 0, entries: { cfg: value } }] });
    inspection = engine.inspectResolvedPath(snapshot, path);
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, "700", descriptor);
    else delete Object.prototype["700"];
  }
  assert.equal(inspection.effectiveValue, 1);
  assert.equal(getters, 0);
  assert.equal(setters, 0);
}

function checkDeepCallbacks(engine, assert, low, high) {
  const first = { cfg: low }, second = { cfg: high };
  const calls = [];
  const merge = (base, override) => { calls.push([base, override]); return engine.deepMerge(base, override); };
  const result = engine.resolveConfiguration({ layers: [{ layer: "core", entries: first, merge }, { layer: "user", entries: {}, merge }, { layer: "user", entries: second, merge }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], first);
  assert.equal(calls[1][1], second);
  assert.equal(calls[1][0].cfg, low);
  assert.equal(result.provenance.get("cfg"), "user");
}

function checkDeepCeilings(engine, assert, depth, path, layer, resolve) {
  const low = chain(depth, { locked: 1, open: 1 });
  const high = chain(depth, { locked: 1, open: 2 });
  const ceilings = [{ path: ["cfg"], maxRank: 1 }, { path: [...path, "locked"], maxRank: 0 }, { path: [...path, "open"], maxRank: 2 }];
  const snapshot = resolve([layer({ cfg: low }, 0), layer({ cfg: high }, 1), layer({ cfg: high }, 2)], ceilings);
  assert.equal(engine.inspectResolvedPath(snapshot, [...path, "locked"]).effectiveProviderId, "p0");
  assert.equal(engine.inspectResolvedPath(snapshot, [...path, "open"]).effectiveProviderId, "p1");
  const missing = chain(depth, { open: 1 });
  for (const atomic of [null, 7, []]) {
    const blocked = resolve([layer({ cfg: missing }, 0), layer({ cfg: chain(depth, atomic) }, 1)], ceilings);
    assert.equal(engine.inspectResolvedPath(blocked, [...path, "open"]).effectiveValue, 1);
  }
  const arrayPath = ["cfg", "0", ...path.slice(1), "locked"];
  const blockedArrayReset = resolve([layer({ cfg: [] }, 0), layer({ cfg: high }, 1)], [{ path: arrayPath, maxRank: 0 }]);
  assert.equal(engine.inspectResolvedPath(blockedArrayReset, ["cfg"]).effectiveValue.length, 0);
  assert.equal(engine.inspectResolvedPath(blockedArrayReset, ["cfg"]).effectiveProviderId, "p0");
}

function checkPolicyAliases(engine, assert, value, depth, layer, resolve) {
  const layers = [layer({ a: value, b: value }, 0), layer({ a: value, b: value }, 1)];
  const protectedPath = ["a", ...Array(depth).fill("left"), "leaf"];
  const snapshot = resolve(layers, [{ path: protectedPath, maxRank: 0 }]);
  assert.equal(engine.inspectResolvedPath(snapshot, protectedPath).effectiveProviderId, "p0");
  assert.equal(engine.inspectResolvedPath(snapshot, ["b", ...protectedPath.slice(1)]).effectiveProviderId, "p1");
  assert.equal(engine.inspectResolvedPath(snapshot, ["a"]).effectiveLayer, undefined);
  assert.equal(engine.inspectResolvedPath(snapshot, ["b"]).effectiveProviderId, "p1");
  assert.notEqual(snapshot.entries.a, snapshot.entries.b);
}

export const compactFixtureSource = [chain, checkCompactSnapshots, checkDeep, checkDeepInheritedWorklists, checkDeepCallbacks, checkDeepCeilings, checkPolicyAliases].map(fn => fn.toString()).join("\n");
