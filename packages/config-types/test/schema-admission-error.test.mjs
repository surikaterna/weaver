import {
  weaverErrorCodes,
  weaverErrorCodeSchema,
  weaverErrorSchema,
  writeResultSchema,
} from "../src/index.ts";
import { writeResultSchema as subpathWriteResultSchema } from "../src/subpaths/schemas.ts";

test("registered-schema denial is typed across existing error and write contracts", () => {
  const error = { code: "SCHEMA_NOT_REGISTERED", message: "No declaration" };
  expect(weaverErrorCodes).toContain(error.code);
  expect(weaverErrorCodeSchema.parse(error.code)).toBe(error.code);
  expect(weaverErrorSchema.parse(JSON.parse(JSON.stringify(error)))).toEqual(error);
  expect(writeResultSchema.parse({ success: false, error })).toEqual({
    success: false, error,
  });
  expect(subpathWriteResultSchema.parse({ success: false, error }).error?.code).toBe(error.code);
  expect(weaverErrorCodeSchema.safeParse("SILENT_ALLOW").success).toBe(false);
});
