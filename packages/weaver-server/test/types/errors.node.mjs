import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationMutationResultSchema,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import {
  createWeaverError,
  HTTP_STATUS_MAP,
  httpStatusForError,
  weaverErrorCodes,
  weaverErrorSchema,
} from "../../src/types/errors.ts";
import { writeFailureResponse } from "../../src/transport/rest-route-boundary.ts";

test("generic error statuses remain complete and preserve historical mappings", () => {
  const expected = {
    NOT_FOUND: 404, UNSUPPORTED_OPERATION: 501, SCHEMA_NOT_REGISTERED: 400,
    WRITE_UNAVAILABLE: 503, WRITE_ERROR: 500, WRITE_OUTCOME_UNKNOWN: 500,
    DISPOSED: 410, UNAUTHORIZED: 401, FORBIDDEN: 403, SCOPE_NOT_FOUND: 404,
    SCOPE_NOT_LOADED: 409, SCHEMA_CONFLICT: 409, POLICY_VIOLATION: 400,
    VALIDATION_ERROR: 400, GIT_ERROR: 503, SERVER_DEGRADED: 503,
    SIZE_WARNING: 200, QUEUE_FULL: 429, SESSION_REQUIRED: 428,
    SESSION_BLOCKED: 403, REVISION_CONFLICT: 409, INTERNAL_ERROR: 500,
  };
  assert.deepEqual(HTTP_STATUS_MAP, expected);
  assert.deepEqual(new Set(Object.keys(HTTP_STATUS_MAP)), new Set(weaverErrorCodes));
  for (const code of weaverErrorCodes) {
    const status = httpStatusForError(code);
    assert.equal(status, expected[code]);
    assert.equal(Number.isFinite(status) && Number.isInteger(status), true);
  }
});

test("shared error factories and schemas accept the two approved codes", () => {
  for (const code of ["DISPOSED", "WRITE_ERROR"]) {
    const error = createWeaverError(code, "failed", { providerId: "local" });
    assert.equal(error instanceof WeaverErrorInstance, true);
    const data = { code, message: "failed", details: { providerId: "local" } };
    assert.deepEqual(weaverErrorSchema.parse(error), data);
    assert.deepEqual(weaverErrorSchema.parse(JSON.parse(JSON.stringify(data))), data);
    assert.equal("outcome" in error, false);
  }
});

test("legacy REST write statuses and unknown-code fallback remain unchanged", () => {
  const service = { revision: "r1" };
  const recognized = [
    ["SCHEMA_NOT_REGISTERED", 400], ["UNSUPPORTED_OPERATION", 400],
    ["REVISION_CONFLICT", 409], ["VALIDATION_ERROR", 400],
    ["INTERNAL_ERROR", 500], ["SERVER_DEGRADED", 503],
  ];
  for (const [code, status] of recognized) {
    const response = writeFailureResponse(service,
      { success: false, error: { code, message: "failed" } }, "fallback");
    assert.equal(response.status, status);
    assert.equal(weaverErrorSchema.parse(response.body.error).code, code);
  }
  assert.equal(httpStatusForError("UNSUPPORTED_OPERATION"), 501);
  for (const code of ["PROVIDER_UNRECOGNIZED", "DISPOSED", "WRITE_ERROR", "WRITE_OUTCOME_UNKNOWN"]) {
    const response = writeFailureResponse(service,
      { success: false, error: { code, message: "failed" } }, "fallback");
    assert.equal(response.status, 400);
    assert.equal(weaverErrorSchema.parse(response.body.error).code, "VALIDATION_ERROR");
    assert.equal("outcome" in response.body.error, false);
  }
});

test("hydrated unknown outcomes are exclusive to WRITE_OUTCOME_UNKNOWN", () => {
  for (const code of ["DISPOSED", "WRITE_ERROR"]) {
    const error = { code, message: "failed" };
    assert.equal(configurationMutationResultSchema.safeParse(
      { success: false, error, outcome: "rejected", results: [] }).success, true);
    assert.equal(configurationMutationResultSchema.safeParse(
      { success: false, error, outcome: "unknown", results: [] }).success, false);
  }
  for (const code of weaverErrorCodes) {
    const error = { code, message: "failed" };
    const result = { success: false, error, outcome: "unknown", results: [{ index: 0, effect: "unknown", error }] };
    assert.equal(configurationMutationResultSchema.safeParse(result).success,
      code === "WRITE_OUTCOME_UNKNOWN", code);
  }
  assert.equal(configurationMutationResultSchema.safeParse({
    success: false, error: { code: "WRITE_OUTCOME_UNKNOWN", message: "failed" }, outcome: "rejected", results: [],
  }).success, false);
});
