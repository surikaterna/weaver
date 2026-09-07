// SSE transport adapter — three-event model (snapshot/change/checkpoint)
import type { WeaverConfigService } from "../core/config-service";
import { parseScopeQuery } from "../core/scope-utils";
import type { ConfigDelta } from "../types/index";
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
  createClient(options?: SSEClientOptions): Promise<SSEClient>;
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
  // scope filter format: "scopeId:value" — match against delta.layer
  return delta.layer === scope || delta.layer.startsWith(`${scope}/`);
}

export function createSSEAdapter(options: SSEAdapterOptions): SSEAdapter {
  const { configService, maxBufferSize = DEFAULT_MAX_BUFFER_SIZE } = options;
  const clients = new Set<SSEClient & { unsubscribe: () => void }>();
  let clientIdCounter = 0;
  let checkpointTimer: ReturnType<typeof setInterval> | null = null;

  async function createClient(
    clientOptions?: SSEClientOptions,
  ): Promise<SSEClient> {
    const opts: SSEClientOptions = clientOptions ?? {};
    const messages: string[] = [];
    let closed = false;
    const id = `sse-${++clientIdCounter}`;

    const scopePath = parseScopeQuery(opts.scope);

    const unsubscribe = configService.onDelta((delta) => {
      if (closed) return;
      if (!matchesPrefix(delta.key, opts.prefix)) return;
      if (!matchesScopeFilter(delta, opts.scope)) return;

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
        unsubscribe();
        clients.delete(client);
      },
    };

    clients.add(client);

    // v1: always send snapshot (delta history not tracked, so `since` is ignored)
    const snapshot = await configService
      .resolveAll(scopePath ? { scopePath } : undefined)
      .catch((error: unknown) => {
        client.close();
        throw error;
      });
    const filteredEntries = filterEntriesByPrefix(
      snapshot.entries,
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
