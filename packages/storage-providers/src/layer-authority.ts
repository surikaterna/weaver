import { randomUUID } from "node:crypto";
import { normalizeStorageWritePath } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type LayerCommitRequest,
  type LayerCommitResult,
  type LayerEnvelope,
  layerCommitRequestSchema,
  type ProviderAuthority,
  type ProviderCapabilities,
  type ProviderMutation,
  type ProviderOwnership,
  type ProviderPreflight,
  type ProviderWriterHandle,
  providerCapabilitiesSchema,
  providerInventorySchema,
  providerPreflightSchema,
  WeaverErrorInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import { ZodError } from "zod";
import { prepareEnvelope, revisionOf } from "./authority-envelope";

/** Backend must fence the whole namespace, including inventory creation/deletion. */
export interface AuthorityBackend {
  readonly capabilities: ProviderCapabilities;
  /** Retained ownership effects are independent of the initiating error's classification. */
  readonly requiresReconciliation?: boolean;
  preflight?(layers?: readonly string[]): Promise<ProviderPreflight>;
  inspectOwnership?(): Promise<ProviderOwnership>;
  releaseQuarantinedWriter?(): Promise<void>;
  acquire(): Promise<void>;
  release(): Promise<void>;
  read(layer: string): Promise<LayerEnvelope>;
  layers(): Promise<string[]>;
  persist(envelope: LayerEnvelope): Promise<void>;
}

