import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  bootstrapSeedSchema,
  initializeWeaverRequestSchema,
  type ObjectConfigurationPropertySchema,
  type ScopeInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize";
import { authenticateBootstrapAdministrator } from "../src/bootstrap/seed-trust";
import { scopeContextId } from "../src/core/scope-inventory";
import { startWeaverServer, type WeaverServer } from "../src/server";

export const testAdmin =
  "bootstrap-administrator-credential-000000000000000000000000";
export const testJwt =
  "server-jwt-credential-0000000000000000000000000000000000";
interface FixtureOptions {
  schemas?: Readonly<Record<string, ObjectConfigurationPropertySchema>>;
  paths?: readonly ScopeInstance[][];
  retired?: readonly ScopeInstance[][];
  entries?: Record<string, unknown>;
  scopedEntries?: Record<string, Record<string, unknown>>;
  corsOrigins?: string[];
  adminRoles?: string[];
}
export async function createStandaloneFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "weaver-bootstrap-"));
  const port = await freePort();
  const paths = [...(options.paths ?? []), ...(options.retired ?? [])];
  const dimensions = [
    ...new Set(paths.flatMap((path) => path.map((scope) => scope.scopeId))),
  ];
  const scopes = dimensions.map((id) => {
    const path =
      paths.find((candidate) =>
        candidate.some((scope) => scope.scopeId === id),
      ) ?? [];
    const index = path.findIndex((scope) => scope.scopeId === id);
    return {
      id,
      label: id,
      ...(index > 0 ? { parentScopeId: path[index - 1]?.scopeId } : {}),
    };
  });
  const seed = bootstrapSeedSchema.parse({
    version: 1,
    environment: "dev",
    store: {
      factory: "fs",
      locator: { filePath: join(directory, "control", "entries.json") },
    },
    trust: { adminCredentialRef: "administrator" },
  });
  const names = ["control", "platform", ...dimensions];
  const request = initializeWeaverRequestSchema.parse({
    generationId: "g1",
    generation: {
      version: 1,
      layout: {
        layers: names.map((name) => ({
          name,
          type: dimensions.includes(name) ? "dynamic" : "static",
          providerId: name,
          config: {
            mergeId: "deep",
            ...(dimensions.includes(name) ? { scopeIds: [name] } : {}),
          },
        })),
        scopes,
      },
      providers: names.map((id) => ({
        id,
        factory: "fs",
        options: { filePath: join(directory, id, "entries.json") },
      })),
      server: {
        port,
        ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : {}),
        auth: {
          credentialRef: "jwt",
          adminRoles: options.adminRoles ?? ["admin"],
        },
      },
    },
    registrations: Object.entries(options.schemas ?? {}).map(
      ([serviceId, schema]) => ({
        serviceId,
        environment: "dev",
        owner: { name: "fixture", contact: "fixture@example.test" },
        schema,
        fragmentSlots: [],
      }),
    ),
    scopeInventory: {
      version: 1,
      revision: "0",
      contexts: Object.fromEntries(
        paths.map((scopePath) => [
          scopeContextId(scopePath),
          {
            scopePath,
            state: options.retired?.some(
              (path) => scopeContextId(path) === scopeContextId(scopePath),
            )
              ? "retired"
              : "active",
          },
        ]),
      ),
    },
  });
  const credentials = {
    resolveCredential: (reference: string) =>
      reference === "administrator"
        ? testAdmin
        : reference === "jwt"
          ? testJwt
          : undefined,
  };
  const administrator = await authenticateBootstrapAdministrator(
    seed,
    testAdmin,
    credentials,
  );
  return {
    directory,
    seed,
    request,
    credentials,
    administrator,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
export async function startStandaloneFixture(
  options: FixtureOptions = {},
): Promise<WeaverServer> {
  const fixture = await createStandaloneFixture(options);
  let server: WeaverServer | undefined;
  try {
    await initializeWeaver(
      fixture.seed,
      fixture.request,
      fixture.administrator,
      { credentials: fixture.credentials },
    );
    server = await startWeaverServer({
      seed: fixture.seed,
      credentials: fixture.credentials,
    });
    for (const [key, value] of Object.entries(options.entries ?? {}))
      requireWrite(
        await server.runtime.configService.set("platform", key, value),
      );
    for (const [layer, entries] of Object.entries(options.scopedEntries ?? {}))
      for (const [key, value] of Object.entries(entries))
        requireWrite(await server.runtime.configService.set(layer, key, value));
    return withFixtureCleanup(server, fixture.dispose);
  } catch (error) {
    await runIndependentCleanup(
      [
        {
          name: "server",
          run: async () => {
            await server?.close();
          },
        },
        { name: "fixture files", run: fixture.dispose },
      ],
      error,
    );
    throw error;
  }
}
function requireWrite(result: WriteResult): void {
  if (!result.success)
    throw new Error(`Invalid declared fixture data: ${result.error?.message}`);
}
function withFixtureCleanup(
  server: WeaverServer,
  dispose: () => Promise<void>,
): WeaverServer {
  let closed: Promise<void> | undefined;
  return {
    get port() {
      return server.port;
    },
    get isReady() {
      return server.isReady;
    },
    authEnabled: true,
    runtime: server.runtime,
    close() {
      closed ??= runIndependentCleanup([
        { name: "server", run: () => server.close() },
        { name: "fixture files", run: dispose },
      ]);
      return closed;
    },
  };
}
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No fixture port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
