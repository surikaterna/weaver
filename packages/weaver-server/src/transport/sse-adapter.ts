// SSE transport adapter — three-event model (snapshot/change/checkpoint)
import { formatScopePath } from "@weaver-conf/config-types";
import type { WeaverConfigService } from "../core/config-service";
import { assertServiceScope, parseScopeQuery } from "../core/scope-utils";
import { type ConfigDelta, createWeaverError } from "../types/index";
import { formatSSEMessage, type SSEMessage } from "./sse-events";

/** Default max messages retained per client to prevent unbounded memory growth */
const DEFAULT_MAX_BUFFER_SIZE = 1000;

export interface SSEAdapterOptions {
  configService: WeaverConfigService;
  /** Max messages retained per client (oldest evicted when full). Default: 1000 */
  maxBufferSize?: number;
}

export interface SSEClientOptions {
  prefix?: string;
  scope?: string;
  since?: string;
}

export interface SSEClient {
  readonly id: string;
  readonly options: SSEClientOptions;
  readonly messages: readonly string[];
  send(message: SSEMessage): void;
  close(): void;
}

export interface SSEAdapter {
  /** The signal controls connection lifetime; it is not a serialized option. */
  createClient(
    options?: SSEClientOptions,
    signal?: AbortSignal,
  ): Promise<SSEClient>;
  removeClient(client: SSEClient): void;
  readonly clientCount: number;
  closeAll(): void;
  startCheckpointTimer(intervalMs?: number): void;
  stopCheckpointTimer(): void;
}

function matchesPrefix(key: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  return key === prefix || key.startsWith(`${prefix}.`);
}

function filterEntriesByPrefix(
  entries: Record<string, unknown>,
  prefix: string | undefined,
): Record<string, unknown> {
  if (!prefix) return entries;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (matchesPrefix(key, prefix)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function matchesScopeFilter(
  delta: ConfigDelta,
  scope: string | undefined,
): boolean {
  if (!scope) return true;
  // Each scoped delta describes one full effective context, not its descendants.
  return delta.layer === scope;
}

async function whileActive<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const result = await Promise.race([operation, canceled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createSSEAdapter(options: SSEAdapterOptions): SSEAdapter {
  const { configService, maxBufferSize = DEFAULT_MAX_BUFFER_SIZE } = options;
  const clients = new Set<SSEClient & { unsubscribe: () => void }>();
  const pendingCreations = new Set<AbortController>();
  let clientIdCounter = 0;
  let checkpointTimer: ReturnType<typeof setInterval> | null = null;

  async function createClient(
    clientOptions?: SSEClientOptions,
    signal?: AbortSignal,
  ): Promise<SSEClient> {
    const cancellation = new AbortController();
    pendingCreations.add(cancellation);
    const lifetime = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    try {
      const client = await createActiveClient(clientOptions, lifetime);
      lifetime.throwIfAborted();
      return client;
    } finally {
      pendingCreations.delete(cancellation);
    }
  }

  async function createActiveClient(
    clientOptions: SSEClientOptions | undefined,
    signal: AbortSignal,
  ): Promise<SSEClient> {
    signal.throwIfAborted();
    const opts: SSEClientOptions = clientOptions ?? {};
    const messages: string[] = [];
    let closed = false;
    const id = `sse-${++clientIdCounter}`;

    const scopePath = parseScopeQuery(opts.scope);
    const scope = scopePath ? formatScopePath(scopePath) : undefined;
    await whileActive(
      assertServiceScope(configService, scopePath, signal),
      signal,
    );
    signal.throwIfAborted();

    const unsubscribe = configService.onDelta((delta) => {
      if (closed) return;
      if (!matchesPrefix(delta.key, opts.prefix)) return;
      if (!matchesScopeFilter(delta, scope)) return;

      client.send({
        event: "change",
        data: {
          key: delta.key,
          value: delta.value,
          action: delta.action,
          revision: configService.revision,
          layer: delta.layer,
          environment: delta.environment,
          timestamp: delta.timestamp,
        },
      });
    });

    const client: SSEClient & { unsubscribe: () => void } = {
      id,
      options: opts,
      messages,
      unsubscribe,
      send(message: SSEMessage): void {
        if (closed) return;
        if (messages.length >= maxBufferSize) {
          messages.shift();
        }
        messages.push(formatSSEMessage(message));
      },
      close(): void {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", client.close);
        unsubscribe();
        clients.delete(client);
      },
    };

    signal.addEventListener("abort", client.close, { once: true });
    if (signal.aborted) client.close();
    signal.throwIfAborted();
    clients.add(client);

    // v1: always send snapshot (delta history not tracked, so `since` is ignored)
    const snapshot = await whileActive(
      configService.resolveAll(scopePath ? { scopePath } : undefined),
      signal,
    ).catch((error: unknown) => {
      client.close();
      throw error;
    });
    const effectiveEntries = scope ? snapshot.scopes[scope] : snapshot.entries;
    if (!effectiveEntries) {
      client.close();
      throw createWeaverError("SCOPE_NOT_FOUND", "Scoped snapshot is missing");
    }
    const filteredEntries = filterEntriesByPrefix(
      effectiveEntries,
      opts.prefix,
    );

    if (!closed) {
      client.send({
        event: "snapshot",
        data: { entries: filteredEntries, revision: snapshot.revision },
      });
    }

    return client;
  }

  function removeClient(client: SSEClient): void {
    client.close();
  }

  function closeAll(): void {
    for (const pending of pendingCreations) pending.abort();
    for (const client of [...clients]) {
      client.close();
    }
  }

  function startCheckpointTimer(intervalMs = 30_000): void {
    stopCheckpointTimer();
    const timer = setInterval(() => {
      const msg: SSEMessage = {
        event: "checkpoint",
        data: { revision: configService.revision },
      };
      for (const client of clients) {
        client.send(msg);
      }
    }, intervalMs);
    timer.unref?.();
    checkpointTimer = timer;
  }

  function stopCheckpointTimer(): void {
    if (checkpointTimer !== null) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
  }

  return {
    createClient,
    removeClient,
    get clientCount() {
      return clients.size;
    },
    closeAll,
    startCheckpointTimer,
    stopCheckpointTimer,
  };
}
