import { type FSWatcher, watch } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  deepEqual,
  deepMerge,
  deepRemove,
  deepSet,
  isNodeError,
  safeParseConfigEntries,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationChange,
  ConfigurationLayer,
  ConfigurationLayerData,
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import { createWeaverError } from "@weaver-conf/config-types";

/** Options for creating a file-system storage provider. */
export interface FileSystemProviderOptions {
  id: string;
  layer: ConfigurationLayer | string;
  filePath: string;
  writable?: boolean | undefined;
  environmentOverlayPath?: string | undefined;
  /** Debounce interval in ms for file-system watch events (default: 100). */
  watchDebounceMs?: number | undefined;
}

/**
 * Validates that a key does not escape the root directory via path traversal.
 * Rejects null bytes, control characters, and `..` segments.
 */
export function validateStorageKey(key: string): void {
  if ([...key].some((char) => char.charCodeAt(0) <= 0x1f)) {
    throw new Error("Invalid key: contains control characters");
  }
  if (key.includes("..")) {
    throw new Error(`Path traversal rejected: ${key}`);
  }
}

/** @see {@link createFileSystemStorageProvider} — prefer the factory function for consistency */
export class FileSystemStorageProvider implements ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: ConfigurationLayer | string;
  readonly writable: boolean;

  private readonly filePath: string;
  private readonly envOverlayPath: string | undefined;
  private readonly watchDebounceMs: number;
  private fsWatcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: Record<string, unknown> = {};
  private subscription: symbol | null = null;
  private changeListener: ((changes: ConfigurationChange[]) => void) | null =
    null;

  constructor(options: FileSystemProviderOptions) {
    this.id = options.id;
    this.layer = options.layer;
    this.writable = options.writable ?? false;
    this.filePath = resolve(options.filePath);
    this.envOverlayPath = options.environmentOverlayPath
      ? resolve(options.environmentOverlayPath)
      : undefined;
    this.watchDebounceMs = options.watchDebounceMs ?? 100;
  }

  async load(): Promise<ConfigurationLayerData> {
    return this.loadLayer(this.layer);
  }

  async loadLayer(layer: string): Promise<ConfigurationLayerData> {
    const path =
      layer === this.layer
        ? this.filePath
        : `${this.filePath}.${encodeURIComponent(layer)}.json`;
    let entries = await this.readJsonFile(path);
    const revision = await this.getRevision(path);

    if (this.envOverlayPath) {
      const overlay = await this.readJsonFile(this.envOverlayPath);
      entries = deepMerge(entries, overlay);
    }

    const result: ConfigurationLayerData = { entries };
    if (revision !== undefined) {
      result.revision = revision;
    }
    return result;
  }

  async write(key: string, value: unknown): Promise<WriteResult> {
    return this.writeLayer(this.layer, key, value);
  }

  async writeLayer(
    layer: string,
    key: string,
    value: unknown,
  ): Promise<WriteResult> {
    if (!this.writable) {
      return {
        success: false,
        error: { code: "READONLY", message: "Provider is read-only" },
      };
    }
    validateStorageKey(key);

    const path =
      layer === this.layer
        ? this.filePath
        : `${this.filePath}.${encodeURIComponent(layer)}.json`;

    const entries = await this.readJsonFile(path);
    deepSet(entries, key, value);
    await this.atomicWrite(path, entries);

    this.snapshot = JSON.parse(JSON.stringify(entries));

    const revision = await this.getRevision(path);
    return { success: true, revision };
  }

  async remove(key: string): Promise<WriteResult> {
    return this.removeLayer(this.layer, key);
  }

  async removeLayer(layer: string, key: string): Promise<WriteResult> {
    if (!this.writable) {
      return {
        success: false,
        error: { code: "READONLY", message: "Provider is read-only" },
      };
    }
    validateStorageKey(key);

    const path =
      layer === this.layer
        ? this.filePath
        : `${this.filePath}.${encodeURIComponent(layer)}.json`;

    const entries = await this.readJsonFile(path);
    deepRemove(entries, key);
    await this.atomicWrite(path, entries);

    this.snapshot = JSON.parse(JSON.stringify(entries));

    const revision = await this.getRevision(path);
    return { success: true, revision };
  }

  onExternalChange(
    listener: (changes: ConfigurationChange[]) => void,
  ): () => void {
    this.stopWatching();
    const subscription = Symbol();
    this.subscription = subscription;
    this.changeListener = listener;

    void this.readJsonFile(this.filePath)
      .then((entries) => {
        if (this.subscription !== subscription) return;
        this.snapshot = entries;
        this.startWatching(subscription);
      })
      .catch(() => {
        // Failed initialization owns no watcher; re-subscribe after repair.
      });

    return () => {
      if (this.subscription === subscription) this.stopWatching();
    };
  }

  dispose(): void {
    this.stopWatching();
  }

  private startWatching(subscription: symbol): void {
    if (this.subscription !== subscription) return;
    const dir = dirname(this.filePath);
    const filename = this.filePath.slice(dir.length + 1);

    this.fsWatcher = watch(dir, (_eventType, changedFile) => {
      if (changedFile !== filename) return;
      this.scheduleCheck(subscription);
    });
  }

  private stopWatching(): void {
    // Fence pending reads and callbacks before releasing this registration's handles.
    this.subscription = null;
    this.changeListener = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private scheduleCheck(subscription: symbol): void {
    if (this.subscription !== subscription) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (this.subscription !== subscription) return;
      this.debounceTimer = null;
      void this.checkForChanges(subscription).catch(() => {
        // Keep the last good snapshot; a later filesystem event can recover.
      });
    }, this.watchDebounceMs);
    this.debounceTimer.unref();
  }

  private async checkForChanges(subscription: symbol): Promise<void> {
    const listener = this.changeListener;
    if (this.subscription !== subscription || !listener) return;

    const current = await this.readJsonFile(this.filePath);
    if (this.subscription !== subscription) return;
    const changes = diffEntries(this.snapshot, current);

    if (changes.length > 0) {
      this.snapshot = current;
      listener(changes);
    }
  }

  private async readJsonFile(path: string): Promise<Record<string, unknown>> {
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Configuration file could not be read",
      );
    }
    try {
      return safeParseConfigEntries(JSON.parse(content));
    } catch {
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Configuration file contains invalid configuration data",
      );
    }
  }

  private async getRevision(path: string): Promise<string | undefined> {
    try {
      const stats = await stat(path);
      return stats.mtime.toISOString();
    } catch {
      return undefined;
    }
  }

  private async atomicWrite(
    path: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmpPath, path);
  }
}

/** Creates a file-system-backed storage provider instance. */
export function createFileSystemStorageProvider(
  options: FileSystemProviderOptions,
): FileSystemStorageProvider {
  return new FileSystemStorageProvider(options);
}

/** Shallow diff of top-level keys between two entry maps. */
function diffEntries(
  oldEntries: Record<string, unknown>,
  newEntries: Record<string, unknown>,
): ConfigurationChange[] {
  const changes: ConfigurationChange[] = [];
  const allKeys = new Set([
    ...Object.keys(oldEntries),
    ...Object.keys(newEntries),
  ]);

  for (const key of allKeys) {
    const oldVal = oldEntries[key];
    const newVal = newEntries[key];
    if (!deepEqual(oldVal, newVal)) {
      changes.push({ key, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}
