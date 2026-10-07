import {
  deepEqual,
  deepGet,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import { evaluateChangePolicy } from "@weaver-conf/config-policy/browser";
import {
  type RegisteredMutationFootprint,
  registeredMutationFootprint,
} from "@weaver-conf/config-registry";
import {
  type ConfigurationAuthorizationRequest,
  canonicalConfigurationPathSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "../identity-snapshots";
import type { RootState } from "../root-state";
import { deriveView } from "../view-snapshots";
import {
  authorizeMutation,
  type MutationTicket,
  mutationRequest,
} from "./authority-write";
import { covers, evidencePath } from "./authorization-requests";
import { compileMutationPath } from "./mutation-capture";
import type { MutationPlan } from "./mutation-plan";
import { checkedSessionMutation } from "./session-mutations";

type Requests = Map<string, ConfigurationAuthorizationRequest>;

export async function admitMutationPolicy(
  state: RootState,
  ticket: MutationTicket,
  plan: MutationPlan,
): Promise<ConfigurationAuthorizationRequest> {
  if (
    state.factory.host.authConfig?.sessionLayer === plan.command.layer &&
    !plan.session
  )
    throw createWeaverError(
      "POLICY_VIOLATION",
      "Session mutations are unavailable",
    );
  const requests = new Map<string, ConfigurationAuthorizationRequest>([
    [plan.command.path, mutationRequest(plan.command)],
  ]);
  collectReadyPolicies(state, ticket, plan, requests);
  const before = plan.target.layer?.entries;
  // Raw target-layer policy cannot be masked by a higher contribution.
  const targetAfter = [...plan.after.ready.values()]
    .flatMap((snapshot) => snapshot.contributions)
    .find((item) => item.selection.captured === plan.target.selection.captured)
    ?.layer?.entries;
  if (before && targetAfter)
    collectPolicies(state, ticket, plan, before, targetAfter, requests);
  const logical = mutationRequest(
    plan.command,
    plan.command.path,
    [...requests.values()].some((request) => request.sensitive),
  );
  requests.set(plan.command.path, logical);
  for (const request of requests.values()) {
    await authorizeMutation(state, ticket, request);
    if (plan.session) checkedSessionMutation(state, ticket, plan.command);
  }
  return logical;
}

function collectReadyPolicies(
  state: RootState,
  ticket: MutationTicket,
  plan: MutationPlan,
  requests: Requests,
): void {
  for (const [key, before] of plan.before.ready) {
    const after = plan.after.ready.get(key);
    if (!after || before === after) continue;
    collectPolicies(
      state,
      ticket,
      plan,
      before.raw.entries,
      after.raw.entries,
      requests,
    );
    collectViewPolicies(state, ticket, plan, before, after, requests);
  }
}

function collectViewPolicies(
  state: RootState,
  ticket: MutationTicket,
  plan: MutationPlan,
  before: IdentitySnapshot,
  after: IdentitySnapshot,
  requests: Requests,
): void {
  if (plan.command.viewId === undefined) return;
  const selection = {
    identity: before.identity,
    namespace: plan.command.namespace,
    viewId: plan.command.viewId,
  };
  const oldView = deriveView(before, selection, state.factory.registry, false);
  const newView = deriveView(after, selection, state.factory.registry, true);
  collectPolicies(
    state,
    ticket,
    plan,
    oldView.raw.entries,
    newView.raw.entries,
    requests,
    false,
  );
}

function collectPolicies(
  state: RootState,
  ticket: MutationTicket,
  plan: MutationPlan,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  requests: Map<string, ConfigurationAuthorizationRequest>,
  physical = true,
): void {
  const selectedPath = physical
    ? compileMutationPath(plan.command)
    : plan.command.path;
  const path = destructivePath(plan, before, after, selectedPath);
  for (const identity of state.factory.registry.listRegisteredSchemaIdentities()
    .anchors) {
    if (
      identity.environment !== plan.command.identity.environment ||
      !(covers(identity.path, path) || covers(path, identity.path))
    )
      continue;
    const anchor = state.factory.registry.getRegisteredSchema(
      identity.path,
      identity.environment,
    );
    if (!anchor)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Mutation owner unavailable",
      );
    const root = parseCanonicalConfigPath(anchor.path);
    const relative = covers(anchor.path, path)
      ? parseCanonicalConfigPath(path).segments.slice(root.segments.length)
      : [];
    const footprint = registeredMutationFootprint(
      anchor.schema,
      relative,
      deepGet(before, root.storageKey),
      deepGet(after, root.storageKey),
    );
    collectFootprint(
      ticket,
      plan,
      { footprint, root: root.segments, before, after, physical },
      requests,
    );
  }
}

function collectFootprint(
  ticket: MutationTicket,
  plan: MutationPlan,
  evidence: {
    readonly footprint: RegisteredMutationFootprint;
    readonly root: readonly string[];
    readonly before: Record<string, unknown>;
    readonly after: Record<string, unknown>;
    readonly physical: boolean;
  },
  requests: Requests,
): void {
  for (const item of evidence.footprint) {
    const rawTarget = evidencePath([...evidence.root, ...item.path]);
    const target = policyTarget(
      plan,
      rawTarget,
      evidence.before,
      evidence.after,
      evidence.physical,
    );
    if (target === undefined) continue;
    checkEvidence(ticket, plan, item, target);
    const sensitive =
      item.before.sensitive ||
      item.after.sensitive ||
      requests.get(target)?.sensitive === true;
    requests.set(target, mutationRequest(plan.command, target, sensitive));
  }
}

function checkEvidence(
  ticket: MutationTicket,
  plan: MutationPlan,
  item: RegisteredMutationFootprint[number],
  path: string,
): void {
  if (
    item.before.forbidden ||
    item.after.forbidden ||
    item.before.reference ||
    item.after.reference
  )
    throw createWeaverError("FORBIDDEN", "Mutation touches protected data");
  if (!item.before.declared && !item.after.declared)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "Mutation path is not declared",
    );
  const access = {
    userId: ticket.principal.principalId,
    roles: ticket.principal.roles,
    ...(plan.session?.emergency
      ? {
          sessionMode: "emergency-override",
          overrideReason: plan.session.controller.getSession()?.reason,
        }
      : {}),
  };
  const schemas = new Set([
    ...item.before.ancestors,
    ...item.before.schemas,
    ...item.after.ancestors,
    ...item.after.schemas,
  ]);
  for (const schema of schemas) {
    if (!ticket.auth.canRead(access, path, schema))
      throw createWeaverError("FORBIDDEN", "Mutation policy denied");
    if (
      evaluateChangePolicy(
        schema,
        access,
        plan.command.layer,
        (context, layer, key, schema) =>
          ticket.auth.canWrite(context, layer, key, schema),
      ).outcome !== "allowed"
    )
      throw createWeaverError("POLICY_VIOLATION", "Mutation policy denied");
  }
}

