import type {
  CanonicalConfigurationPath,
  ConfigurationEffectiveChange,
} from "@weaver-conf/config-types";

export function createServiceEvents() {
  const listeners = new Map<
    CanonicalConfigurationPath,
    Set<(change: ConfigurationEffectiveChange) => void>
  >();
  return {
    subscribe(
      path: CanonicalConfigurationPath,
      listener: (change: ConfigurationEffectiveChange) => void,
    ) {
      const handlers = listeners.get(path) ?? new Set();
      listeners.set(path, handlers);
      handlers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlers.delete(listener);
        if (!handlers.size) listeners.delete(path);
      };
    },
    clear() {
      listeners.clear();
    },
  };
}
