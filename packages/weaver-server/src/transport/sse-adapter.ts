// SSE transport adapter — three-event model (snapshot/change/checkpoint)
import { formatScopePath } from "@weaver-conf/config-types";
import type { WeaverConfigService } from "../core/config-service";
import { subscribeConfigServiceLifecycle } from "../core/config-service-lifecycle";
import { assertServiceScope, parseScopeQuery } from "../core/scope-utils";
import { type ConfigDelta, createWeaverError } from "../types/index";
import { SSEClientLifecycle } from "./sse-client-lifecycle";
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
  const lifecycle = new SSEClientLifecycle();
  const suspension = createWeaverError(
    "MAINTENANCE",
    "SSE adapter is suspended",
  );
  let clientIdCounter = 0;
  let stopLifecycle = () => {};

  async function createClient(
    clientOptions?: SSEClientOptions,
    signal?: AbortSignal,
  ): Promise<SSEClient> {
    const cancellation = lifecycle.beginCreation();
    const lifetime = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    try {
      const client = await createActiveClient(clientOptions, lifetime);
      lifetime.throwIfAborted();
      return client;
    } finally {
      lifecycle.finishCreation(cancellation);
    }
  }

  async function createActiveClient(
    clientOptions: SSEClientOptions | undefined,
    signal: AbortSignal,
  ): Promise<SSEClient> {
    signal.throwIfAborted();
    const context = clientContext(clientOptions, ++clientIdCounter);
    const { scopePath } = context;
    await whileActive(
      assertServiceScope(configService, scopePath, signal),
      signal,
    );
    signal.throwIfAborted();
    const client = subscribedClient(context, signal);
    signal.addEventListener("abort", client.close, { once: true });
    if (signal.aborted) client.close();
    signal.throwIfAborted();
    lifecycle.add(client, () => {
      context.messages.length = 0;
    });
    await sendSnapshot(client, context, signal);
    return client;
  }

  async function sendSnapshot(
    client: SSEClient,
    context: ReturnType<typeof clientContext>,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = await whileActive(
      configService.resolveAll(
        context.scopePath ? { scopePath: context.scopePath } : undefined,
      ),
      signal,
    ).catch((error: unknown) => {
      client.close();
      throw error;
    });
    const effectiveEntries = context.scope
      ? snapshot.scopes[context.scope]
      : snapshot.entries;
    if (!effectiveEntries) {
      client.close();
      throw createWeaverError("SCOPE_NOT_FOUND", "Scoped snapshot is missing");
    }
    const filteredEntries = filterEntriesByPrefix(
      effectiveEntries,
      context.opts.prefix,
    );

    signal.throwIfAborted();
    client.send({
      event: "snapshot",
      data: { entries: filteredEntries, revision: snapshot.revision },
    });
  }

  function subscribedClient(
    context: ReturnType<typeof clientContext>,
    signal: AbortSignal,
  ): SSEClient {
    let closed = false;
    let client: SSEClient;
    const unsubscribe = configService.onDelta((delta) => {
      if (closed || !matchesClient(delta, context)) return;
      client.send(changeMessage(delta, configService.revision));
    });
    client = {
      id: context.id,
      options: context.opts,
      messages: context.messages,
      send(message) {
        if (closed) return;
        if (context.messages.length >= maxBufferSize) context.messages.shift();
        context.messages.push(formatSSEMessage(message));
      },
      close() {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", client.close);
        unsubscribe();
        lifecycle.delete(client);
      },
    };
    return client;
  }

  function removeClient(client: SSEClient): void {
    client.close();
  }

  function closeAll(): void {
    stopLifecycle();
    lifecycle.dispose(
      createWeaverError("MAINTENANCE", "SSE adapter is closed"),
    );
  }

  function startCheckpointTimer(intervalMs = 30_000): void {
    lifecycle.startCheckpointTimer(
      () => ({
        event: "checkpoint",
        data: { revision: configService.revision },
      }),
      intervalMs,
    );
  }

  function stopCheckpointTimer(): void {
    lifecycle.stopCheckpointTimer();
  }

  const subscription = subscribeConfigServiceLifecycle(configService, (event) =>
    lifecycle.transition(event, suspension),
  );
  if (subscription) {
    stopLifecycle = subscription.unsubscribe;
    lifecycle.initialize(subscription.current, suspension);
  }

  return {
    createClient,
    removeClient,
    get clientCount() {
      return lifecycle.clientCount;
    },
    closeAll,
    startCheckpointTimer,
    stopCheckpointTimer,
  };
}

function clientContext(options: SSEClientOptions | undefined, id: number) {
  const opts = options ?? {};
  const scopePath = parseScopeQuery(opts.scope);
  const messages: string[] = [];
  return {
    id: `sse-${id}`,
    opts,
    scopePath,
    scope: scopePath ? formatScopePath(scopePath) : undefined,
    messages,
  };
}

function matchesClient(
  delta: ConfigDelta,
  context: ReturnType<typeof clientContext>,
): boolean {
  return (
    matchesPrefix(delta.key, context.opts.prefix) &&
    matchesScopeFilter(delta, context.scope)
  );
}

function changeMessage(delta: ConfigDelta, revision: string): SSEMessage {
  return {
    event: "change",
    data: {
      key: delta.key,
      value: delta.value,
      action: delta.action,
      revision,
      layer: delta.layer,
      environment: delta.environment,
      timestamp: delta.timestamp,
    },
  };
}
