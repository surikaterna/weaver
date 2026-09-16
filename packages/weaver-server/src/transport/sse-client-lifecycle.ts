import type { ConfigServiceLifecycleEvent } from "../core/config-service-lifecycle";
import type { SSEClient } from "./sse-adapter";
import type { SSEMessage } from "./sse-events";

interface CheckpointConfiguration {
  readonly createMessage: () => SSEMessage;
  readonly intervalMs: number;
}

export class SSEClientLifecycle {
  private readonly clients = new Map<SSEClient, () => void>();
  private readonly pending = new Set<AbortController>();
  private checkpointTimer: ReturnType<typeof setInterval> | undefined;
  private checkpoint: CheckpointConfiguration | undefined;
  private generation = 0;
  private suspension: unknown;
  private disposed: unknown;

  get clientCount(): number {
    return this.clients.size;
  }

  beginCreation(): AbortController {
    if (this.disposed !== undefined) throw this.disposed;
    if (this.suspension !== undefined) throw this.suspension;
    const controller = new AbortController();
    this.pending.add(controller);
    return controller;
  }

  finishCreation(controller: AbortController): void {
    this.pending.delete(controller);
  }

  add(client: SSEClient, clearMessages: () => void = () => {}): void {
    if (this.disposed !== undefined) throw this.disposed;
    if (this.suspension !== undefined) throw this.suspension;
    this.clients.set(client, clearMessages);
  }

  delete(client: SSEClient): void {
    this.clients.delete(client);
  }

  dispose(reason: unknown): void {
    if (this.disposed !== undefined) return;
    this.disposed = reason;
    this.checkpoint = undefined;
    this.clearCheckpointTimer();
    for (const controller of this.pending) controller.abort();
    this.closeClients(false);
  }

  initialize(event: ConfigServiceLifecycleEvent, reason: unknown): void {
    this.generation = event.generation;
    if (event.state === "suspended") this.suspend(reason, event.generation);
  }

  transition(event: ConfigServiceLifecycleEvent, reason: unknown): void {
    if (this.disposed !== undefined || event.generation < this.generation)
      return;
    if (event.state === "suspended") {
      if (event.generation === this.generation) return;
      this.suspend(reason, event.generation);
      return;
    }
    if (event.generation !== this.generation || this.suspension === undefined)
      return;
    this.suspension = undefined;
    this.installCheckpointTimer();
  }

  private suspend(reason: unknown, generation: number): void {
    if (generation === this.generation && this.suspension !== undefined) return;
    this.generation = generation;
    this.suspension = reason;
    this.clearCheckpointTimer();
    for (const controller of this.pending) controller.abort(reason);
    this.closeClients(true);
  }

  startCheckpointTimer(
    createMessage: () => SSEMessage,
    intervalMs: number,
  ): void {
    if (this.suspension !== undefined) throw this.suspension;
    if (this.disposed !== undefined) throw this.disposed;
    this.checkpoint = { createMessage, intervalMs };
    this.installCheckpointTimer();
  }

  private installCheckpointTimer(): void {
    const checkpoint = this.checkpoint;
    if (!checkpoint || this.disposed !== undefined) return;
    this.clearCheckpointTimer();
    const generation = this.generation;
    const timer = setInterval(() => {
      if (this.suspension !== undefined || generation !== this.generation)
        return;
      const message = checkpoint.createMessage();
      for (const client of this.clients.keys()) client.send(message);
    }, checkpoint.intervalMs);
    timer.unref?.();
    this.checkpointTimer = timer;
  }

  stopCheckpointTimer(): void {
    this.checkpoint = undefined;
    this.clearCheckpointTimer();
  }

  private clearCheckpointTimer(): void {
    if (this.checkpointTimer === undefined) return;
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = undefined;
  }

  private closeClients(clearBuffers: boolean): void {
    for (const [client, clearMessages] of [...this.clients]) {
      if (clearBuffers) clearMessages();
      client.close();
    }
  }
}
