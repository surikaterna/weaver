import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { writable, WritableMemory, writableOptions } from "./writable-memory.mjs";

const mode = process.argv[2];
const secret = () => Error("INVALID_WATCH_PROVIDER_SECRET");
let rejectLater, assimilations = 0, returnedFunctionCalls = 0, ready = 0;
const malformed = {
  "async-rejection": async () => { throw secret(); },
  "delayed-rejection": () => new Promise((_resolve, reject) => { rejectLater = reject; }),
  "thenable-rejection": () => ({ then(_resolve, reject) { assimilations++; reject(secret()); } }),
  "throwing-then": () => ({ get then() { assimilations++; throw secret(); } }),
  "never-settles": () => ({ then() { assimilations++; } }),
  "resolved-function": () => Promise.resolve(() => { returnedFunctionCalls++; }),
  primitive: () => 42,
  "sync-throw": () => { throw secret(); },
};
assert.ok(Object.hasOwn(malformed, mode));
const providers = ["borrowed-failing", "borrowed", "owned", "invalid"].map(
  id => new WritableMemory(id, id, { alpha: { flag: "initial" } }),
);
const released = [0, 0, 0], closed = [0, 0, 0, 0], hints = [];
for (const [index, provider] of providers.entries()) {
  provider.dispose = () => { closed[index]++; };
  provider.onExternalChange = callback => {
    hints.push(callback);
    callback([]);
    return () => {
      released[index]++;
      if (index === 0) throw secret();
    };
  };
}
providers[3].onExternalChange = malformed[mode];
const input = writableOptions(providers);
for (const [index, binding] of input.providers.entries()) {
  binding.watch = true;
  if (index >= 2) binding.ownership = { kind: "owned", dispose: () => {
    providers[index].dispose();
    if (index === 2) throw secret();
  } };
}
let failure;
try {
  await writable({ provider: providers[0], input, host: { onAuthorityReady() { ready++; } } });
} catch (error) { failure = error; }
assert.equal(failure?.code, "VALIDATION_ERROR");
assert.equal(failure.message, "Provider watch did not return an unsubscribe function");
assert.deepEqual(failure.details.cleanupFailedResources, ["borrowed-failing", "owned"]);
assert.doesNotMatch(JSON.stringify(failure), /SECRET/);
// Reject only after factory failure, then cross the actual unhandled-rejection turn.
rejectLater?.(secret());
for (const hint of hints) hint([]);
await nextTurn();
await nextTurn();
assert.equal(assimilations, ["thenable-rejection", "throwing-then", "never-settles"].includes(mode) ? 1 : 0);
assert.equal(returnedFunctionCalls, 0);
assert.deepEqual(released, [1, 1, 1]);
assert.deepEqual(closed, [0, 0, 1, 1]);
assert.deepEqual(providers.map(provider => provider.loads), [1, 1, 1, 1]);
assert.equal(ready, 0);
console.log(JSON.stringify({ mode, code: failure.code, message: failure.message, released, closed, ready }));
