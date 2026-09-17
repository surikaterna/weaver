import type {
  ConfigurationLayer,
  ConfigurationLayerData,
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import { revisionOf } from "./authority-envelope";
import { directAuthorityWrite } from "./layer-authority";
import { createMemoryAuthority } from "./memory-authority";

export interface InMemoryProviderOptions {
  id: string;
  layer: ConfigurationLayer | string;
  initialEntries?: Record<string, unknown> | undefined;
  environment?: string;
}

class InMemoryStorageProvider implements ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: ConfigurationLayer | string;
  readonly writable = true;
  readonly authority;
  readonly capabilities;
  constructor(options: InMemoryProviderOptions) {
    this.id = options.id;
    this.layer = options.layer;
    this.authority = createMemoryAuthority(
      options.environment ?? "default",
      this.layer,
      options.initialEntries ?? {},
    );
    this.capabilities = this.authority.capabilities;
  }
  load(): Promise<ConfigurationLayerData> {
    return this.loadLayer(this.layer);
  }
  async loadLayer(layer: string): Promise<ConfigurationLayerData> {
    const snapshot = await this.authority.readLayer(layer);
    return {
      entries: snapshot.entries,
      revision: JSON.stringify(revisionOf(snapshot)),
    };
  }
  write(key: string, value: unknown): Promise<WriteResult> {
    return this.writeLayer(this.layer, key, value);
  }
  writeLayer(layer: string, key: string, value: unknown): Promise<WriteResult> {
    return directAuthorityWrite(this.authority, layer, key, value);
  }
  remove(key: string): Promise<WriteResult> {
    return this.removeLayer(this.layer, key);
  }
  removeLayer(layer: string, key: string): Promise<WriteResult> {
    return directAuthorityWrite(this.authority, layer, key, undefined, true);
  }
}

export function createInMemoryStorageProvider(
  options: InMemoryProviderOptions,
): ConfigurationStorageProvider {
  return new InMemoryStorageProvider(options);
}
