import type {
  CanonicalConfigurationPath,
  ConfigurationService,
  ConfigurationServiceWriteResult,
  HydratedConfigurationInspection,
  HydratedConfigurationService,
  HydratedScopedConfigurationService,
  HydratedServiceConfigurationService,
  RelativeConfigurationPath,
  WriteResult,
} from "@weaver-conf/config-types";
import {
  canonicalConfigurationPathSchema,
  relativeConfigurationPathSchema,
} from "@weaver-conf/config-types";

declare const root: HydratedConfigurationService;
declare const scoped: HydratedScopedConfigurationService;
declare const service: HydratedServiceConfigurationService;
declare const legacy: ConfigurationService;
const path: CanonicalConfigurationPath =
  canonicalConfigurationPathSchema.parse("/ghost/value");
const relative: RelativeConfigurationPath =
  relativeConfigurationPathSchema.parse(["literal.dot"]);
const snapshot: HydratedConfigurationInspection = root.inspect(path);
const scopedSnapshot: HydratedConfigurationInspection =
  scoped.inspect(relative);
const provider: WriteResult = { success: true };
const oldRead: string | undefined = legacy.get<string>("old.key");
void [snapshot, scopedSnapshot, provider, oldRead];

async function writes(): Promise<ConfigurationServiceWriteResult> {
  const written = await root.set(path, 1, { layer: "user", ifRevision: "r" });
  if (written.success) {
    const accepted: string = written.layer + written.revision;
    void accepted;
    // @ts-expect-error success has no error
    written.error;
  } else {
    const outcome: "rejected" | "unknown" = written.outcome;
    void [outcome, written.error.code];
    // @ts-expect-error failure has no accepted revision
    written.revision;
  }
  return await root.remove(path, { layer: "user" });
}
void writes;
// @ts-expect-error no Zod overload
root.get(path, canonicalConfigurationPathSchema);
// @ts-expect-error no caller actor
root.set(path, 1, { layer: "user", actor: "plugin" });
// @ts-expect-error captured ordered scope is readonly
root.identity.scopePath.push({ scopeId: "tenant", value: "other" });
// @ts-expect-error parsed scope fields are readonly
root.identity.scopePath[0].value = "other";
// @ts-expect-error relative tuples are readonly
relative.push("escape");
// @ts-expect-error inspect is not Promise-based
const asyncInspection: Promise<HydratedConfigurationInspection> =
  root.inspect(path);
void asyncInspection;
// @ts-expect-error scoped handle has no writable root
scoped.root;
// @ts-expect-error no transport
scoped.transport;
// @ts-expect-error no client
scoped.client;
// @ts-expect-error no session
scoped.session;
// @ts-expect-error no writes
scoped.set(relative, 1, { layer: "user" });
// @ts-expect-error no remove
scoped.remove(relative, { layer: "user" });
// @ts-expect-error executable views deferred
scoped.forView("view");
// @ts-expect-error service handle has no writable root
service.root;
// @ts-expect-error no service transport
service.transport;
// @ts-expect-error no service session
service.session;
// @ts-expect-error no service writes
service.set(relative, 1, { layer: "user" });
// @ts-expect-error no service remove
service.remove(relative, { layer: "user" });
// @ts-expect-error no service view grant
service.forView("view");
