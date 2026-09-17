import {
  createWeaverError,
  type LayerEnvelope,
  type MongoLayerEnvelope,
  mongoLayerEnvelopeSchema,
  type ProviderCapabilities,
  type ProviderPreflight,
  type StorageAuthorityOptions,
  storageAuthorityOptionsSchema,
} from "@weaver-conf/config-types";
import type { Collection, MongoClient, WriteConcernSettings } from "mongodb";
import {
  assertPersistedKeys,
  freshEnvelope,
  parseEnvelope,
} from "./authority-envelope";
import { type AuthorityBackend, LayerAuthority } from "./layer-authority";
import { MongoOwnership } from "./mongodb-ownership";

export interface MongoAuthorityOptions extends StorageAuthorityOptions {
  /** Executable client used to open the authoritative collection and verify topology. */
  readonly client: MongoClient;
}

/** Single-document fenced CAS. Only replica-set majority+j topology is supported. */
class MongoAuthorityBackend implements AuthorityBackend {
  readonly capabilities: ProviderCapabilities;
  private readonly ownership: MongoOwnership;
  private readonly knownLayers: readonly string[];
  private readonly storeId: string;
  private readonly writeConcern: WriteConcernSettings = {
    w: "majority",
    j: true,
    wtimeoutMS: 30_000,
  };
  constructor(
    private readonly collection: Collection,
    private readonly environment: string,
    layer: string,
    private readonly options: MongoAuthorityOptions,
  ) {
    const hosts = options.client.options.hosts
      .map((host) => host.toString())
      .sort()
      .join(",");
    this.storeId = `mongo:${hosts}/${collection.namespace}`;
    this.ownership = new MongoOwnership(
      collection,
      environment,
      `${this.storeId}/${environment}`,
      this.writeConcern,
    );
    this.knownLayers = [...new Set([layer, ...(options.layers ?? [])])].sort();
    this.capabilities = {
      kind: "durable-exclusive",
      durability: "mongo-journal",
      namespace: `${this.storeId}/${environment}`,
      maxEnvelopeBytes: 16_000_000,
      scopedIO: "complete",
    };
  }
  private filter(layer: string) {
    if (!this.knownLayers.includes(layer))
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        `Uncatalogued Mongo layer: ${layer}`,
      );
    return { environment: this.environment, layer };
  }
  private parse(value: unknown): MongoLayerEnvelope {
    assertPersistedKeys(value);
    const parsed = mongoLayerEnvelopeSchema.safeParse(value);
    if (!parsed.success)
      throw createWeaverError(
        "PROVIDER_CORRUPT",
        "Invalid or unsupported Mongo authority document",
        { issues: parsed.error.issues },
      );
    const { owner: _owner, fence: _fence, ...envelope } = parsed.data;
    parseEnvelope(envelope);
    if (
      envelope.storeId !== this.storeId ||
      envelope.environment !== this.environment ||
      !this.knownLayers.includes(envelope.layer)
    )
      throw createWeaverError(
        "PROVIDER_CORRUPT",
        "Mongo envelope identity mismatch",
      );
    return parsed.data;
  }
  private async documents(): Promise<MongoLayerEnvelope[]> {
    const docs = await this.collection
      .find(
        { environment: this.environment },
        { projection: { _id: 0 }, readConcern: { level: "majority" } },
      )
      .maxTimeMS(30_000)
      .toArray();
    return docs.map((doc) => this.parse(doc));
  }
  async acquire(): Promise<void> {
    await this.preflight();
    let docs = await this.documents();
    if (!docs.length && this.options.initialize) docs = await this.initialize();
    try {
      for (const doc of docs) await this.ownership.acquire(doc);
    } catch (error) {
      await this.ownership.abort(error);
    }
  }
  async preflight(layers?: readonly string[]): Promise<ProviderPreflight> {
    if (
      layers &&
      (layers.length !== this.knownLayers.length ||
        layers.some((layer) => !this.knownLayers.includes(layer)))
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Mongo declared layers differ from catalog",
      );
    const hello = await this.options.client.db("admin").command({ hello: 1 });
    if (typeof hello.setName !== "string")
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Mongo durable authority requires a replica set",
      );
    const docs = await this.documents();
    if (!docs.length && this.options.initialize)
      return {
        namespace: `${this.storeId}/${this.environment}`,
        layers: [...this.knownLayers],
        initialization: "fresh",
      };
    if (
      docs.length !== this.knownLayers.length ||
      new Set(docs.map((doc) => doc.layer)).size !== docs.length
    )
      throw createWeaverError(
        "PROVIDER_CORRUPT",
        "Incomplete Mongo authority inventory",
      );
    await this.assertUniqueIndex();
    if (docs.some((doc) => doc.owner !== null))
      throw createWeaverError(
        "WRITER_CONFLICT",
        "Mongo namespace already owned",
      );
    return {
      namespace: `${this.storeId}/${this.environment}`,
      layers: [...this.knownLayers],
      initialization: "existing",
    };
  }
  private async assertUniqueIndex(): Promise<void> {
    const indexes = await this.collection.listIndexes().toArray();
    const compatible = indexes.some(
      (index) =>
        index.unique === true &&
        !index.sparse &&
        !index.partialFilterExpression &&
        (!index.collation || index.collation.locale === "simple") &&
        Object.keys(index.key).length === 2 &&
        (index.key.environment === 1 || index.key.environment === -1) &&
        (index.key.layer === 1 || index.key.layer === -1),
    );
    if (!compatible)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Mongo envelope adoption requires a complete unique environment/layer index",
      );
  }
  private async initialize(): Promise<MongoLayerEnvelope[]> {
    await this.collection.createIndex(
      { environment: 1, layer: 1 },
      { unique: true },
    );
    const docs = this.knownLayers.map((layer) => ({
      ...freshEnvelope(this.storeId, this.environment, layer),
      owner: null,
      fence: "0",
    }));
    try {
      await this.collection.insertMany(docs, {
        ordered: true,
        writeConcern: this.writeConcern,
      });
    } catch (error) {
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Mongo initialization was not acknowledged; inspect documents before recovery",
        { cause: String(error) },
      );
    }
    return docs;
  }
  async release(): Promise<void> {
    await this.ownership.release();
  }
  get requiresReconciliation(): boolean {
    return this.ownership.requiresReconciliation;
  }
  inspectOwnership() {
    return this.ownership.inspect();
  }
  releaseQuarantinedWriter() {
    return this.ownership.release();
  }
  async layers(): Promise<string[]> {
    const docs = await this.documents();
    if (docs.length !== this.knownLayers.length)
      throw createWeaverError("PROVIDER_CORRUPT", "Mongo inventory changed");
    return docs.map((doc) => doc.layer);
  }
  async read(layer: string): Promise<LayerEnvelope> {
    const raw = await this.collection.findOne(this.filter(layer), {
      projection: { _id: 0 },
      readConcern: { level: "majority" },
      maxTimeMS: 30_000,
    });
    const { owner: _owner, fence: _fence, ...envelope } = this.parse(raw);
    return envelope;
  }
  async persist(envelope: LayerEnvelope): Promise<void> {
    const fence = this.ownership.fence(envelope.layer);
    const previous = envelope.lastCommit?.previousRevision;
    if (fence === undefined || !previous)
      throw createWeaverError("WRITER_CONFLICT", "No live Mongo writer fence");
    await this.assertSize(envelope, fence);
    const filter = {
      ...this.filter(envelope.layer),
      storeId: this.storeId,
      epoch: previous.epoch,
      sequence: previous.sequence,
      owner: this.ownership.owner,
      fence,
    };
    try {
      const result = await this.collection.updateOne(
        filter,
        { $set: envelope },
        { writeConcern: this.writeConcern },
      );
      if (!result.acknowledged)
        throw createWeaverError(
          "COMMIT_OUTCOME_UNKNOWN",
          "Mongo did not durably acknowledge commit",
        );
      if (result.matchedCount !== 1)
        throw createWeaverError(
          "REVISION_CONFLICT",
          "Mongo revision or writer fence changed",
        );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "REVISION_CONFLICT"
      )
        throw error;
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Mongo commit outcome is uncertain; reconcile the receipt",
        { cause: String(error) },
      );
    }
  }
  private async assertSize(
    envelope: LayerEnvelope,
    fence: string,
  ): Promise<void> {
    const { BSON } = await import("mongodb");
    if (
      BSON.calculateObjectSize({
        ...envelope,
        owner: this.ownership.owner,
        fence,
      }) > 16_000_000
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Mongo envelope exceeds supported BSON size",
      );
  }
}

export function createMongoAuthority(
  collection: Collection,
  environment: string,
  layer: string,
  options: MongoAuthorityOptions,
): LayerAuthority {
  const { client, ...serializedOptions } = options;
  const validated = storageAuthorityOptionsSchema.parse(serializedOptions);
  return new LayerAuthority(
    new MongoAuthorityBackend(
      options.client
        .db(collection.dbName)
        .collection(collection.collectionName, { readPreference: "primary" }),
      environment,
      layer,
      { ...validated, client },
    ),
  );
}
