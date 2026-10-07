import {
  deriveFragmentPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import { schemaRegistrationRequestSchema } from "@weaver-conf/config-registry";
import {
  authorizationDecisionSchema,
  captureServiceData,
  createWeaverError,
  type SchemaAuthorizationRequest,
  type SchemaOperationResult,
  schemaAuthorizationRequestSchema,
  schemaOperationOptionsSchema,
  type TrustedPrincipalSnapshot,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { rejectCeilings } from "../ceiling-presence";
import { errorData } from "../resource-ownership";
import { assertLive, type RootState } from "../root-state";
import { auditWrite, invokeWriteHook } from "./authority-audit";
import { registryStore } from "./registry-storage";
import {
  checkSchemaRevision,
  requireSchemaPermission,
  requireSchemaTarget,
  type SchemaRegistry,
} from "./schema-authority";
import { stageSchemaPublication } from "./schema-publication";

function failure(error: unknown): SchemaOperationResult {
  return {
    success: false,
    outcome: "rejected",
    error: errorData(
      error instanceof WeaverErrorInstance ? error.code : "VALIDATION_ERROR",
      "Schema registration rejected",
    ),
  };
}

export function registerSchema(
  state: RootState,
  registry: SchemaRegistry,
  token: unknown,
  input: unknown,
  options: unknown,
): Promise<SchemaOperationResult> {
  try {
    const principal = requireSchemaPermission(
      state,
      registry,
      token,
      "register",
    );
    const check = registrationGuard(state, registry, token, principal);
    check();
    if (state.writeHookActive)
      throw createWeaverError("FORBIDDEN", "Authority callback reentry denied");
    const { request, authorization } = captureRegistration(input, principal);
    const capturedOptions = schemaOperationOptionsSchema.parse(
      options === undefined ? {} : options,
    );
    const ticket = { principal, request: authorization };
    const guard = () => {
      check();
      checkSchemaRevision(state, capturedOptions);
    };
    return state.queue.enqueue(() => execute(state, ticket, guard, request));
  } catch (error) {
    return Promise.resolve(failure(error));
  }
}

function registrationGuard(
  state: RootState,
  registry: SchemaRegistry,
  token: unknown,
  principal: TrustedPrincipalSnapshot,
) {
  return () => {
    assertLive(state);
    if (state.schemaFence || state.writeFence)
      throw createWeaverError(
        "WRITE_UNAVAILABLE",
        "Registry recovery requires a new root",
      );
    if (registry.current(token).snapshot !== principal)
      throw createWeaverError("FORBIDDEN", "Schema authority changed");
  };
}

function captureRegistration(
  input: unknown,
  principal: TrustedPrincipalSnapshot,
) {
  const captured = captureServiceData(input);
  if (!captured.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid schema request");
  const request = schemaRegistrationRequestSchema.parse(captured.value);
  const anchorPath =
    "providerId" in request
      ? deriveFragmentPath(
          request.serviceId,
          request.slotPath,
          request.providerId,
        ).fragmentPath
      : deriveServicePath(request.serviceId).servicePath;
  requireSchemaTarget(principal, anchorPath, request.environment);
  const authorization = schemaAuthorizationRequestSchema.parse({
    operation: "schema-register",
    kind: "providerId" in request ? "fragment" : "service",
    anchorPath,
    environment: request.environment,
  });
  return { request, authorization };
}

type AuditTicket = {
  readonly principal: TrustedPrincipalSnapshot;
  readonly request: SchemaAuthorizationRequest;
};
async function authorize(state: RootState, ticket: AuditTicket): Promise<void> {
  try {
    const host = state.factory.host.hostAuthority;
    if (!host) throw new Error();
    const result = await invokeWriteHook(state, () =>
      host.authorizeWrite(ticket.principal, ticket.request),
    );
    if (authorizationDecisionSchema.safeParse(result).data !== "allowed")
      throw new Error();
  } catch {
    throw createWeaverError("FORBIDDEN", "Schema registration denied");
  }
}

async function execute(
  state: RootState,
  ticket: AuditTicket,
  guard: () => void,
  request: Parameters<RootState["factory"]["adapter"]["prepare"]>[0],
): Promise<SchemaOperationResult> {
  let plan: ReturnType<typeof stageSchemaPublication>;
  try {
    guard();
    registryStore(state);
    await authorize(state, ticket);
    guard();
    plan = preparePublication(state, ticket, request);
    await auditWrite(state, ticket, "before-dispatch");
    guard();
  } catch (error) {
    await auditWrite(state, ticket, "denied");
    return failure(error);
  }
  const outcome = plan.storage ? await plan.storage.dispatch() : "committed";
  if (outcome === "committed") {
    plan.publish();
    await auditWrite(state, ticket, "committed");
    return plan.success;
  }
  if (outcome === "unknown") {
    state.schemaFence = Object.freeze([
      plan.storage?.target.selection.captured.binding.id ?? "registry",
    ]);
    await auditWrite(state, ticket, "unknown");
    return {
      success: false,
      outcome: "unknown",
      error: errorData(
        "WRITE_OUTCOME_UNKNOWN",
        "Schema registration outcome is unknown",
      ),
    };
  }
  await auditWrite(state, ticket, "denied");
  return failure(createWeaverError("WRITE_ERROR", "Registry write rejected"));
}

function preparePublication(
  state: RootState,
  ticket: AuditTicket,
  request: Parameters<RootState["factory"]["adapter"]["prepare"]>[0],
) {
  const prepared = state.factory.adapter.prepare(request, {
    actor: ticket.principal.principalId,
    subject: ticket.principal.principalId,
  });
  if (!prepared.result.success)
    throw createWeaverError(
      prepared.result.error?.code ?? "VALIDATION_ERROR",
      "Schema registration rejected",
    );
  rejectCeilings(request.schema);
  return stageSchemaPublication(state, prepared);
}
