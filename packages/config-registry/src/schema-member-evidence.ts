import { validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { denseMetadata, ownField } from "./structural-witness-own-data";

type Schema = ConfigurationPropertySchema;
/** Declaration evidence, not a schema passed to the value validator. */
export interface MemberEvidence {
  readonly schemas: readonly Schema[];
  readonly unconstrained: boolean;
}

export function allows(schema: Schema, type: "object" | "array"): boolean {
  const declared = ownField(schema, "type");
  if (Array.isArray(declared)) denseMetadata(declared);
  return Array.isArray(declared) ? declared.includes(type) : declared === type;
}

export function validBranch(schema: Schema, candidate: unknown): boolean {
  return validateEffectiveConfiguration(schema, candidate).valid;
}

export function objectMembers(schema: Schema, key: string): MemberEvidence {
  const schemas: Schema[] = [];
  const properties = ownField(schema, "properties");
  if (properties && Object.hasOwn(properties, key)) {
    const declared = ownField(properties, key);
    if (declared) schemas.push(declared);
  }
  for (const [pattern, member] of Object.entries(
    ownField(schema, "patternProperties") ?? {},
  )) {
    if (matchesPattern(pattern, key)) schemas.push(member);
  }
  if (schemas.length) return { schemas, unconstrained: false };
  const additional = ownField(schema, "additionalProperties");
  if (!additional || typeof additional === "boolean")
    return { schemas: [], unconstrained: additional === true };
  return { schemas: [additional], unconstrained: false };
}

function matchesPattern(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern).test(key);
  } catch {
    return false;
  }
}

export function isArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index <= 4_294_967_294;
}

export function arrayMembers(schema: Schema, key: string): MemberEvidence {
  if (!isArrayIndex(key)) return { schemas: [], unconstrained: false };
  const items = ownField(schema, "items");
  if (items === undefined) return { schemas: [], unconstrained: true };
  const member = schemaArray(items) ? ownField(items, Number(key)) : items;
  return { schemas: member ? [member] : [], unconstrained: false };
}

function schemaArray(
  value: Schema | readonly Schema[],
): value is readonly Schema[] {
  return Array.isArray(value);
}
