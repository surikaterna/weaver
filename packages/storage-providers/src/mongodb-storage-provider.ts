// MongoDBStorageProvider — native MongoDB driver for user/device config layers

import {
  buildPath,
  cloneValue,
  consoleLogger,
  deepGet,
  deepRemove,
  deepSet,
  extractErrorMessage,
  parsePath,
  type WeaverLogger,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationChange,
  ConfigurationLayerData,
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import type { ChangeStream, Collection } from "mongodb";
import { z } from "zod";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export interface MongoDBStorageProviderOptions {
  id: string;
  layer: string;
  collection: Collection;
  environment: string;
  writable?: boolean | undefined;
  logger?: WeaverLogger;
  /** Timeout in milliseconds for MongoDB operations. Defaults to 30000 (30s). */
  timeoutMs?: number | undefined;
}

const configDocumentSchema = z.object({
  layer: z.string(),
  environment: z.string(),
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});

interface ConfigDocument {
  layer: string;
  environment: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

/** @see {@link createMongoDBStorageProvider} — prefer the factory function for consistency */
class MongoDBStorageProvider implements ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: string;
  readonly writable: boolean;

  private readonly collection: Collection;
  private readonly environment: string;
  private readonly logger: WeaverLogger;
  private readonly timeoutMs: number;

  constructor(options: MongoDBStorageProviderOptions) {
    this.id = options.id;
    this.layer = options.layer;
    this.writable = options.writable ?? true;
    this.collection = options.collection;
    this.environment = options.environment;
    this.logger = options.logger ?? consoleLogger;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async load(): Promise<ConfigurationLayerData> {
    return this.loadLayer(this.layer);
  }

  async loadLayer(layer: string): Promise<ConfigurationLayerData> {
    let rawDocs: Awaited<ReturnType<ReturnType<Collection["find"]>["toArray"]>>;
    try {
      rawDocs = await this.collection
        .find({ layer, environment: this.environment })
        .maxTimeMS(this.timeoutMs)
        .toArray();
    } catch (err) {
      const message = extractErrorMessage(err);
      this.logger.error(
        `[weaver] MongoDB load failed for provider "${this.id}": ${message}`,
      );
      throw new Error(
        `MongoDB load failed for provider "${this.id}": ${message}`,
      );
    }

    const docs = z.array(configDocumentSchema).parse(rawDocs);

    const entries: Record<string, unknown> = {};
    for (const doc of selectEffectiveDocuments(docs)) {
      deepSet(entries, doc.key, cloneValue(doc.value));
    }
    return { entries };
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

    try {
      const { key: rootKey, value: rootValue } = await this.toRootDocument(
        layer,
        key,
        value,
      );

      await this.upsertRootDocument(layer, rootKey, rootValue);
      await this.deleteDescendantDocumentsBestEffort(layer, rootKey);
    } catch (err) {
      const message = extractErrorMessage(err);
      return {
        success: false,
        error: {
          code: "WRITE_ERROR",
          message: `MongoDB write failed for key "${key}": ${message}`,
        },
      };
    }
    return { success: true };
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

    try {
      await this.removeNestedPath(layer, key);
    } catch (err) {
      const message = extractErrorMessage(err);
      return {
        success: false,
        error: {
          code: "WRITE_ERROR",
          message: `MongoDB remove failed for key "${key}": ${message}`,
        },
      };
    }
    return { success: true };
  }

  onExternalChange(
    listener: (changes: ConfigurationChange[]) => void,
  ): () => void {
    let backoffMs = BASE_BACKOFF_MS;
    let currentStream: ChangeStream | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const setupChangeStream = (): void => {
      if (disposed) return;

      const stream = this.collection.watch([
        { $match: { "fullDocument.layer": this.layer } },
      ]);
      currentStream = stream;

      stream.on("change", (change: unknown) => {
        backoffMs = BASE_BACKOFF_MS;
        const doc = (change as { fullDocument?: ConfigDocument }).fullDocument; // SAFETY: MongoDB change stream with fullDocument option
        if (doc) {
          listener([
            { key: doc.key, oldValue: undefined, newValue: doc.value },
          ]);
        }
      });

      stream.on("error", (err: unknown) => {
        const message = extractErrorMessage(err);
        this.logger.error(
          `[weaver] MongoDB changeStream error for provider "${this.id}": ${message}`,
        );
        void stream.close();
        if (disposed) return;

        const delay = Math.min(backoffMs, MAX_BACKOFF_MS);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        reconnectTimer = setTimeout(setupChangeStream, delay);
      });
    };

    setupChangeStream();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (currentStream) {
        void currentStream.close();
      }
    };
  }

  private async toRootDocument(
    layer: string,
    key: string,
    value: unknown,
  ): Promise<{ key: string; value: unknown }> {
    const segments = parsePath(key);
    const root = getRootSegment(segments);
    const rootKey = buildPath([root]);
    const tail = segments.slice(1);

    if (tail.length === 0) {
      return { key: rootKey, value };
    }

    const entries = (await this.loadLayer(layer)).entries;
    const existingRoot = deepGet(entries, rootKey);
    const rootValue = isRecord(existingRoot) ? existingRoot : {};
    deepSet(rootValue, buildPath(tail), value);

    return { key: rootKey, value: rootValue };
  }

  private async removeNestedPath(layer: string, key: string): Promise<void> {
    const segments = parsePath(key);
    const root = getRootSegment(segments);
    const rootKey = buildPath([root]);
    const tail = segments.slice(1);

    if (tail.length === 0) {
      await this.deletePathAndDescendants(layer, rootKey);
      return;
    }

    const entries = (await this.loadLayer(layer)).entries;
    const existingRoot = deepGet(entries, rootKey);
    if (!isRecord(existingRoot)) {
      await this.deletePathAndDescendants(layer, buildPath(segments));
      return;
    }

    deepRemove(existingRoot, buildPath(tail));
    await this.upsertRootDocument(layer, rootKey, existingRoot);
    await this.deleteDescendantDocumentsBestEffort(layer, rootKey);
  }

  private async upsertRootDocument(
    layer: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.collection.updateOne(
      { layer, environment: this.environment, key },
      { $set: { value, updatedAt: new Date().toISOString() } },
      { upsert: true, maxTimeMS: this.timeoutMs },
    );
  }

  private async deleteDescendantDocumentsBestEffort(
    layer: string,
    key: string,
  ): Promise<void> {
    try {
      await this.collection.deleteMany(
        {
          layer,
          environment: this.environment,
          key: { $regex: descendantKeyPattern(key) },
        },
        { maxTimeMS: this.timeoutMs },
      );
    } catch (err) {
      const message = extractErrorMessage(err);
      try {
        this.logger.warn(
          `[weaver] MongoDB descendant cleanup failed for root "${key}"; the authoritative root document remains valid: ${message}`,
        );
      } catch {
        return;
      }
    }
  }

  private async deletePathAndDescendants(
    layer: string,
    key: string,
  ): Promise<void> {
    await this.collection.deleteMany(
      {
        layer,
        environment: this.environment,
        $or: [{ key }, { key: { $regex: descendantKeyPattern(key) } }],
      },
      { maxTimeMS: this.timeoutMs },
    );
  }
}

function getRootSegment(segments: readonly string[]): string {
  const root = segments[0];
  if (root === undefined) {
    throw new Error("Path must not be empty");
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortConfigDocuments(
  docs: readonly ConfigDocument[],
): ConfigDocument[] {
  return [...docs].sort((left, right) => {
    const dateOrder = left.updatedAt.localeCompare(right.updatedAt);
    if (dateOrder !== 0) return dateOrder;
    return parsePath(left.key).length - parsePath(right.key).length;
  });
}

function selectEffectiveDocuments(
  docs: readonly ConfigDocument[],
): ConfigDocument[] {
  const rootKeys = new Set(
    docs.filter((doc) => parsePath(doc.key).length === 1).map((doc) => doc.key),
  );
  const effectiveDocs = docs.filter((doc) => {
    const segments = parsePath(doc.key);
    if (segments.length === 1) return true;
    const rootKey = buildPath([getRootSegment(segments)]);
    return !rootKeys.has(rootKey);
  });
  return sortConfigDocuments(effectiveDocs);
}

function descendantKeyPattern(key: string): string {
  return `^${escapeRegex(key)}\\.`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Creates a MongoDB-backed storage provider instance. */
export function createMongoDBStorageProvider(
  options: MongoDBStorageProviderOptions,
): ConfigurationStorageProvider {
  return new MongoDBStorageProvider(options);
}
