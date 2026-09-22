import {
  buildPath,
  cloneValue,
  consoleLogger,
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
import {
  isSameMongoPathOrDescendant,
  mongoPathCandidatePattern,
} from "./mongodb-path-identity.js";
import {
  findStoredConfigDocuments,
  mutateMongoRoot,
  type StoredConfigDocument,
  selectEffectiveDocuments,
} from "./mongodb-root-mutation.js";

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

const storedKeyDocumentSchema = z.object({ key: z.string() });

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
    let docs: StoredConfigDocument[];
    try {
      docs = await findStoredConfigDocuments(
        this.collection,
        layer,
        this.environment,
        this.timeoutMs,
      );
    } catch (err) {
      const message = extractErrorMessage(err);
      this.logger.error(
        `[weaver] MongoDB load failed for provider "${this.id}": ${message}`,
      );
      throw new Error(
        `MongoDB load failed for provider "${this.id}": ${message}`,
      );
    }

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
      const { rootKey, tail } = parseRootPath(key);
      await mutateMongoRoot({
        collection: this.collection,
        layer,
        environment: this.environment,
        rootKey,
        tail,
        mutation: { kind: "write", value },
        timeoutMs: this.timeoutMs,
      });
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
        const doc = (
          change as { fullDocument?: { key: string; value: unknown } }
        ).fullDocument; // SAFETY: MongoDB change stream with fullDocument option
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

  private async removeNestedPath(layer: string, key: string): Promise<void> {
    const { segments, rootKey, tail } = parseRootPath(key);

    if (tail.length === 0) {
      await this.deletePathAndDescendants(layer, rootKey);
      return;
    }

    const committed = await mutateMongoRoot({
      collection: this.collection,
      layer,
      environment: this.environment,
      rootKey,
      tail,
      mutation: { kind: "remove" },
      timeoutMs: this.timeoutMs,
    });
    if (!committed) {
      await this.deletePathAndDescendants(layer, buildPath(segments));
      return;
    }
    await this.deleteDescendantDocumentsBestEffort(layer, rootKey);
  }

  private async deleteDescendantDocumentsBestEffort(
    layer: string,
    key: string,
  ): Promise<void> {
    try {
      const storedKeys = await this.findStoredKeys(layer, key, false);
      await this.deleteStoredKeys(layer, storedKeys);
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
    const storedKeys = await this.findStoredKeys(layer, key, true);
    await this.deleteStoredKeys(layer, storedKeys);
  }

  private async findStoredKeys(
    layer: string,
    key: string,
    includeCanonicalPath: boolean,
  ): Promise<string[]> {
    const rawDocs = await this.collection
      .find(
        {
          layer,
          environment: this.environment,
          key: { $regex: mongoPathCandidatePattern(key) },
        },
        { projection: { _id: 0, key: 1 } },
      )
      .maxTimeMS(this.timeoutMs)
      .toArray();
    const targetSegments = parsePath(key);
    const docs = z.array(storedKeyDocumentSchema).parse(rawDocs);
    return docs
      .filter((doc) => {
        if (!isSameMongoPathOrDescendant(parsePath(doc.key), targetSegments)) {
          return false;
        }
        return includeCanonicalPath || doc.key !== key;
      })
      .map((doc) => doc.key);
  }

  private async deleteStoredKeys(
    layer: string,
    storedKeys: readonly string[],
  ): Promise<void> {
    if (storedKeys.length === 0) return;
    await this.collection.deleteMany(
      {
        layer,
        environment: this.environment,
        $or: storedKeys.map((storedKey) => ({ key: storedKey })),
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

function parseRootPath(key: string): {
  readonly segments: readonly string[];
  readonly rootKey: string;
  readonly tail: readonly string[];
} {
  const segments = parsePath(key);
  return {
    segments,
    rootKey: buildPath([getRootSegment(segments)]),
    tail: segments.slice(1),
  };
}

export function createMongoDBStorageProvider(
  options: MongoDBStorageProviderOptions,
): ConfigurationStorageProvider {
  return new MongoDBStorageProvider(options);
}
