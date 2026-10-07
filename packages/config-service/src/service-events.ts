import type {
  ConfigurationReaderChange,
  ConfigurationReaderSelection,
} from "@weaver-conf/config-types";
import type { PublicationPlan } from "./authority/publication";
import type { IdentitySnapshot } from "./identity-snapshots";
import { identityKey } from "./layer-stack";

/** Private historical evidence; authorization is always deferred until delivery. */
export interface ReaderChangeSnapshots {
  readonly selection: ConfigurationReaderSelection;
  readonly previous: IdentitySnapshot;
  readonly current: IdentitySnapshot;
  readonly cause: ConfigurationReaderChange["cause"];
}

interface Listener {
  readonly selection: ConfigurationReaderSelection;
  readonly listener: (change: ReaderChangeSnapshots) => void;
}

function snapshot(
  plan: PublicationPlan,
  selection: ConfigurationReaderSelection,
) {
  if (selection.viewId === undefined)
    return plan.ready.get(identityKey(selection.identity));
  for (const view of plan.views.values()) {
    if (
      view.selection.namespace === selection.namespace &&
      view.selection.viewId === selection.viewId &&
      identityKey(view.selection.identity) === identityKey(selection.identity)
    )
      return view.status === "ready" ? view.snapshot : undefined;
  }
  return undefined;
}

export function createServiceEvents() {
  const listeners = new Set<Listener>();
  return {
    subscribe(
      selection: ConfigurationReaderSelection,
      _path: string,
      listener: (change: ReaderChangeSnapshots) => void,
    ) {
      const entry = { selection, listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    publish(
      before: PublicationPlan,
      after: PublicationPlan,
      cause: ConfigurationReaderChange["cause"],
      settled: Promise<void>,
    ) {
      publishListeners(listeners, before, after, cause, settled);
    },
    clear() {
      listeners.clear();
    },
  };
}

function publishListeners(
  listeners: ReadonlySet<Listener>,
  before: PublicationPlan,
  after: PublicationPlan,
  cause: ConfigurationReaderChange["cause"],
  settled: Promise<void>,
): void {
  const pending = [...listeners].flatMap((entry) => {
    const previous = snapshot(before, entry.selection);
    const current = snapshot(after, entry.selection);
    if (!previous || !current || previous === current) return [];
    return [
      {
        entry,
        change: Object.freeze({
          selection: entry.selection,
          previous,
          current,
          cause,
        }),
      },
    ];
  });
  void settled
    .then(() => {
      for (const { entry, change } of pending) {
        if (!listeners.has(entry)) continue;
        try {
          entry.listener(change);
        } catch {
          /* Observer failure is not a storage outcome. */
        }
      }
    })
    .catch(() => {});
}
