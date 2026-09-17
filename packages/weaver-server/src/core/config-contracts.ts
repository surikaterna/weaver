import {
  createWeaverError,
  type InternalCatalogBinding,
} from "@weaver-conf/config-types";
import {
  builtinCatalogReference,
  prepareBuiltinCatalog,
  prepareControlCatalog,
} from "./builtin-catalog";
import type { TrustedProviderAuthority } from "./builtin-plan-validation";
import { projectCanonicalRegistrations } from "./canonical-projection";

export type PreparedConfiguration = ReturnType<typeof prepareBuiltinCatalog>;

/** Trusted contracts bind independently of, and before, application registrations. */
export class ConfigContracts {
  private current: PreparedConfiguration | undefined;
  private projection:
    | ReturnType<typeof projectCanonicalRegistrations>
    | undefined;

  constructor(
    readonly binding: InternalCatalogBinding,
    private readonly controlOnly = false,
    private readonly authorities: readonly TrustedProviderAuthority[] = [],
  ) {
    builtinCatalogReference();
  }

  prepare(raw: unknown): PreparedConfiguration {
    return this.controlOnly
      ? prepareControlCatalog(raw, this.binding)
      : prepareBuiltinCatalog(raw, this.binding, this.authorities);
  }

  install(prepared: PreparedConfiguration): void {
    const projection = projectCanonicalRegistrations(
      prepared.configuration.catalog,
    );
    this.current = prepared;
    this.projection = projection;
  }

  prepared(): PreparedConfiguration {
    if (!this.current)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Configuration catalog is not initialized",
      );
    return this.current;
  }

  registrations() {
    this.prepared();
    if (!this.projection)
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Registry projection unavailable",
      );
    return this.projection;
  }
}
