// GitStorageProvider — composes FileSystemStorageProvider for reads, GitManager for batched writes

import { join } from "node:path";
import { normalizeStorageWritePath } from "@weaver-conf/config-engine";
import type {
  ConfigurationLayerData,
  ConfigurationStorageProvider,
  ProviderAuthority,
  ProviderCapabilities,
  ProviderWriterHandle,
  WriteResult,
} from "@weaver-conf/config-types";
import {
  createWeaverError,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import type { FileAuthorityOptions } from "./fs-authority";
import {
  createFileSystemStorageProvider,
  type FileSystemStorageProvider,
} from "./fs-provider";
import type { GitManager } from "./git-manager";
import { directAuthorityWrite } from "./layer-authority";

export interface GitStorageProviderOptions {
  id: string;
  layer: string;
  gitManager: GitManager;
  filePath: string;
  writable?: boolean | undefined;
  /** Persistent local checkout authority; remote replication is not the commit boundary. */
  authority: FileAuthorityOptions;
  /** Optional backup replication. Local authority does not require Git commits or a remote. */
  replicate?: boolean;
}

/** @see {@link createGitStorageProvider} — prefer the factory function for consistency */
class GitStorageProvider implements ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: string;
  readonly writable: boolean;
  readonly authority: ProviderAuthority;
  readonly capabilities: ProviderCapabilities;

  private readonly fsp: FileSystemStorageProvider;
  private readonly gitManager: GitManager;
  private readonly filePath: string;
  private readonly dirtyKeys: string[] = [];
  private readonly dirtyPaths = new Map<string, number>();
  private isDirty = false;
  private readonly replicate: boolean;
  private readonly checkoutPins = new WeakMap<
    ProviderWriterHandle,
    () => void
  >();

  constructor(options: GitStorageProviderOptions) {
    assertGitOptions(options);
    this.id = options.id;
    this.layer = options.layer;
    this.writable = options.writable ?? true;
    this.replicate = options.replicate ?? true;
    this.gitManager = options.gitManager;
    if (
      options.authority &&
      (!this.gitManager.commitAndReplicate ||
        !this.gitManager.retainLocalAuthority)
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Git authority requires replication-only manager IO",
      );
    this.filePath = options.filePath;

    const absoluteFilePath = join(
      options.gitManager.localPath,
      options.filePath,
    );
    this.fsp = createFileSystemStorageProvider({
      id: `${options.id}-fsp`,
      layer: options.layer,
      filePath: absoluteFilePath,
      writable: this.writable,
      authority: options.authority,
    });
    this.authority = this.wrapAuthority(this.fsp.authority);
    this.capabilities = this.authority.capabilities;
  }
  private wrapAuthority(authority: ProviderAuthority): ProviderAuthority {
    return {
      capabilities: authority.capabilities,
      preflight: (layers) => authority.preflight(layers),
      acquireWriter: async (ownerId) => {
        const release = await this.gitManager.retainLocalAuthority?.();
        try {
          const handle = await authority.acquireWriter(ownerId);
          if (release) this.checkoutPins.set(handle, release);
          return handle;
        } catch (error) {
          // Uncertain acquisition keeps checkout mutation pinned, rather than enabling a pull.
          if (
            error instanceof WeaverErrorInstance &&
            error.code !== "COMMIT_OUTCOME_UNKNOWN"
          )
            release?.();
          throw error;
        }
      },
      releaseWriter: async (handle) => {
        const release = this.checkoutPins.get(handle);
        await authority.releaseWriter(handle);
        this.checkoutPins.delete(handle);
        release?.();
      },
      readLayer: (layer) => authority.readLayer(layer),
      inventory: () => authority.inventory(),
      commitLayer: async (request, handle) => {
        const result = await authority.commitLayer(request, handle);
        if (result.success || result.error.code === "COMMIT_OUTCOME_UNKNOWN")
          this.markChanged(
            request.layer,
            `${request.mutation.action} ${request.layer}:${request.mutation.key}`,
          );
        return result;
      },
    };
  }

  async load(): Promise<ConfigurationLayerData> {
    return this.fsp.load();
  }
  async loadLayer(layer: string): Promise<ConfigurationLayerData> {
    return this.fsp.loadLayer(layer);
  }

  private markChanged(layer: string, description: string): void {
    if (!this.replicate) return;
    const path =
      layer === this.layer
        ? this.filePath
        : `${this.filePath}.${encodeURIComponent(layer)}.json`;
    this.dirtyPaths.set(path, (this.dirtyPaths.get(path) ?? 0) + 1);
    this.dirtyKeys.push(description);
    this.isDirty = true;
  }

  get dirty(): boolean {
    return this.isDirty;
  }

  async write(key: string, value: unknown): Promise<WriteResult> {
    return this.writeLayer(this.layer, key, value);
  }

  async writeLayer(
    layer: string,
    key: string,
    value: unknown,
  ): Promise<WriteResult> {
    return this.mutate(layer, key, value, false);
  }

  async remove(key: string): Promise<WriteResult> {
    return this.removeLayer(this.layer, key);
  }

  async removeLayer(layer: string, key: string): Promise<WriteResult> {
    return this.mutate(layer, key, undefined, true);
  }
  private async mutate(
    layer: string,
    key: string,
    value: unknown,
    remove: boolean,
  ): Promise<WriteResult> {
    const parsed = normalizeStorageWritePath(key);
    if (!parsed.ok) return { success: false, error: parsed.error };
    if (!this.writable)
      return {
        success: false,
        error: { code: "READONLY", message: "Provider is read-only" },
      };
    return directAuthorityWrite(
      this.authority,
      layer,
      parsed.value,
      value,
      remove,
    );
  }

  async flush(): Promise<void> {
    if (!this.isDirty) return;
    const summary =
      this.dirtyKeys.length === 1
        ? `config: ${this.dirtyKeys[0]}`
        : `config: ${this.dirtyKeys.length} changes in ${this.layer}`;
    const paths = new Map(this.dirtyPaths);
    const count = this.dirtyKeys.length;
    const replicate = this.gitManager.commitAndReplicate;
    if (!replicate)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Replication-only manager is unavailable",
      );
    const result = await replicate.call(this.gitManager, summary, [
      ...paths.keys(),
    ]);
    if (!result.success) {
      throw createWeaverError(
        "GIT_ERROR",
        `Git replication failed: ${result.error}`,
      );
    }
    this.dirtyKeys.splice(0, count);
    for (const [path, version] of paths)
      if (this.dirtyPaths.get(path) === version) this.dirtyPaths.delete(path);
    this.isDirty = this.dirtyPaths.size > 0;
  }

  async revert(
    _toRevision: string,
    _actor: string,
  ): Promise<{ revertedCommits: number }> {
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Git revert/reset cannot replace durable authority; use a new epoch through controlled recovery",
    );
  }

  async refresh(): Promise<void> {
    // Local envelopes are authority; refresh must not adopt a remote checkout.
  }
}

function assertGitOptions(options: GitStorageProviderOptions): void {
  if (
    !options.authority ||
    Object.keys(options).some(
      (key) =>
        ![
          "id",
          "layer",
          "gitManager",
          "filePath",
          "writable",
          "authority",
          "replicate",
        ].includes(key),
    )
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Git provider requires current local authority options",
    );
}

/** Creates a Git-backed storage provider instance. */
export function createGitStorageProvider(
  options: GitStorageProviderOptions,
): ConfigurationStorageProvider & {
  dirty: boolean;
  flush(): Promise<void>;
  revert(
    toRevision: string,
    actor: string,
  ): Promise<{ revertedCommits: number }>;
  refresh(): Promise<void>;
} {
  return new GitStorageProvider(options);
}
