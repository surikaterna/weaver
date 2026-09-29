import {
  createWeaverError,
  weaverErrorSchema,
  httpStatusForError,
  weaverErrorCodes,
  HTTP_STATUS_MAP,
} from "../../src/types/errors.ts";
import { writeFailureResponse } from "../../src/transport/rest-route-boundary.ts";

test("createWeaverError returns correct structure", () => {
  const err = createWeaverError("NOT_FOUND", "key missing", { key: "foo" });
  expect(err.code).toBe("NOT_FOUND");
  expect(err.message).toBe("key missing");
  expect(err.details).toEqual({ key: "foo" });
});

test("createWeaverError omits details when not provided", () => {
  const err = createWeaverError("UNAUTHORIZED", "bad token");
  expect(err.code).toBe("UNAUTHORIZED");
  expect(err.message).toBe("bad token");
  expect(err.details).toBe(undefined);
});

test("weaverErrorSchema validates correctly", () => {
  const result = weaverErrorSchema.safeParse({
    code: "FORBIDDEN",
    message: "denied",
  });
  expect(result.success).toBe(true);
});

test("weaverErrorSchema rejects invalid code", () => {
  const result = weaverErrorSchema.safeParse({
    code: "INVALID_CODE",
    message: "test",
  });
  expect(result.success).toBe(false);
});

test("error codes include SCOPE_NOT_FOUND and SCOPE_NOT_LOADED", () => {
  expect(weaverErrorCodes.includes("SCOPE_NOT_FOUND")).toBeTruthy();
  expect(weaverErrorCodes.includes("SCOPE_NOT_LOADED")).toBeTruthy();
});

test("httpStatusForError returns correct status for each code", () => {
  for (const code of weaverErrorCodes) {
    const status = httpStatusForError(code);
    expect(status).toBe(HTTP_STATUS_MAP[code]);
    expect(typeof status).toBe("number");
  }
});

test("write errors preserve authorized schema denial and array codes without changing other unsupported statuses", () => {
  const service = { revision: "rev-test" };
  for (const [code, status] of [
    ["SCHEMA_NOT_REGISTERED", 400], ["VALIDATION_ERROR", 400],
    ["UNSUPPORTED_OPERATION", 400], ["REVISION_CONFLICT", 409],
    ["INTERNAL_ERROR", 500],
  ]) {
    const response = writeFailureResponse(service, { success: false, error: { code, message: "denied" } }, "fallback");
    expect(response.status).toBe(status);
    expect(weaverErrorSchema.parse(response.body.error).code).toBe(code);
  }
  expect(httpStatusForError("UNSUPPORTED_OPERATION")).toBe(501);
  expect(writeFailureResponse(service, { success: false, error: { code: "PROVIDER_UNRECOGNIZED", message: "unknown" } }, "fallback").body.error.code).toBe("VALIDATION_ERROR");
});
