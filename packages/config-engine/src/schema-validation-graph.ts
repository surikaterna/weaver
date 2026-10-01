import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  hasComposition,
  isSupportedSchema,
} from "./schema-validation-composition";
import {
  collectConstraintRoots,
  hasObjectCycle,
} from "./schema-validation-constraint-graph";
import {
  validateSchemaContainers,
  validateSchemaNode,
} from "./schema-validation-definitions";
import {
  pushCompositionChildren,
  pushSchemaChildren,
  type SchemaGraphFrame,
} from "./schema-validation-graph-children";
import { validateShallowComposition } from "./schema-validation-shallow-composition";
import {
  hasOnlyTypeLeafChildren,
  hasSchemaChildren,
  isTypeLeafSchema,
  validateTypeLeafChildren,
} from "./schema-validation-shallow-graph";
import {
  addContextError,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

interface SchemaInspection {
  cyclic: boolean;
  valid: boolean;
  composed?: WeakSet<ConfigurationPropertySchema> | undefined;
  readonly constraintRoots: unknown[];
  memoEligible?: WeakSet<object> | undefined;
  predicateScalars?: WeakSet<ConfigurationPropertySchema> | undefined;
}

export interface SchemaValidationPlan {
  readonly composed?: WeakSet<ConfigurationPropertySchema> | undefined;
  readonly memoEligible?: WeakSet<object> | undefined;
  readonly predicateScalars?: WeakSet<ConfigurationPropertySchema> | undefined;
}

const EMPTY_SCHEMA_VALIDATION_PLAN: SchemaValidationPlan = {};

interface GraphInspectionRuntime {
  readonly context: ValidationContext;
  readonly inspection: SchemaInspection;
  readonly path: ValidationPath;
  readonly pending: SchemaGraphFrame[];
  readonly root: ConfigurationPropertySchema;
  readonly rootComposed: boolean;
  readonly rootValidated: boolean;
  readonly supportsSchema: (value: unknown) => boolean;
  readonly visits: WeakMap<object, "supported" | "active" | "completed">;
}

export function validateSchemaGraph(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): SchemaValidationPlan | undefined {
  if (!isSupportedSchema(schema)) {
    addContextError(context, "invalid-schema", path, {
      message: "Schema must have a supported non-empty type",
    });
    return undefined;
  }
  if (isTypeLeafSchema(schema)) return EMPTY_SCHEMA_VALIDATION_PLAN;
  if (!validateSchemaContainers(schema, path, context)) return undefined;
  const rootComposed = hasComposition(schema);
  if (!hasSchemaChildren(schema, rootComposed)) {
    return validateSingleSchema(schema, path, context);
  }
  if (
    !validateSchemaNode(schema, path, context, isSupportedSchema, rootComposed)
  ) {
    return undefined;
  }
  if (rootComposed) {
    const shallowPlan = validateShallowComposition(schema, path, context);
    if (shallowPlan !== null) return shallowPlan;
  } else if (hasOnlyTypeLeafChildren(schema)) {
    return validateShallowSchema(schema, path, context);
  }
  const inspection = inspectSchemaGraph(
    schema,
    path,
    context,
    rootComposed,
    true,
  );
  if (!inspection.valid) return undefined;
  const constraintCycle = hasObjectCycle(inspection.constraintRoots);
  if (!inspection.cyclic && !constraintCycle) {
    return {
      composed: inspection.composed,
      memoEligible: inspection.memoEligible,
      predicateScalars: inspection.predicateScalars,
    };
  }
  return rejectCyclicSchema(inspection.cyclic, path, context);
}

function rejectCyclicSchema(
  cyclic: boolean,
  path: ValidationPath,
  context: ValidationContext,
): undefined {
  addContextError(context, "invalid-schema", path, {
    message: cyclic
      ? "Schema must not contain cycles"
      : "Schema constraint values must not contain cycles",
  });
  return undefined;
}

function validateShallowSchema(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): SchemaValidationPlan | undefined {
  if (!validateTypeLeafChildren(schema, path, context, isSupportedSchema))
    return undefined;
  const roots: unknown[] = [];
  collectConstraintRoots(schema, roots);
  if (!hasObjectCycle(roots)) return EMPTY_SCHEMA_VALIDATION_PLAN;
  addContextError(context, "invalid-schema", path, {
    message: "Schema constraint values must not contain cycles",
  });
  return undefined;
}

function validateSingleSchema(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): SchemaValidationPlan | undefined {
  if (!validateSchemaNode(schema, path, context, isSupportedSchema, false)) {
    return undefined;
  }
  const roots: unknown[] = [];
  collectConstraintRoots(schema, roots);
  if (!hasObjectCycle(roots)) return EMPTY_SCHEMA_VALIDATION_PLAN;
  addContextError(context, "invalid-schema", path, {
    message: "Schema constraint values must not contain cycles",
  });
  return undefined;
}

function inspectSchemaGraph(
  root: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
  rootComposed: boolean,
  rootValidated: boolean,
): SchemaInspection {
  const visits = new WeakMap<object, "supported" | "active" | "completed">([
    [root, "supported"],
  ]);
  const constraintRoots: unknown[] = [];
  const inspection: SchemaInspection = {
    cyclic: false,
    valid: true,
    composed: undefined,
    memoEligible: undefined,
    predicateScalars: undefined,
    constraintRoots,
  };
  const supportsSchema = (value: unknown): boolean =>
    isKnownSupportedSchema(value, visits);
  const pending: SchemaGraphFrame[] = [
    {
      kind: "enter",
      value: root,
      invalidMessage: "Schema must have a supported non-empty type",
    },
  ];
  const runtime: GraphInspectionRuntime = {
    context,
    inspection,
    path,
    pending,
    root,
    rootComposed,
    rootValidated,
    supportsSchema,
    visits,
  };
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (!processSchemaGraphFrame(frame, runtime)) return inspection;
  }
  return inspection;
}

