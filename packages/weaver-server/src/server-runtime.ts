import { runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalInfrastructureGeneration,
  type InternalUpgradePlanRequest,
  type MaintenanceStatus,
  maintenanceStatusSchema,
  publicMaintenanceFailure,
  type UpgradeApplyRequest,
  type UpgradeExecutionResult,
  type UpgradeRecoveryRequest,
  type WeaverRuntimeState,
  weaverRuntimeStatusSchema,
} from "@weaver-conf/config-types";
import type { AuthContext } from "./auth/auth-middleware";
import {
  compileBootstrapLayout,
  resolveGenerationCredentials,
} from "./bootstrap/compile-layout";
import {
  assertWrite,
  type BootstrapRuntimeOptions,
} from "./bootstrap/initialize";
import { disposeProviderResources } from "./bootstrap/provider-resources";
import {
  activeGeneration,
  openRuntimeResources,
} from "./bootstrap/runtime-open";
import {
  assertBootstrapAdministrator,
  type BootstrapAdministrator,
} from "./bootstrap/seed-trust";
import { waitForMaintenanceFence } from "./core/application-maintenance-barrier";
import {
  controlProjection,
  hostForControl,
  suspendControlApplication,
  validateControlCandidate,
} from "./core/config-service-internal";
import {
  type InternalUpgradeExecutionResult,
  publicUpgradeEffects,
  publicUpgradeFailure,
  publicUpgradeResult,
} from "./core/public-upgrade-status";
import { createSchemaRegistry } from "./core/schema-registry";
import { createScopeManager } from "./core/scope-manager";
import { createUpgradeApplicationAdmission } from "./core/upgrade-application-admission";
import { applyRuntimeUpgrade } from "./core/upgrade-executor";
import { planRuntimeUpgrade } from "./core/upgrade-planner";
import { recoverRuntimeUpgrade } from "./core/upgrade-recovery";
import type { UpgradeRuntimeHost } from "./core/upgrade-runtime-host";
import {
  assertGenerationId,
  assertSameInfrastructureBindings,
} from "./runtime-infrastructure-validation";
import { createWeaverScompService } from "./transport/scomp-service";

