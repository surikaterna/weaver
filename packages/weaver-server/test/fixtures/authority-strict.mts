import { startWeaverServer, serverAuthorityOptionsSchema, type ServerAuthorityOptions, type WeaverServerOptions } from "@weaver-conf/weaver-server";
import { canonicalConfigurationPathSchema, defineWeaver, Layers, type ConfigurationServiceOptions, type ConfigurationHostAuthority, type TrustedPrincipalSnapshot } from "@weaver-conf/config-types";
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import type { AuthConfig } from "@weaver-conf/config-auth";
import { z } from "zod";

const provider = createFileSystemStorageProvider({ id: "base", layer: "files", filePath: "config.json", writable: true });
const configuration: ConfigurationServiceOptions = {
  identity: { environment: "dev", scopePath: [] }, schemas: [],
  layers: [{ kind: "fixed", layer: "files", providerIds: ["base"] }],
  providers: [{ id: "base", layer: "files", provider, operation: { kind: "load" },
    environment: { kind: "environments", environments: ["dev"] }, ownership: { kind: "borrowed" } }],
};
const authConfig: AuthConfig = {
  weaverConfig: defineWeaver([Layers.Static("files")]),
  visibilityRoles: { admin: new Set(), platform: new Set() },
  dynamicScopeRoles: new Set(), layerWritePolicies: [{ layer: "files", allowedRoles: ["editor"] }],
};
class Host implements ConfigurationHostAuthority {
  authorizeReadSync(): "allowed" { return "allowed"; }
  async authorizeWrite(): Promise<"allowed"> { return "allowed"; }
}
const authority: ServerAuthorityOptions = {
  configuration, registry: { providerId: "base", layer: "files" }, authConfig, hostAuthority: new Host(),
  writers: [{ providerId: "base", operation: { kind: "write" }, flush: "none", failureSemantics: "unknown" }],
  mapPrincipal(context, requestedIdentity): TrustedPrincipalSnapshot {
    return { principalId: context.identity.userId ?? "service", roles: ["editor"], grants: [{
      identity: requestedIdentity, namespace: canonicalConfigurationPathSchema.parse("/example"), operations: ["read", "inspect", "write"],
      layers: ["files"], views: [], sensitive: false,
    }] };
  },
};
const output: z.output<typeof serverAuthorityOptionsSchema> = authority;
const options: WeaverServerOptions = { port: 0, jwtSecret: "test-only", authority: output };
const started: ReturnType<typeof startWeaverServer> = startWeaverServer(options);
void started;
// @ts-expect-error A principal callback is required, not a trust flag.
const invalid: ServerAuthorityOptions = { configuration, registry: authority.registry, authConfig, hostAuthority: new Host(), writers: [] };
void invalid;
