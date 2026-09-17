# Server quickstart

Standalone startup requires an explicitly initialized private seed. Follow the complete [seed bootstrap guide](bootstrap-config-repo.md) for the seed, generation, credential references and initialization commands. There is no implicit in-memory fallback, repository bootstrap file or alternate provider/rank option.

```ts
import { readBootstrapSeed, bootstrapCredentialsFromEnvironment, startWeaverServer } from "@weaver-conf/weaver-server";

const seed = await readBootstrapSeed("/etc/weaver/seed.json");
const server = await startWeaverServer({ seed, credentials: bootstrapCredentialsFromEnvironment(process.env) });
console.log(server.port, server.runtime.status);
// On shutdown:
await server.close();
```

Server port, CORS, authentication references, roles and layer order come from the active immutable infrastructure generation. `/healthz` reports process health; `/readyz` is 200 only while the validated runtime is ready. Missing initialization or unsupported data refuses before binding a port. Maintenance and restart-required states deny application traffic and close SSE.

REST configuration/schema routes and the configured scope manager share the same service/authority as `server.runtime.configService`, `schemaRegistry`, and `scopeManager`. Use signed JWTs carrying the generation's administrator roles for mutations. `server.runtime.createScompService(getAuthenticatedPeerContext)` provides the same services to an explicitly installed SCOMP host. No peer identity is accepted from input JSON.

Scope provisioning activates prepared catalog contexts; retirement preserves physical data. Unknown contexts refuse. Register schemas before application writes, and send the current `If-Match` token for replacements. Effective defaults and recursively resolved values are validated before delivery.

The CLI supports only `initialize`, `inspect`, `validate`, and `start`; all use the same runtime implementation. See the bootstrap guide for recovery, supported FS/Git/Mongo profiles, and explicit embedded-memory limits. The [playground](../../apps/playground/src/index.ts) now consumes an already initialized seed and supplied JWT rather than constructing an ungoverned test server.
