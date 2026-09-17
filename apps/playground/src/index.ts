import {
  createHttpTransport,
  createWeaverClient,
} from "@weaver-conf/weaver-client";
import {
  bootstrapCredentialsFromEnvironment,
  readBootstrapSeed,
  startWeaverServer,
} from "@weaver-conf/weaver-server";

/** Explicitly initialized sample seed; the playground never creates or converts operator data. */
async function main(): Promise<void> {
  const path = process.argv[2] ?? process.env.WEAVER_PLAYGROUND_SEED;
  const token = process.env.WEAVER_PLAYGROUND_TOKEN;
  if (!path || !token)
    throw new Error(
      "Usage: playground <private seed.json>; supply WEAVER_PLAYGROUND_TOKEN and named WEAVER_CREDENTIAL_* values after explicit initialization",
    );
  const seed = await readBootstrapSeed(path);
  const server = await startWeaverServer({
    seed,
    credentials: bootstrapCredentialsFromEnvironment(process.env),
  });
  const transport = createHttpTransport({
    baseUrl: `http://127.0.0.1:${server.port}`,
    headers: { authorization: `Bearer ${token}` },
  });
  let client: Awaited<ReturnType<typeof createWeaverClient>> | undefined;
  try {
    client = await createWeaverClient({ transport });
    const health = await fetch(`http://127.0.0.1:${server.port}/readyz`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (health.status !== 200) throw new Error("Server is not ready");
    console.log("app.name:", client.get("app.name"));
    const result = await client.set(
      "app.description",
      "Validated playground update",
      { layer: "platform" },
    );
    if (!result.success)
      throw new Error(
        "Sample app schema must permit app.description on platform",
      );
    const rejected = await client.set("uncovered.value", true, {
      layer: "platform",
    });
    if (rejected.success)
      throw new Error("Uncovered application writes must fail");
    console.log(
      "Validated HTTP/client read, write and strict rejection smoke passed",
    );
  } finally {
    try {
      await client?.close();
    } finally {
      await server.close();
    }
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Playground failed");
  process.exitCode = 1;
});
