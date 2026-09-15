import { normalizeStorageWritePath } from "@weaver-conf/config-engine";
import {
  type ConfigurationLayerData,
  type ConfigurationStorageProvider,
  createWeaverError,
  type FileAuthorityOptions,
  type WriteResult,
} from "@weaver-conf/config-types";
import { revisionOf } from "./authority-envelope";
import { createFileAuthority } from "./fs-authority";
import { directAuthorityWrite } from "./layer-authority";

export interface FileSystemProviderOptions {
  readonly id: string;
  readonly layer: string;
  readonly filePath: string;
  readonly writable?: boolean;
  readonly authority: FileAuthorityOptions;
}
/** Current envelope format only. Plain JSON and invisible overlays are never adopted. */
export class FileSystemStorageProvider implements ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: string;
  readonly writable: boolean;
  readonly authority;
  readonly capabilities;
  constructor(options: FileSystemProviderOptions) {
    if (
      !options.authority ||
      Object.keys(options).some(
        (key) =>
          !["id", "layer", "filePath", "writable", "authority"].includes(key),
      )
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Filesystem provider requires current-format authority options; overlays/plain JSON readers are unsupported",
      );
    this.id = options.id;
    this.layer = options.layer;
    this.writable = options.writable ?? false;
    this.authority = createFileAuthority(
      options.filePath,
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
    if ([...path.value].some((character) => character.charCodeAt(0) <= 31))
      return {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Control characters are forbidden in storage paths",
        },
      };
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
      "Exclusive authority does not accept external writers/watchers",
    );
  }
}
export function createFileSystemStorageProvider(
  options: FileSystemProviderOptions,
): FileSystemStorageProvider {
  return new FileSystemStorageProvider(options);
}
