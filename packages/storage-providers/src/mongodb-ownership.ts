import { randomUUID } from "node:crypto";
import { runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type MongoLayerEnvelope,
  type ProviderOwnership,
  providerOwnershipSchema,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import type { Collection, WriteConcernSettings } from "mongodb";

interface FenceAttempt {
  readonly layer: string;
  readonly previousFence: string;
  readonly fence: string;
  phase: "acquiring" | "owned" | "releasing";
  settled: boolean;
}

/** Every IO is bound to this instance's owner and exact fence, including recovery. */
export class MongoOwnership {
  readonly owner = randomUUID();
  private readonly attempts = new Map<string, FenceAttempt>();
  constructor(
    private readonly collection: Collection,
    private readonly environment: string,
    private readonly namespace: string,
    private readonly writeConcern: WriteConcernSettings,
  ) {}
  get requiresReconciliation(): boolean {
    return [...this.attempts.values()].some((attempt) => !attempt.settled);
  }
  fence(layer: string): string | undefined {
    const attempt = this.attempts.get(layer);
    return attempt?.phase === "owned" && !attempt.settled
      ? attempt.fence
      : undefined;
  }
  async acquire(doc: MongoLayerEnvelope): Promise<void> {
    const attempt: FenceAttempt = {
      layer: doc.layer,
      previousFence: doc.fence,
      fence: (BigInt(doc.fence) + 1n).toString(),
      phase: "acquiring",
      settled: false,
    };
    this.attempts.set(doc.layer, attempt);
    try {
      const result = await this.collection.updateOne(
        {
          environment: this.environment,
          layer: doc.layer,
          owner: null,
          fence: doc.fence,
        },
        { $set: { owner: this.owner, fence: attempt.fence } },
        { writeConcern: this.writeConcern },
      );
      if (!result.acknowledged)
        throw new Error("Unacknowledged ownership update");
      if (result.matchedCount !== 1) {
        attempt.settled = true;
        throw createWeaverError(
          "WRITER_CONFLICT",
          "Mongo namespace already owned; no automatic takeover",
        );
      }
      attempt.phase = "owned";
    } catch (error) {
      if (
        error instanceof WeaverErrorInstance &&
        error.code === "WRITER_CONFLICT"
      )
        throw error;
      throw await this.uncertain("acquire", error);
    }
  }
  async release(): Promise<void> {
    const pending = [...this.attempts.values()].filter(
      (attempt) => !attempt.settled,
    );
    const failures: unknown[] = [];
    for (const attempt of pending) {
      try {
        await this.releaseLayer(attempt);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw await this.uncertain("release", failures.map(String));
  }
  private async releaseLayer(attempt: FenceAttempt): Promise<void> {
    attempt.phase = "releasing";
    const result = await this.collection.updateOne(
      {
        environment: this.environment,
        layer: attempt.layer,
        $or: [
          { owner: this.owner, fence: attempt.fence },
          { owner: null, fence: attempt.previousFence },
        ],
      },
      // Advancing the unowned previous tuple cancels even an acquire still in flight.
      { $set: { owner: null, fence: attempt.fence } },
      { writeConcern: this.writeConcern },
    );
    if (!result.acknowledged)
      throw new Error("Unacknowledged ownership release");
    if (result.matchedCount !== 1) {
      const observed = await this.observe(attempt);
      if (observed !== "released")
        throw createWeaverError(
          "WRITER_CONFLICT",
          "Cannot release another Mongo owner/fence",
        );
    }
    attempt.settled = true;
  }
  async abort(error: unknown): Promise<void> {
    if (
      error instanceof WeaverErrorInstance &&
      error.code === "COMMIT_OUTCOME_UNKNOWN"
    )
      throw error;
    await runIndependentCleanup(
      [{ name: "Mongo acquired fences", run: () => this.release() }],
      error,
    );
  }
  async inspect(): Promise<ProviderOwnership> {
    const layers = await Promise.all(
      [...this.attempts.values()].map(async (attempt) => ({
        layer: attempt.layer,
        previousFence: attempt.previousFence,
        fence: attempt.fence,
        phase: attempt.phase,
        observed: await this.observe(attempt),
      })),
    );
    return providerOwnershipSchema.parse({
      namespace: this.namespace,
      owner: this.owner,
      layers,
    });
  }
  private async observe(
    attempt: FenceAttempt,
  ): Promise<ProviderOwnership["layers"][number]["observed"]> {
    try {
      const doc = await this.collection.findOne(
        { environment: this.environment, layer: attempt.layer },
        {
          projection: { owner: 1, fence: 1 },
          readConcern: { level: "majority" },
          maxTimeMS: 30_000,
        },
      );
      if (doc?.owner === this.owner && doc.fence === attempt.fence)
        return "owned";
      if (doc?.owner === null && doc.fence === attempt.fence) return "released";
      if (doc?.owner === null && doc.fence === attempt.previousFence)
        return "not-applied";
      return "lost";
    } catch {
      return "unknown";
    }
  }
  private async uncertain(phase: string, error: unknown) {
    return createWeaverError(
      "COMMIT_OUTCOME_UNKNOWN",
      `Mongo ownership ${phase} outcome requires reconciliation`,
      { cause: String(error), ownership: await this.inspect() },
    );
  }
}
