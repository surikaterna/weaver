import { parseServerEnv } from "./server-env";

describe("schema identity operator maximum", () => {
  it("accepts canonical integers at and above the default", () => {
    expect(
      parseServerEnv({ WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE: "50" })
        .WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE,
    ).toBe(50);
    expect(
      parseServerEnv({ WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE: "250" })
        .WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE,
    ).toBe(250);
  });

  it.each([
    "",
    "0",
    "49",
    "01",
    "50.0",
    " 50",
    "9007199254740992",
  ])("rejects invalid supplied env %s", (value) => {
    expect(() =>
      parseServerEnv({ WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE: value }),
    ).toThrow("Invalid server environment");
  });
});
