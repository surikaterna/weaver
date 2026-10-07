import type {
  CanonicalConfigurationPath,
  ConfigurationMutationAuthority,
  ConfigurationMutationResult,
  ConfigurationReader,
  ConfigurationService,
  HydratedConfigurationInspection,
  RelativeConfigurationPath,
  WriteResult,
} from "@weaver-conf/config-types";
import {
  canonicalConfigurationPathSchema,
  relativeConfigurationPathSchema,
} from "@weaver-conf/config-types";

declare const root: ConfigurationService;
declare const scoped: ConfigurationReader;
declare const mutations: ConfigurationMutationAuthority;
const path: CanonicalConfigurationPath =
  canonicalConfigurationPathSchema.parse("/example/value");
const relative: RelativeConfigurationPath =
  relativeConfigurationPathSchema.parse(["literal.dot"]);
const snapshot: HydratedConfigurationInspection = scoped.inspect();
const scopedSnapshot: HydratedConfigurationInspection =
  scoped.inspect(relative);
const provider: WriteResult = { success: true };
const view: ConfigurationReader = scoped.forView("view").withScope([]);
void [snapshot, scopedSnapshot, provider, view];

async function writes(): Promise<ConfigurationMutationResult> {
  const selection = {
    identity: scoped.selection.identity,
    namespace: path,
    path,
    layer: "user",
  };
  const written = await mutations.apply([
    { ...selection, operation: "set", value: 1, ifRevision: "r" },
  ]);
  if (written.success) {
    for (const item of written.revisions) {
      const accepted: string = item.revision;
      void accepted;
    }
    // @ts-expect-error success has no error
    written.error;
  } else {
    const outcome: "rejected" | "partial" | "unknown" = written.outcome;
    void [outcome, written.error.code];
    // @ts-expect-error failure has no accepted revision
    written.revision;
  }
  return await mutations.apply([{ ...selection, operation: "remove" }]);
}
void writes;
// @ts-expect-error no Zod overload
root.get(path, canonicalConfigurationPathSchema);
// @ts-expect-error no caller actor
root.set(path, 1, { layer: "user", actor: "plugin" });
// @ts-expect-error captured ordered scope is readonly
scoped.selection.identity.scopePath.push({ scopeId: "tenant", value: "other" });
// @ts-expect-error parsed scope fields are readonly
scoped.selection.identity.scopePath[0].value = "other";
// @ts-expect-error relative tuples are readonly
relative.push("escape");
// @ts-expect-error inspect is not Promise-based
const asyncInspection: Promise<HydratedConfigurationInspection> =
  scoped.inspect(relative);
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
// @ts-expect-error host lifecycle has no data access
root.get(relative);
// @ts-expect-error readers have no global principal binding
scoped.bindRoot({});
// @ts-expect-error absolute strings are not relative segment paths
scoped.get(path);