type Resources = Awaited<ReturnType<typeof openRuntimeResources>>;
type ApplyOperation = (
  request: UpgradeApplyRequest,
) => Promise<InternalUpgradeExecutionResult>;
type RecoverOperation = (
  request: UpgradeRecoveryRequest,
) => Promise<InternalUpgradeExecutionResult>;
const constructionToken = Symbol("WeaverRuntime construction");
let constructRuntime = (_opened: Resources): WeaverRuntime => {
  throw createWeaverError("FORBIDDEN", "Runtime construction is private");
};
/** The runtime owns the services used by standalone transports and CLI lifecycle commands. */
export class WeaverRuntime {
  readonly configService;
  readonly schemaRegistry;
  readonly scopeManager;
  readonly #opened: Resources;
  readonly #applyUpgrade: ApplyOperation;
  readonly #recoverUpgrade: RecoverOperation;
  #phase: WeaverRuntimeState;
  #closePromise: Promise<void> | undefined;
  readonly #maintenanceListeners = new Set<() => void>();
  private constructor(token: symbol, opened: Resources) {
    if (token !== constructionToken)
      throw createWeaverError("FORBIDDEN", "Runtime construction is private");
    this.#opened = opened;
    this.#phase = opened.maintenance ? "maintenance" : "ready";
    this.configService = opened.configService;
    this.schemaRegistry = createSchemaRegistry({
      configService: this.configService,
    });
    this.scopeManager = createScopeManager({
      configService: this.configService,
      schemaRegistry: this.schemaRegistry,
    });
    const runtime: UpgradeRuntimeHost = {
      configService: this.configService,
      enterMaintenance: (administrator) => this.enterMaintenance(administrator),
      requireRestart: () => this.requireRestart(),
    };
    const admission = createUpgradeApplicationAdmission(
      hostForControl(this.configService),
      () => {
        this.#phase = "ready";
      },
    );
    this.#applyUpgrade = (request) =>
      applyRuntimeUpgrade(runtime, opened.control, request, admission);
    this.#recoverUpgrade = (request) =>
      recoverRuntimeUpgrade(runtime, opened.control, request, admission);
  }
  static {
    constructRuntime = (opened) => new WeaverRuntime(constructionToken, opened);
  }
  get state(): WeaverRuntimeState {
    return this.#phase === "ready" &&
      this.configService.degradedProviders.length
      ? "failed"
      : this.#phase;
  }
  get settings() {
    return this.#opened.generation.server;
  }
  get authenticationKey(): string {
    return this.#opened.jwtSecret;
  }
  get status() {
    return weaverRuntimeStatusSchema.parse({
      state: this.state,
      environment: this.#opened.seed.environment,
      revision: hostForControl(this.configService).authority.revision(),
      ...(this.#phase !== "closed"
        ? {
            activeGeneration: controlProjection(this.configService).prepared()
              .configuration.infrastructure.activeGeneration,
          }
        : {}),
    });
  }
  onMaintenance(listener: () => void): () => void {
    this.#maintenanceListeners.add(listener);
    return () => {
      this.#maintenanceListeners.delete(listener);
    };
  }
  createScompService(getAuthContext: () => AuthContext | undefined) {
    const authenticated = () => {
      const context = getAuthContext();
      return context
        ? {
            ...context,
            isAdmin:
              context.identity.roles?.some((role) =>
                this.settings.auth.adminRoles.includes(role),
              ) ?? false,
          }
        : undefined;
    };
    return createWeaverScompService({
      configService: this.configService,
      scopeManager: this.scopeManager,
      schemaRegistry: this.schemaRegistry,
      getAuthContext: authenticated,
      authorizeMutation: () => {
        if (this.state !== "ready")
          throw createWeaverError(
            "MAINTENANCE",
            "Runtime is not accepting application mutations",
          );
        if (!authenticated()?.isAdmin)
          throw createWeaverError(
            "FORBIDDEN",
            "Configured administrator role required",
          );
      },
      onMaintenance: (listener) => this.onMaintenance(listener),
    });
  }
  planUpgrade(request: InternalUpgradePlanRequest) {
    if (this.#phase === "closed")
      throw createWeaverError(
        "CONFIG_NOT_READY",
        "Runtime is not accepting upgrade planning",
      );
    return planRuntimeUpgrade(this.configService, request);
  }
  applyUpgrade(request: UpgradeApplyRequest): Promise<UpgradeExecutionResult> {
    return this.publicExecution(() => this.#applyUpgrade(request));
  }
  recoverUpgrade(
    request: UpgradeRecoveryRequest,
  ): Promise<UpgradeExecutionResult> {
    return this.publicExecution(() => this.#recoverUpgrade(request));
  }
  maintenanceStatus(): MaintenanceStatus {
    const journals = Object.values(
      controlProjection(this.configService).prepared().configuration.upgrades
        .journal,
    ).filter(
      (journal) => !["completed", "compensated"].includes(journal.phase),
    );
    const active = journals.at(-1);
    return maintenanceStatusSchema.parse({
      version: 1,
      state: this.state,
      ready: this.state === "ready",
      ...(this.state === "failed"
        ? { failure: publicMaintenanceFailure("storage") }
        : {}),
      ...(active
        ? {
            activeRun: {
              runId: active.runId,
              phase: active.phase,
              effects: publicUpgradeEffects(active),
              ...(active.phase === "blocked"
                ? { failure: publicUpgradeFailure(active.failure) }
                : {}),
            },
          }
        : {}),
    });
  }
  private async publicExecution(
    execute: () => Promise<InternalUpgradeExecutionResult>,
  ): Promise<UpgradeExecutionResult> {
    try {
      return publicUpgradeResult(await execute());
    } catch (error) {
      try {
        this.#opened.options.logger?.error(
          "[upgrade] protected maintenance failure:",
          error,
        );
      } catch {
        /* Diagnostics cannot replace the sanitized public failure. */
      }
      const failure = publicUpgradeFailure(error);
      throw createWeaverError(publicErrorCode(error), failure.message, {
        maintenanceCode: failure.code,
        category: failure.category,
      });
    }
  }
  async enterMaintenance(
    administrator?: BootstrapAdministrator,
  ): Promise<void> {
    if (administrator)
      assertBootstrapAdministrator(this.#opened.seed, administrator);
    if (this.#phase === "closed")
      throw createWeaverError("CONFIG_NOT_READY", "Runtime is closed");
    this.#phase = "maintenance";
    const drain = suspendControlApplication(this.configService, () =>
      this.notifyMaintenance(),
    );
    await waitForMaintenanceFence(drain);
  }
  requireRestart(): void {
    this.#phase = "restart_required";
  }
  async stageInfrastructure(
    id: string,
    input: InternalInfrastructureGeneration,
    expectedRevision: string,
    administrator: BootstrapAdministrator,
  ): Promise<void> {
    await this.enterMaintenance(administrator);
    assertGenerationId(id);
    const candidate = compileBootstrapLayout(
      this.#opened.seed,
      input,
      this.#opened.factories,
    );
    const current = controlProjection(this.configService).prepared()
      .configuration;
    assertSameInfrastructureBindings(activeGeneration(current), candidate);
    await resolveGenerationCredentials(
      candidate,
      this.#opened.options.credentials,
    );
    await validateControlCandidate(
      this.configService,
      id,
      candidate,
      expectedRevision,
    );
    assertWrite(
      await this.#opened.control.stageGeneration(
        id,
        candidate,
        expectedRevision,
      ),
    );
  }
  async activateInfrastructure(
    id: string,
    expectedRevision: string,
    administrator: BootstrapAdministrator,
  ): Promise<void> {
    await this.enterMaintenance(administrator);
    const current = controlProjection(this.configService).prepared()
      .configuration;
    assertGenerationId(id);
    const candidate = current.infrastructure.generations[id];
    if (!candidate)
      throw createWeaverError("VALIDATION_ERROR", "Generation is not staged");
    assertSameInfrastructureBindings(activeGeneration(current), candidate);
    await resolveGenerationCredentials(
      candidate,
      this.#opened.options.credentials,
    );
    await validateControlCandidate(
      this.configService,
      id,
      candidate,
      expectedRevision,
    );
    assertWrite(
      await this.#opened.control.activateGeneration(id, expectedRevision),
    );
    this.#phase = "restart_required";
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#phase = "closed";
    try {
      this.notifyMaintenance();
    } catch {
      /* Close remains fail-closed when lifecycle notification fails. */
    }
    this.#closePromise = runIndependentCleanup([
      {
        name: "control/application owners",
        run: () => this.#opened.control.close(),
      },
      {
        name: "provider resources",
        run: () => disposeProviderResources(this.#opened.resources),
      },
    ]);
    return this.#closePromise;
  }
  private notifyMaintenance(): void {
    let failed = false;
    for (const listener of this.#maintenanceListeners) {
      try {
        listener();
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw createWeaverError(
        "MAINTENANCE",
        "Maintenance lifecycle notification failed",
      );
  }
}
export async function openWeaverRuntime(
  seed: unknown,
  options: BootstrapRuntimeOptions,
): Promise<WeaverRuntime> {
  const opened = await openRuntimeResources(seed, options);
  try {
    return constructRuntime(opened);
  } catch (error) {
    await runIndependentCleanup(
      [
        { name: "control owners", run: () => opened.control.close() },
        {
          name: "resources",
          run: () => disposeProviderResources(opened.resources),
        },
      ],
      error,
    );
    throw error;
  }
}

function publicErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code === "REVISION_CONFLICT"
      ? ("REVISION_CONFLICT" as const)
      : error.code === "VALIDATION_ERROR"
        ? ("VALIDATION_ERROR" as const)
        : error.code === "UNSUPPORTED_AUTHORITY"
          ? ("UNSUPPORTED_AUTHORITY" as const)
          : error.code === "COMMIT_OUTCOME_UNKNOWN"
            ? ("COMMIT_OUTCOME_UNKNOWN" as const)
            : error.code === "FORBIDDEN"
              ? ("FORBIDDEN" as const)
              : ("INTERNAL_ERROR" as const);
  return "INTERNAL_ERROR" as const;
}