function destructivePath(
  plan: MutationPlan,
  before: unknown,
  after: unknown,
  path = plan.command.path,
): string {
  if (plan.command.operation === "remove") return path;
  const segments = parseCanonicalConfigPath(path).segments;
  for (const [index, segment] of segments.entries()) {
    // Record/array replacement destroys the ancestor; an absent container or
    // an ordinary array-element patch does not broaden the logical target.
    if (
      (before === null ||
        (before !== undefined && typeof before !== "object") ||
        (typeof before === "object" &&
          Array.isArray(before) !== Array.isArray(after))) &&
      after !== null &&
      typeof after === "object"
    )
      return `/${segments.slice(0, index).join("/")}`;
    before = ownMember(before, segment);
    after = ownMember(after, segment);
  }
  return path;
}

function policyTarget(
  plan: MutationPlan,
  target: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  physical: boolean,
) {
  if (plan.command.viewId !== undefined && physical) {
    const root = compileMutationPath({
      ...plan.command,
      path: plan.command.namespace,
    });
    if (!covers(root, target))
      throw createWeaverError(
        "FORBIDDEN",
        "View mutation crosses storage ownership",
      );
    return canonicalConfigurationPathSchema.parse(
      `${plan.command.namespace}${target.slice(root.length)}`,
    );
  }
  const path = parseCanonicalConfigPath(target);
  if (path.segments.includes("instances")) {
    if (
      deepEqual(
        deepGet(before, path.storageKey),
        deepGet(after, path.storageKey),
      )
    )
      return undefined;
    throw createWeaverError(
      "FORBIDDEN",
      "Base mutation changes reserved instance storage",
    );
  }
  return canonicalConfigurationPathSchema.parse(target);
}

function ownMember(value: unknown, segment: string): unknown {
  return value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, segment)?.value
    : undefined;
}
