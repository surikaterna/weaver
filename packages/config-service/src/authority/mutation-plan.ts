import {
  deepGet,
  parseCanonicalConfigPath,
  projectConfigurationData,
} from "@weaver-conf/config-engine";
import {
  type ConfigurationAuthorizationRequest,
  type ConfigurationMutationCommand,
  createWeaverError,
  weaverErrorCodeSchema,
} from "@weaver-conf/config-types";
import type { LoadedContribution } from "../hydration";
import { resolveIdentitySnapshot } from "../identity-snapshots";
import { identityKey } from "../layer-stack";
import type { RootState } from "../root-state";
import type { Mutation } from "./admission-contracts";
import { mutationRequest } from "./authority-write";
import { compileMutationPath } from "./mutation-capture";
import type { CapturedWriter } from "./provider-write";
import {
  type PublicationPlan,
  replaceContributions,
  stagePublication,
} from "./publication";
import { prepareConfigMutation } from "./schema-admission";
import { buildSchemaPatch } from "./value-patch";

export interface MutationPlan {
  readonly command: ConfigurationMutationCommand;
  readonly request: ConfigurationAuthorizationRequest;
  readonly target: LoadedContribution;
  readonly writer: CapturedWriter;
  readonly effect: Mutation;
  readonly before: PublicationPlan;
  readonly after: PublicationPlan;
}

export function stageMutation(
  state: RootState,
  draft: PublicationPlan,
  command: ConfigurationMutationCommand,
  selected: LoadedContribution,
): MutationPlan {
  const snapshot = draft.ready.get(identityKey(command.identity));
  const target = snapshot?.contributions.find(
    (item) => item.selection.captured === selected.selection.captured,
  );
  const writer = state.factory.writers.get(selected.selection.captured);
  if (!snapshot || !target?.layer || !writer)
    throw createWeaverError("WRITE_UNAVAILABLE", "Mutation target unavailable");
  const effect = physicalMutation(state, command, target.layer.entries);
  const prepared = prepareConfigMutation({
    registry: state.factory.registry,
    environment: command.identity.environment,
    mutations: [effect],
    layerBefore: target.layer.entries,
    effectiveAfter: (entries) =>
      resolveIdentitySnapshot(
        replaceContributions(
          snapshot.contributions,
          new Map([[target.selection.captured, entries]]),
        ),
        state.factory.options.layers.map((_, rank) => rank),
      ).entries,
  });
  if (!prepared.success)
    throw createWeaverError(
      weaverErrorCodeSchema.safeParse(prepared.result.error?.code).data ??
        "VALIDATION_ERROR",
      "Configuration candidate is invalid",
    );
  const after = stagePublication(
    state,
    draft,
    new Map([[target.selection.captured, prepared.layerAfter]]),
  );
  return Object.freeze({
    command,
    request: mutationRequest(command),
    target,
    writer,
    effect,
    before: draft,
    after,
  });
}

function physicalMutation(
  state: RootState,
  command: ConfigurationMutationCommand,
  entries: Record<string, unknown>,
): Mutation {
  const physical = compileMutationPath(command);
  const parsed = parseCanonicalConfigPath(physical);
  rejectRawArrayIndices(entries, parsed.segments, command.operation);
  if (command.operation !== "patch")
    return preserveInstanceStorage(command, entries, {
      key: parsed.storageKey,
      operation: command.operation,
      ...(command.operation === "set"
        ? { value: effectPayload(command.value) }
        : {}),
    });
  const anchor = state.factory.registry.resolveAnchor(
    physical,
    command.identity.environment,
  );
  if (!anchor)
    throw createWeaverError("SCHEMA_NOT_REGISTERED", "Patch owner unavailable");
  const root = parseCanonicalConfigPath(anchor.path);
  const relative = parsed.segments.slice(root.segments.length);
  if (!relative.length)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Patch requires a path below its anchor",
    );
  const patch = buildSchemaPatch(
    deepGet(entries, root.storageKey),
    relative,
    command.value,
    anchor.schema,
  );
  if (!patch.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid value patch");
  return {
    operation: "set",
    key: root.storageKey,
    value: effectPayload(patch.value),
    dedicated: true,
    admissionKey: parsed.storageKey,
    admissionValue: command.value,
  };
}

function preserveInstanceStorage(
  command: ConfigurationMutationCommand,
  entries: Record<string, unknown>,
  effect: Mutation,
): Mutation {
  if (command.viewId !== undefined) return effect;
  const previous: unknown = deepGet(entries, effect.key);
  if (!previous || typeof previous !== "object" || Array.isArray(previous))
    return effect;
  const instances: unknown = Object.getOwnPropertyDescriptor(
    previous,
    "instances",
  )?.value;
  const ordinary = Object.fromEntries(
    Object.entries(previous).filter(([key]) => key !== "instances"),
  );
  rejectDescendantStorage(ordinary);
  if (!Object.hasOwn(previous, "instances")) return effect;
  if (command.operation === "remove")
    return {
      operation: "set",
      key: effect.key,
      value: effectPayload({ instances }),
    };
  if (
    !effect.value ||
    typeof effect.value !== "object" ||
    Array.isArray(effect.value)
  )
    throw createWeaverError(
      "FORBIDDEN",
      "Atomic replacement would erase view storage",
    );
  return { ...effect, value: effectPayload({ ...effect.value, instances }) };
}

function rejectDescendantStorage(value: object): void {
  const pending: unknown[] = Object.values(value);
  const seen = new Set<object>();
  while (pending.length) {
    const child = pending.pop();
    if (!child || typeof child !== "object" || seen.has(child)) continue;
    seen.add(child);
    if (Object.hasOwn(child, "instances"))
      throw createWeaverError(
        "FORBIDDEN",
        "Ancestor mutation would erase nested view storage",
      );
    for (const value of Object.values(child)) pending.push(value);
  }
}

function effectPayload(value: unknown): unknown {
  return projectConfigurationData(
    value,
    {},
    {
      decide: () => "descend",
      child: (context) => context,
      mutableContainers: true,
    },
  );
}

function rejectRawArrayIndices(
  entries: Record<string, unknown>,
  segments: readonly string[],
  operation: string,
): void {
  if (operation === "patch") return;
  let current: unknown = entries;
  for (const segment of segments) {
    if (Array.isArray(current))
      throw createWeaverError(
        "UNSUPPORTED_OPERATION",
        "Generic array-index mutation is unsupported",
      );
    if (current === null || typeof current !== "object") return;
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    current = descriptor?.value;
  }
}
