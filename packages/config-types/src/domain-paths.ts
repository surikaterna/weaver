const reserved = ["__proto__", "constructor", "prototype"];
const reservedSet = new Set(reserved);
const reservedPattern = reserved.join("|");
export const serviceIdPattern = new RegExp(
  `^(?!(?:${reservedPattern})$)[a-z][a-z0-9-]*$`,
);
export const providerIdPattern = new RegExp(
  `^(?!(?:${reservedPattern})$)[A-Za-z0-9][A-Za-z0-9._-]*$`,
);

export function isReservedPathSegment(segment: string): boolean {
  return reservedSet.has(segment);
}
export function isRegistrationEnvironment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !isReservedPathSegment(value)
  );
}
export function isPublicSlashPath(value: unknown): value is string {
  return typeof value === "string" && publicSlashPathIssue(value) === undefined;
}

export function publicSlashPathIssue(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a path string";
  if (!value.startsWith("/")) return "Path must start with /";
  if (value === "/") return "Path must not be root";
  if (value.includes("//")) return "Path must not contain empty segments";
  if (value === "/_weaver" || value.startsWith("/_weaver/"))
    return "Path is reserved for Weaver metadata";
  for (const segment of value.slice(1).split("/")) {
    if (segment.includes("[") || segment.includes("]"))
      return "Path must use canonical slash segments";
    if (isReservedPathSegment(segment))
      return `Path segment "${segment}" is not allowed`;
  }
  return undefined;
}

export function slotPathIssue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 1 && value.endsWith("/"))
    return "slotPath must not end with /";
  return publicSlashPathIssue(value);
}
export function isLiteralConfigurationSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    value !== "_weaver" &&
    !/[/[\]]/.test(value) &&
    !isReservedPathSegment(value)
  );
}
export function isCanonicalConfigurationPath(value: unknown): value is string {
  return (
    isPublicSlashPath(value) &&
    value.slice(1).split("/").every(isLiteralConfigurationSegment)
  );
}
