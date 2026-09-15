import {
  freezeBuiltinData,
  type ObjectConfigurationPropertySchema,
} from "@weaver-conf/config-types";

/** Neither map mutators nor mutable schema references escape the compiler. */
export function immutableSchemaMap(
  entries: Iterable<readonly [string, ObjectConfigurationPropertySchema]>,
): ReadonlyMap<string, ObjectConfigurationPropertySchema> {
  const data = new Map(
    [...entries].map(([key, value]) => [
      key,
      freezeBuiltinData(structuredClone(value)),
    ]),
  );
  const view: ReadonlyMap<string, ObjectConfigurationPropertySchema> =
    Object.freeze({
      size: data.size,
      get: (key: string) => data.get(key),
      has: (key: string) => data.has(key),
      entries: () => data.entries(),
      keys: () => data.keys(),
      values: () => data.values(),
      [Symbol.iterator]: () => data[Symbol.iterator](),
      forEach(
        callback: (
          value: ObjectConfigurationPropertySchema,
          key: string,
          map: ReadonlyMap<string, ObjectConfigurationPropertySchema>,
        ) => void,
        thisArg?: unknown,
      ): void {
        for (const [key, value] of data)
          callback.call(thisArg, value, key, view);
      },
    });
  return view;
}
