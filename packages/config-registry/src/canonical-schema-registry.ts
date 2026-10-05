import { createRegistryAdapter } from "./internal/server-adapter";
import type {
  CanonicalSchemaRegistry,
  CanonicalSchemaRegistryOptions,
} from "./registry-contracts";
import { canonicalSchemaRegistryOptionsSchema } from "./registry-contracts";

export function createCanonicalSchemaRegistry(
  options: CanonicalSchemaRegistryOptions,
): CanonicalSchemaRegistry {
  const parsed = canonicalSchemaRegistryOptionsSchema.parse(options);
  const adapter = createRegistryAdapter(parsed);
  return {
    ...adapter.reader,
    register(request, context) {
      const prepared = adapter.prepare(request, context);
      if (prepared.result.success) prepared.publish();
      return prepared.result;
    },
  };
}
