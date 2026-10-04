import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";

// Finite newline-JSON request harness, not the official SCOMP wire protocol.
function receive(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", data); socket.off("error", failed); socket.off("end", ended);
    };
    const failed = (error) => { cleanup(); reject(error); };
    const ended = () => failed(new Error("Test RPC ended before a response"));
    const data = (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      cleanup();
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
    };
    socket.setEncoding("utf8");
    socket.on("data", data); socket.once("error", failed); socket.once("end", ended);
  });
}

async function dispatch(socket, routes, seen) {
  try {
    const { route, payload } = await receive(socket);
    seen.push(route);
    const entry = routes()[route];
    assert.equal(entry?.kind, "request");
    const value = await entry.handler(payload, {});
    socket.end(`${JSON.stringify({ ok: true, value })}\n`);
  } catch {
    socket.end(`${JSON.stringify({ ok: false })}\n`);
  }
}

async function invoke(port, route, payload) {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(5000, () => socket.destroy(new Error("Test RPC timed out")));
  const response = receive(socket);
  socket.once("connect", () => socket.write(`${JSON.stringify({ route, payload })}\n`));
  try {
    const result = await response;
    assert.equal(result.ok, true, "Actual registered route rejected test RPC");
    return result.value;
  } finally { socket.destroy(); }
}

export async function createLoopbackTransport() {
  let routes = {}, closing;
  const sockets = new Set(), seen = [];
  const server = createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    void dispatch(socket, () => routes, seen);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port, seen,
    get routeNames() { return Object.keys(routes).sort(); },
    registerRoutes(router) { routes = router; },
    invoke: (route, payload) => invoke(port, route, payload),
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

export function clientFactory(transport, token, kinds) {
  return new Proxy({}, {
    get(_target, method) {
      if (method === "then" || typeof method !== "string") return undefined;
      const route = `${token.name}.${method}`;
      assert.equal(kinds?.[route], "request");
      return (payload) => transport.invoke(route, payload);
    },
  });
}
