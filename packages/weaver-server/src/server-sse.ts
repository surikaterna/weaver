import type { Request, Response } from "express";
import { corsHeaders } from "./transport/rest-helpers";
import type {
  SSEAdapter,
  SSEClient,
  SSEClientOptions,
} from "./transport/sse-adapter";
import type { SSEMessage } from "./transport/sse-events";

export async function handleSSE(
  url: URL,
  req: Request,
  res: Response,
  sseAdapter: SSEAdapter,
  corsOrigins: string[] | undefined,
): Promise<void> {
  const clientOptions: Record<string, string> = {};
  const prefix = url.searchParams.get("prefix");
  const scope = url.searchParams.get("scope");
  const since = url.searchParams.get("since");
  if (prefix) clientOptions.prefix = prefix;
  if (scope !== null) clientOptions.scope = scope;
  if (since) clientOptions.since = since;

  if (corsOrigins?.length) {
    const headers = corsHeaders(corsOrigins, req.headers.origin);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  const client = await createSSEConnection(req, res, sseAdapter, clientOptions);
  if (!client) return;
  if (res.destroyed) {
    client.close();
    return;
  }

  streamSSEClient(res, client);
}

function streamSSEClient(res: Response, client: SSEClient): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const msg of client.messages) {
    res.write(msg);
  }

  const originalSend = client.send.bind(client);
  Object.defineProperty(client, "send", {
    value(message: SSEMessage) {
      if (res.destroyed || res.writableEnded) return;
      originalSend(message);
      const formatted = client.messages[client.messages.length - 1];
      if (!formatted) {
        return;
      }
      res.write(formatted);
    },
    writable: true,
    configurable: true,
  });

  bindClientLifetime(res, client);
}

function bindClientLifetime(res: Response, client: SSEClient): void {
  const close = client.close.bind(client);
  Object.defineProperty(client, "close", {
    configurable: true,
    writable: true,
    value() {
      close();
      if (!res.destroyed && !res.writableEnded) res.end();
    },
  });
  res.once("close", () => client.close());
}

async function createSSEConnection(
  req: Request,
  res: Response,
  adapter: SSEAdapter,
  options: SSEClientOptions,
): Promise<SSEClient | undefined> {
  const lifetime = new AbortController();
  const disconnect = () => lifetime.abort();
  res.once("close", disconnect);
  if (req.aborted || res.destroyed) disconnect();
  try {
    const client = await adapter.createClient(options, lifetime.signal);
    if (!lifetime.signal.aborted) return client;
    client.close();
  } catch (error: unknown) {
    res.removeListener("close", disconnect);
    if (error instanceof Error && error.name === "AbortError") {
      res.destroy();
      return undefined;
    }
    if (!lifetime.signal.aborted) throw error;
  }
  return undefined;
}
