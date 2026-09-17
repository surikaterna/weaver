/** Defaults are inserted after resolution, so even malformed marker discriminants are forbidden. */
export function containsRegistrationDefaultMarker(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some(containsRegistrationDefaultMarker);
  if (
    "_weaver" in value &&
    (value._weaver === "mount" || value._weaver === "secret-ref")
  )
    return true;
  return Object.values(value).some(containsRegistrationDefaultMarker);
}
