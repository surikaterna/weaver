import assert from "node:assert/strict";
import { createControlService } from "../src/core/control-service.ts";
import { configuration, record } from "./validated-fixtures.mjs";

export const numericSchema = { type: "object", additionalProperties: false, properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } } };

/** Explicit real-adapter metadata and schema declarations, on the adapter's own control layer. */
export async function initializeOwned(options, definitions, schemas = { svc: numericSchema }, scopes = []) {
  const control = await createControlService({ ...options, flushDebounceMs: 60000 });
  const state = configuration(control.binding, options.providers, [], [], scopes);
  state.infrastructure.generations.g1.providers = definitions;
  const initialized = await control.initialize(state);
  assert.equal(initialized.success, true, initialized.error?.message);
  for (const [serviceId, schema] of Object.entries(schemas)) {
    const request = { ...record(serviceId, schema).request, environment: options.environment };
    const result = await control.registerSchema(request);
    assert.equal(result.success, true, result.error?.message);
  }
  const inventory = options.scopeInventory ?? { version: 1, revision: "0", contexts: {} };
  const result = await control.initializeInventory(inventory, control.revision);
  assert.equal(result.success, true, result.error?.message);
  assert.equal((await control.finalize(control.revision)).success, true);
  return control.application();
}
