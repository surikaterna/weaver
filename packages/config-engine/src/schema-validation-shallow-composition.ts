import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  COMPOSITION_KEYWORDS,
  getCompositionBranches,
  hasComposition,
  isSupportedSchema,
} from "./schema-validation-composition";
import {
  collectConstraintRoots,
  hasObjectCycle,
} from "./schema-validation-constraint-graph";
import { validateSchemaNode } from "./schema-validation-definitions";
import {
  inspectTerminalChildren,
  isScalarSchema,
  isTypeLeafSchema,
  type TerminalChildrenInspection,
  validateTerminalChildren,
} from "./schema-validation-shallow-graph";
import {
  addContextError,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

export interface ShallowCompositionPlan {
  readonly composed: WeakSet<ConfigurationPropertySchema>;
  readonly memoEligible?: WeakSet<object> | undefined;
  readonly predicateScalars: WeakSet<ConfigurationPropertySchema>;
}

interface ShallowBranch {
  readonly schema: ConfigurationPropertySchema;
  readonly children?: TerminalChildrenInspection | undefined;
}

export function validateShallowComposition(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): ShallowCompositionPlan | undefined | null {
  const predicateScalars = new WeakSet<ConfigurationPropertySchema>();
  const rootChildren = inspectTerminalChildren(schema);
  if (rootChildren === undefined) return null;
  const branches = shallowCompositionBranches(schema, predicateScalars);
  if (branches === undefined) return null;
  const roots: unknown[] = [];
  collectConstraintRoots(schema, roots);
  if (
    !validateTerminalChildren(
      rootChildren,
      path,
      context,
      predicateScalars,
      roots,
    )
  ) {
    return undefined;
  }
  const memoEligible = validateShallowBranches(
    branches,
    predicateScalars,
    roots,
    path,
    context,
  );
  if (memoEligible === false) return undefined;
  if (hasObjectCycle(roots)) {
    addContextError(context, "invalid-schema", path, {
      message: "Schema constraint values must not contain cycles",
    });
    return undefined;
  }
  return {
    composed: new WeakSet([schema]),
    memoEligible: memoEligible ?? undefined,
    predicateScalars,
  };
}

function shallowCompositionBranches(
  schema: ConfigurationPropertySchema,
  predicateScalars: WeakSet<ConfigurationPropertySchema>,
): ShallowBranch[] | undefined {
  const flattened: ShallowBranch[] = [];
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    for (const branch of getCompositionBranches(schema, keyword)) {
      if (branch === schema) return undefined;
      if (isTypeLeafSchema(branch)) {
        flattened.push(typeLeafBranch(branch, predicateScalars));
        continue;
      }
      if (hasComposition(branch)) return undefined;
      const children = inspectTerminalChildren(branch);
      if (children === undefined) return undefined;
      flattened.push({ schema: branch, children });
    }
  }
  return flattened;
}

function typeLeafBranch(
  schema: ConfigurationPropertySchema,
  predicateScalars: WeakSet<ConfigurationPropertySchema>,
): ShallowBranch {
  if (isScalarSchema(schema)) predicateScalars.add(schema);
  return { schema };
}

function validateShallowBranches(
  branches: readonly ShallowBranch[],
  predicateScalars: WeakSet<ConfigurationPropertySchema>,
  roots: unknown[],
  path: ValidationPath,
  context: ValidationContext,
): WeakSet<object> | false | undefined {
  const completed = new WeakSet<ConfigurationPropertySchema>();
  let memoEligible: WeakSet<object> | undefined;
  for (const branch of branches) {
    if (completed.has(branch.schema)) {
      memoEligible ??= new WeakSet();
      memoEligible.add(branch.schema);
      continue;
    }
    completed.add(branch.schema);
    if (branch.children === undefined) continue;
    if (
      !validateSchemaNode(
        branch.schema,
        path,
        context,
        isSupportedSchema,
        false,
      )
    ) {
      return false;
    }
    if (isScalarSchema(branch.schema)) predicateScalars.add(branch.schema);
    if (
      !validateTerminalChildren(
        branch.children,
        path,
        context,
        predicateScalars,
        roots,
      )
    ) {
      return false;
    }
    collectConstraintRoots(branch.schema, roots);
  }
  return memoEligible;
}
