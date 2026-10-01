// Schema inputs are trusted typed contracts; own membership still excludes inherited declarations.
export function ownField<T extends object, K extends keyof T>(
  target: T,
  key: K,
): T[K] | undefined {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

export function ownEntries<T>(
  value: Readonly<Record<string, T>>,
): [string, T][];
export function ownEntries(value: object): [string, unknown][];
export function ownEntries(value: object): [string, unknown][] {
  return Object.entries(value);
}
