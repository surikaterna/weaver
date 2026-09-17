export function deepEqual(a: unknown, b: unknown): boolean {
  const pending: ReadonlyArray<unknown>[] = [[a, b]];
  const visited = new WeakMap<object, WeakSet<object>>();

  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) continue;
    const [left, right] = pair;
    if (left === right) continue;
    if (!isComparableObject(left) || !isComparableObject(right)) return false;
    if (alreadyVisited(left, right, visited)) continue;
    if (!queueMembers(left, right, pending)) return false;
  }
  return true;
}

function isComparableObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function alreadyVisited(
  left: object,
  right: object,
  visited: WeakMap<object, WeakSet<object>>,
): boolean {
  const rights = visited.get(left);
  if (rights?.has(right) === true) return true;
  if (rights === undefined) visited.set(left, new WeakSet([right]));
  else rights.add(right);
  return false;
}

function queueMembers(
  left: object,
  right: object,
  pending: ReadonlyArray<unknown>[],
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return queueArrayMembers(left, right, pending);
  }
  return queueObjectMembers(left, right, pending);
}

function queueArrayMembers(
  left: object,
  right: object,
  pending: ReadonlyArray<unknown>[],
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (Object.hasOwn(left, index) !== Object.hasOwn(right, index))
      return false;
    if (Object.hasOwn(left, index)) pending.push([left[index], right[index]]);
  }
  return true;
}

function queueObjectMembers(
  left: object,
  right: object,
  pending: ReadonlyArray<unknown>[],
): boolean {
  const leftRecord = toRecord(left);
  const rightRecord = toRecord(right);
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(rightRecord, key)) return false;
    pending.push([leftRecord[key], rightRecord[key]]);
  }
  return true;
}

function toRecord(value: object): Record<string, unknown> {
  return isRecordObject(value) ? value : {};
}

function isRecordObject(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}
