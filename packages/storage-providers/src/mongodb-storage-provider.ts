import { normalizeStorageWritePath } from "@weaver-conf/config-engine";
import {
  type ConfigurationLayerData,
  type ConfigurationStorageProvider,
  createWeaverError,
  type WriteResult,
} from "@weaver-conf/config-types";
import type { Collection } from "mongodb";
import { revisionOf } from "./authority-envelope";
import { directAuthorityWrite } from "./layer-authority";
import {
  createMongoAuthority,
  type MongoAuthorityOptions,
} from "./mongodb-authority";

export interface MongoDBStorageProviderOptions {
  readonly id: string;
  readonly layer: string;
  readonly collection: Collection;
  readonly environment: string;
  readonly writable?: boolean;
  readonly authority: MongoAuthorityOptions;
}
/** Only the versioned layer envelope has authority. Old root-key documents are refused, not parsed. */
class MongoDBStorageProvider implements ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: string;
  readonly writable: boolean;
  readonly authority;
  readonly capabilities;
  constructor(options: MongoDBStorageProviderOptions) {
    if (
      !options.authority ||
      Object.keys(options).some(
        (key) =>
          ![
            "id",
            "layer",
            "collection",
            "environment",
            "writable",
            "authority",
          ].includes(key),
      )
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Mongo provider requires current envelope authority; root-key storage options are unsupported",
      );
    this.id = options.id;
    this.layer = options.layer;
    this.writable = options.writable ?? true;
    this.authority = createMongoAuthority(
      options.collection,
      options.environment,
      options.layer,
      options.authority,
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
    return this.mutate(layer, key, value, false);
  }
  remove(key: string): Promise<WriteResult> {
    return this.removeLayer(this.layer, key);
  }
  removeLayer(layer: string, key: string): Promise<WriteResult> {
    return this.mutate(layer, key, undefined, true);
  }
  private async mutate(
    layer: string,
    key: string,
    value: unknown,
    remove: boolean,
  ): Promise<WriteResult> {
    const path = normalizeStorageWritePath(key);
    if (!path.ok) return { success: false, error: path.error };
    if (!this.writable)
      return {
        success: false,
        error: { code: "READONLY", message: "Provider is read-only" },
      };
    return directAuthorityWrite(
      this.authority,
      layer,
      path.value,
      value,
      remove,
    );
  }
  onExternalChange(): () => void {
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Current Mongo authority requires explicit validated reloads, not unfenced change streams",
    );
  }
}
export function createMongoDBStorageProvider(
  options: MongoDBStorageProviderOptions,
): ConfigurationStorageProvider {
  return new MongoDBStorageProvider(options);
}