export class LayerAuthority implements ProviderAuthority {
  readonly capabilities: ProviderCapabilities;
  private handle: ProviderWriterHandle | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  private quarantined = false;
  constructor(private readonly backend: AuthorityBackend) {
    this.capabilities = providerCapabilitiesSchema.parse(backend.capabilities);
  }
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.pending.then(job);
    this.pending = next.catch(() => undefined);
    return next;
  }
  acquireWriter(ownerId: string): Promise<ProviderWriterHandle> {
    return this.enqueue(async () => {
      if (this.quarantined || this.uncertain)
        throw createWeaverError(
          "COMMIT_OUTCOME_UNKNOWN",
          "Writer lifecycle requires controlled reconciliation",
        );
      if (this.handle)
        throw createWeaverError(
          "WRITER_CONFLICT",
          "Provider already has a writer",
        );
      try {
        await this.backend.acquire();
      } catch (error) {
        if (
          !(error instanceof WeaverErrorInstance) ||
          error.code === "COMMIT_OUTCOME_UNKNOWN" ||
          this.backend.requiresReconciliation === true
        )
          this.quarantined = true;
        throw error instanceof WeaverErrorInstance
          ? error
          : createWeaverError(
              "COMMIT_OUTCOME_UNKNOWN",
              "Writer acquisition was not acknowledged",
              { cause: String(error) },
            );
      }
      this.handle = Object.freeze({ ownerId });
      return this.handle;
    });
  }
  releaseWriter(handle: ProviderWriterHandle): Promise<void> {
    return this.enqueue(async () => {
      this.assertOwner(handle);
      this.handle = undefined;
      this.quarantined = true;
      try {
        await this.backend.release();
        this.quarantined = false;
      } catch (error) {
        throw createWeaverError(
          "COMMIT_OUTCOME_UNKNOWN",
          "Writer release was not acknowledged; old handle is revoked",
          {
            cause: String(error),
            ...(error instanceof WeaverErrorInstance
              ? { evidence: error.details }
              : {}),
          },
        );
      }
    });
  }
  async preflight(layers?: readonly string[]): Promise<ProviderPreflight> {
    if (this.backend.preflight)
      return providerPreflightSchema.parse(
        await this.backend.preflight(layers),
      );
    const namespace =
      "namespace" in this.capabilities
        ? this.capabilities.namespace
        : "unsupported";
    return providerPreflightSchema.parse({
      namespace,
      layers: await this.backend.layers(),
      initialization: "existing",
    });
  }
  async inspectOwnership(): Promise<ProviderOwnership> {
    if (!this.backend.inspectOwnership)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "No ownership reconciliation for this backend",
      );
    return this.backend.inspectOwnership();
  }
  releaseQuarantinedWriter(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.quarantined || !this.backend.releaseQuarantinedWriter)
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          "No safe quarantined release for this backend",
        );
      await this.backend.releaseQuarantinedWriter();
      this.quarantined = false;
    });
  }
  private assertOwner(handle: ProviderWriterHandle): void {
    if (!this.handle || this.handle !== handle)
      throw createWeaverError("WRITER_CONFLICT", "Invalid writer capability");
  }
  async readLayer(layer: string): Promise<LayerEnvelope> {
    return structuredClone(await this.backend.read(layer));
  }
  async inventory() {
    const revisions = await Promise.all(
      (await this.backend.layers())
        .sort()
        .map(async (layer) => revisionOf(await this.readLayer(layer))),
    );
    return providerInventorySchema.parse({ complete: true, revisions });
  }
  commitLayer(
    request: LayerCommitRequest,
    handle: ProviderWriterHandle,
  ): Promise<LayerCommitResult> {
    return this.enqueue(() => this.commit(request, handle));
  }
  private async commit(
    input: LayerCommitRequest,
    handle: ProviderWriterHandle,
  ): Promise<LayerCommitResult> {
    try {
      this.assertOwner(handle);
      if (this.uncertain)
        throw createWeaverError(
          "COMMIT_OUTCOME_UNKNOWN",
          "Restart and reconcile the last receipt before further writes",
        );
      const request = layerCommitRequestSchema.parse(input);
      const current = await this.backend.read(request.layer);
      const next = prepareEnvelope(current, request);
      this.assertCapacity(next);
      if (next !== current) await this.backend.persist(next);
      return {
        success: true,
        acknowledgement:
          this.capabilities.kind === "durable-exclusive"
            ? "durable"
            : "volatile",
        snapshot: structuredClone(next),
      };
    } catch (error) {
      if (
        error instanceof WeaverErrorInstance &&
        error.code === "COMMIT_OUTCOME_UNKNOWN"
      )
        this.uncertain = true;
      return {
        success: false,
        error: {
          code:
            error instanceof WeaverErrorInstance
              ? error.code
              : error instanceof ZodError
                ? "VALIDATION_ERROR"
                : "WRITE_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  private assertCapacity(envelope: LayerEnvelope): void {
    if (
      "maxEnvelopeBytes" in this.capabilities &&
      Buffer.byteLength(JSON.stringify(envelope)) >
        this.capabilities.maxEnvelopeBytes
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Envelope exceeds provider capacity",
      );
  }
}

/** Direct API calls use the same fenced commit, and cannot bypass a service owner. */
export async function directAuthorityWrite(
  authority: ProviderAuthority,
  layer: string,
  key: string,
  value?: unknown,
  remove = false,
): Promise<WriteResult> {
  const path = normalizeStorageWritePath(key);
  if (!path.ok) return { success: false, error: path.error };
  const input = layerCommitRequestSchema.shape.mutation.safeParse(
    remove
      ? { action: "remove", key: path.value }
      : { action: "set", key: path.value, value },
  );
  if (!input.success)
    return {
      success: false,
      error: { code: "VALIDATION_ERROR", message: input.error.message },
    };
  let handle: ProviderWriterHandle;
  try {
    handle = await authority.acquireWriter(randomUUID());
  } catch (error) {
    return {
      success: false,
      error: {
        code: error instanceof WeaverErrorInstance ? error.code : "WRITE_ERROR",
        message: String(error),
      },
    };
  }
  return finishDirectWrite(authority, layer, input.data, handle);
}

async function finishDirectWrite(
  authority: ProviderAuthority,
  layer: string,
  mutation: ProviderMutation,
  handle: ProviderWriterHandle,
): Promise<WriteResult> {
  let outcome: WriteResult;
  try {
    const current = await authority.readLayer(layer);
    const result = await authority.commitLayer(
      {
        layer,
        expectedRevision: revisionOf(current),
        operationId: randomUUID(),
        mutation,
      },
      handle,
    );
    outcome = result.success
      ? { success: true, revision: JSON.stringify(revisionOf(result.snapshot)) }
      : result;
  } catch (error) {
    outcome = {
      success: false,
      error: {
        code: error instanceof WeaverErrorInstance ? error.code : "WRITE_ERROR",
        message: String(error),
      },
    };
  }
  try {
    await authority.releaseWriter(handle);
  } catch (error) {
    return {
      success: false,
      error: {
        code: "COMMIT_OUTCOME_UNKNOWN",
        message: `Writer release was not acknowledged: ${String(error)}`,
      },
    };
  }
  return outcome;
}
