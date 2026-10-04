import {
  type ConfigurationServiceOptions,
  createWeaverError,
  type HydratedConfigurationService,
} from "@weaver-conf/config-types";
import type { HttpServer } from "./http-server";

export function borrowAuthorityProviders(
  configuration: ConfigurationServiceOptions,
) {
  const hooks = new Set<() => void | Promise<void>>();
  const providers = new Set<object>();
  for (const binding of configuration.providers) {
    if (binding.ownership.kind !== "owned" || providers.has(binding.provider))
      continue;
    providers.add(binding.provider);
    hooks.add(binding.ownership.dispose);
  }
  const borrowed: ConfigurationServiceOptions = {
    ...configuration,
    providers: configuration.providers.map((binding) => ({
      ...binding,
      ownership: { kind: "borrowed" },
    })),
  };
  return { configuration: borrowed, hooks: [...hooks] };
}

export function createAuthorityLifecycle(
  hooks: readonly (() => void | Promise<void>)[],
) {
  let root: HydratedConfigurationService | undefined;
  let server: HttpServer | undefined;
  let closing = false;
  let completion: Promise<void> | undefined;
  return {
    get closing() {
      return closing;
    },
    attachRoot(value: HydratedConfigurationService) {
      root = value;
    },
    attachServer(value: HttpServer) {
      server = value;
    },
    close(): Promise<void> {
      if (completion) return completion;
      closing = true;
      // Fence synchronously, but never release providers until core IO has settled.
      const disposing = invoke(() => root?.dispose()).then((result) => {
        if (result && !result.ok)
          throw createWeaverError("INTERNAL_ERROR", "Authority cleanup failed");
      });
      const stopping = invoke(() => server?.stop());
      completion = settle(disposalPair(disposing, stopping), hooks);
      return completion;
    },
  };
}

function invoke<T>(operation: () => T): Promise<Awaited<T>> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}
function disposalPair(root: Promise<unknown>, server: Promise<unknown>) {
  return Promise.allSettled([root, server]);
}
async function settle(
  pending: Promise<PromiseSettledResult<unknown>[]>,
  hooks: readonly (() => void | Promise<void>)[],
): Promise<void> {
  let failed = (await pending).some((result) => result.status === "rejected");
  for (const hook of hooks) {
    try {
      await hook();
    } catch {
      failed = true;
    }
  }
  if (failed)
    throw createWeaverError("INTERNAL_ERROR", "Authority cleanup failed");
}
