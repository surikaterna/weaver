export function plainPatchSchema() {
  return {
    type: "object",
    properties: { value: { type: ["string", "number"] } },
    additionalProperties: false,
  };
}

export function stringBranch() {
  return {
    type: "object",
    properties: { value: { type: "string" } },
    additionalProperties: true,
  };
}

function kindBranch(kind, valueType) {
  return {
    type: "object",
    properties: { kind: { type: "string", const: kind }, value: { type: valueType } },
    additionalProperties: true,
  };
}

export function plainCompositionSchema() {
  return {
    type: "object",
    properties: { kind: { type: "string" }, value: { type: ["string", "number"] } },
    additionalProperties: false,
    anyOf: [kindBranch("text", "string"), kindBranch("count", "number")],
  };
}

export function branchAccessorSchema(reads) {
  const schema = plainCompositionSchema();
  for (const [index, kind] of ["text", "count"].entries()) {
    Object.defineProperty(schema.anyOf[index].properties.kind, "const", {
      configurable: true, enumerable: true,
      get() { reads[index]++; return kind; },
    });
  }
  return schema;
}

export function schemaMutationAccessor() {
  const schema = plainPatchSchema();
  const counter = { reads: 0, introduced: false };
  Object.defineProperty(schema, "maxProperties", {
    configurable: true, enumerable: true,
    get() {
      counter.reads++;
      if (!counter.introduced) {
        counter.introduced = true;
        schema.anyOf = [stringBranch()];
      }
      return undefined;
    },
  });
  return { schema, counter };
}

export function payloadMutationAccessor(schema, thirdRead = false) {
  const existing = {};
  const counter = { reads: 0 };
  Object.defineProperty(existing, "value", {
    configurable: true, enumerable: true,
    get() {
      counter.reads++;
      if (!thirdRead || counter.reads === 3) schema.anyOf = [stringBranch()];
      return "old";
    },
  });
  return { existing, counter };
}

export function preparationContext(schema) {
  const anchor = { kind: "service", path: "/billing", schema, environment: "test", metadata: {} };
  const resolutions = [];
  const options = { schemaRegistry: { resolveAnchor: async (path, environment) => {
    resolutions.push([path, environment]);
    return anchor;
  } } };
  return { anchor, resolutions, options };
}

export async function preparationEffects(createProvider, createService, initial = { value: "old" }) {
  const entries = { billing: initial };
  const provider = createProvider("p1", "platform", entries);
  const service = await createService({ providers: [provider], environment: "test" });
  let notifications = 0;
  const unsubscribe = service.onDelta(() => notifications++);
  return { provider, service, entries, revision: service.revision, notifications: () => notifications, unsubscribe };
}

export async function expectPreparationNoEffects(effects, expectNoEffects, expect) {
  await expectNoEffects(effects.provider, effects.service, effects.entries, effects.revision);
  expect(effects.notifications()).toBe(0);
  effects.unsubscribe();
}

export function accessorError(role) {
  return {
    code: role === "schema" ? "invalid-schema" : "invalid-value",
    path: "$.billing", segments: ["billing"],
    message: role === "schema"
      ? "Schema must contain only acyclic own plain data"
      : "Configuration values must contain only own plain data",
  };
}

export function candidateError() {
  return {
    code: "invalid-value", path: "$.billing", segments: ["billing"],
    message: "Value must match at least one anyOf branch",
  };
}

export function awaitedMutation(schema, branch, effects, events, keys) {
  return async (key) => {
    keys.push(key);
    events.push("layer-read");
    await Promise.resolve();
    schema.anyOf = [branch];
    events.push("schema-mutated");
    return (await effects.provider.load()).entries.billing;
  };
}
