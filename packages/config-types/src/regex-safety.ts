/** Shared registration/runtime policy for user-supplied regex patterns. */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > 200) return false;
  // Reject nested quantifiers: a common ReDoS trigger like (a+)+ or (a*)*.
  if (/([+*}])\s*\)?\s*[+*{]/.test(pattern)) return false;
  return true;
}
