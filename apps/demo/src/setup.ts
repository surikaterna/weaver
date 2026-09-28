import type { OverrideSessionController } from "@weaver-conf/config-sessions";
import { createOverrideSessionProvider } from "@weaver-conf/config-sessions";
import type { WeaverConfig } from "@weaver-conf/config-types";
import { defineWeaver, Layers } from "@weaver-conf/config-types";
import type { WeaverClient } from "@weaver-conf/weaver-client";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "./demo-transport";

/** All registered provider layer names, in rank order (lowest to highest). */
export const ALL_PROVIDER_LAYERS: readonly string[] = [
  "core",
  "app",
  "tenant",
  "country:GB",
  "country:NL",
  "location:GBDVR",
  "location:FRCQF",
  "location:NLEUR",
  "user",
  "session",
];

export async function initService(): Promise<{
  client: WeaverClient;
  session: OverrideSessionController;
  weaverConfig: WeaverConfig;
}> {
  const weaverConfig = defineWeaver([
    Layers.Static("core"),
    Layers.Static("app"),
    Layers.Dynamic("tenant"),
    Layers.Personal("user"),
    Layers.Ephemeral("session"),
  ] as const);

  const session = createOverrideSessionProvider({
    layer: "session",
    defaultDurationMs: 5 * 60 * 1000,
  });

  const transport = createDemoTransport();

  const client = await createWeaverClient({ transport, scopeLoading: "eager" });

  return { client, session, weaverConfig };
}