function processSchemaGraphFrame(
  frame: SchemaGraphFrame,
  runtime: GraphInspectionRuntime,
): boolean {
  if (frame.kind === "exit") {
    runtime.visits.set(frame.value, "completed");
    return true;
  }
  if (handleExistingVisit(frame.value, runtime)) {
    return !runtime.inspection.cyclic;
  }
  if (!isKnownSupportedSchema(frame.value, runtime.visits)) {
    addContextError(runtime.context, "invalid-schema", runtime.path, {
      message: frame.invalidMessage,
    });
    runtime.inspection.valid = false;
    return false;
  }
  return inspectSchemaNode(frame.value, runtime);
}

function handleExistingVisit(
  value: unknown,
  runtime: GraphInspectionRuntime,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const visit = runtime.visits.get(value);
  if (visit === "completed") {
    runtime.inspection.memoEligible ??= new WeakSet();
    runtime.inspection.memoEligible.add(value);
    return true;
  }
  if (visit !== "active") return false;
  runtime.inspection.cyclic = true;
  return true;
}

function inspectSchemaNode(
  schema: ConfigurationPropertySchema,
  runtime: GraphInspectionRuntime,
): boolean {
  const { inspection, pending, visits } = runtime;
  if (isTypeLeafSchema(schema)) {
    inspection.predicateScalars ??= new WeakSet();
    inspection.predicateScalars.add(schema);
    visits.set(schema, "completed");
    return true;
  }
  if (!validateSchemaContainers(schema, runtime.path, runtime.context)) {
    inspection.valid = false;
    return false;
  }
  const composed =
    schema === runtime.root ? runtime.rootComposed : hasComposition(schema);
  if (composed) {
    inspection.composed ??= new WeakSet();
    inspection.composed.add(schema);
  }
  if (!validateInspectedSchema(schema, composed, runtime)) return false;
  visits.set(schema, "active");
  collectConstraintRoots(schema, inspection.constraintRoots);
  pending.push({ kind: "exit", value: schema });
  inspection.predicateScalars ??= new WeakSet();
  if (hasOnlyTypeLeafChildren(schema, inspection.predicateScalars)) {
    if (
      !validateTypeLeafChildren(
        schema,
        runtime.path,
        runtime.context,
        runtime.supportsSchema,
      )
    ) {
      inspection.valid = false;
      return false;
    }
    if (composed) pushCompositionChildren(schema, pending);
  } else pushSchemaChildren(schema, pending, composed);
  return true;
}

function validateInspectedSchema(
  schema: ConfigurationPropertySchema,
  composed: boolean,
  runtime: GraphInspectionRuntime,
): boolean {
  if (schema === runtime.root && runtime.rootValidated) return true;
  const valid = validateSchemaNode(
    schema,
    runtime.path,
    runtime.context,
    runtime.supportsSchema,
    composed,
  );
  if (!valid) runtime.inspection.valid = false;
  return valid;
}

function isKnownSupportedSchema(
  value: unknown,
  visits: WeakMap<object, "supported" | "active" | "completed">,
): value is ConfigurationPropertySchema {
  if (typeof value !== "object" || value === null) return false;
  if (visits.has(value)) return true;
  if (!isSupportedSchema(value)) return false;
  visits.set(value, "supported");
  return true;
}
