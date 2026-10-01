import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { pushOwn } from "./own-data";
import {
  COMPOSITION_KEYWORDS,
  getCompositionBranches,
} from "./schema-validation-composition";
import { ownField } from "./schema-validation-own-data";
import { isSchemaArray } from "./schema-validation-support";

export type SchemaGraphFrame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly invalidMessage: string;
    }
  | { readonly kind: "exit"; readonly value: ConfigurationPropertySchema };

export function pushSchemaChildren(
  schema: ConfigurationPropertySchema,
  pending: SchemaGraphFrame[],
  composed: boolean,
): void {
  if (composed) pushCompositionChildren(schema, pending);
  pushItemChildren(schema, pending);
  const additional = ownField(schema, "additionalProperties");
  if (additional !== undefined && typeof additional !== "boolean") {
    pushOwn(pending, {
      kind: "enter",
      value: additional,
      invalidMessage:
        "additionalProperties must be a boolean or schema object with a supported non-empty type",
    });
  }
  pushSchemaMapChildren(schema, "patternProperties", pending);
  pushSchemaMapChildren(schema, "properties", pending);
}

function pushSchemaMapChildren(
  schema: ConfigurationPropertySchema,
  key: "properties" | "patternProperties",
  pending: SchemaGraphFrame[],
): void {
  const map = ownField(schema, key);
  if (map === undefined) return;
  const names = Object.keys(map);
  for (let index = names.length - 1; index >= 0; index--) {
    const name = names[index];
    if (name === undefined) continue;
    pushOwn(pending, {
      kind: "enter",
      value: ownField(map, name),
      invalidMessage: `${key} entry ${JSON.stringify(name)} must be a schema object with a supported non-empty type`,
    });
  }
}

function pushItemChildren(
  schema: ConfigurationPropertySchema,
  pending: SchemaGraphFrame[],
): void {
  const items = ownField(schema, "items");
  if (items === undefined) return;
  if (!isSchemaArray(items)) {
    pushOwn(pending, {
      kind: "enter",
      value: items,
      invalidMessage:
        "items must be a schema object or dense array of schema objects with supported non-empty types",
    });
    return;
  }
  for (let index = items.length - 1; index >= 0; index--) {
    pushOwn(pending, {
      kind: "enter",
      value: ownField(items, index),
      invalidMessage: `items entry ${String(index)} must be a schema object with a supported non-empty type`,
    });
  }
}

export function pushCompositionChildren(
  schema: ConfigurationPropertySchema,
  pending: SchemaGraphFrame[],
): void {
  for (
    let keyIndex = COMPOSITION_KEYWORDS.length - 1;
    keyIndex >= 0;
    keyIndex--
  ) {
    const keyword = COMPOSITION_KEYWORDS[keyIndex];
    if (keyword === undefined || !Object.hasOwn(schema, keyword)) continue;
    const branches = getCompositionBranches(schema, keyword);
    for (let index = branches.length - 1; index >= 0; index--) {
      pushOwn(pending, {
        kind: "enter",
        value: ownField(branches, index),
        invalidMessage:
          keyword === "not"
            ? "not must be a schema object with a supported non-empty type"
            : `${keyword} branch ${String(index)} must be a schema object with a supported non-empty type`,
      });
    }
  }
}
