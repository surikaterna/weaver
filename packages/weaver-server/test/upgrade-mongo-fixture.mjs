import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BSON, Collection, MongoClient } from "mongodb";
import { canonicalInternalJson } from "@weaver-conf/config-types";
import {
  createTwoProviderFixture,
  installTwoProviderPlan,
} from "./upgrade-two-provider-fixture.mjs";

export const primaryUri = "mongodb://127.0.0.1:27038/?directConnection=true";
export const standaloneUri = "mongodb://127.0.0.1:27039/?directConnection=true";
export const databaseGuard = /^weaver_u9_[1-9][0-9]*_[0-9a-f]{32}$/;

export function requireLiveUris() {
  assert.equal(process.env.WEAVER_TEST_MONGO_URI, primaryUri);
  assert.equal(process.env.WEAVER_TEST_MONGO_STANDALONE_URI, standaloneUri);
}

export async function createMongoUpgradeFixture(uri = primaryUri) {
  requireLiveUris();
  const database = `weaver_u9_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  assert.match(database, databaseGuard);
  const client = await new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 10_000,
  }).connect();
  let base;
  try {
    base = await createTwoProviderFixture({
      resolveCredential: (reference, fallback) =>
        reference === "mongo-u9"
          ? uri
          : fallback.resolveCredential(reference),
      secondaryProvider: mongoDefinition(database),
    });
    return mongoFixture(base, client, database);
  } catch (error) {
    await guardedDrop(client, database);
    await client.close();
    await base?.dispose();
    throw error;
  }
}

function mongoDefinition(database) {
  return {
    id: "secondary",
    factory: "mongodb",
    options: { database, collection: "secondary" },
    credentials: { connection: "mongo-u9" },
  };
}

function mongoFixture(base, client, database) {
  let disposed = false;
  const collection = client.db(database).collection("secondary");
  return {
    ...base,
    database,
    client,
    collection,
    async prepare(runtime) {
      return installTwoProviderPlan(runtime, base);
    },
    snapshot: () => rawSnapshot(base, collection),
    readControl: () => readFsEnvelope(base, "control"),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await guardedDrop(client, database);
      await client.close();
      await base.dispose();
    },
  };
}

export async function rawSnapshot(fixture, collection) {
  const [controlBytes, platformBytes, mongo] = await Promise.all([
    rawFsBytes(fixture, "control"),
    rawFsBytes(fixture, "platform"),
    collection.findOne(
      { environment: "dev", layer: "secondary" },
      { readConcern: { level: "majority" } },
    ),
  ]);
  assert.ok(mongo);
  return {
    controlBytes,
    platformBytes,
    control: JSON.parse(controlBytes),
    platform: JSON.parse(platformBytes),
    mongo: structuredClone(mongo),
    mongoBytes: BSON.serialize(mongo),
    mongoCanonical: canonicalInternalJson(withoutId(mongo)),
  };
}

export function journal(snapshot, runId) {
  return snapshot.control.entries._weaver.upgrades.journal[runId];
}

export function observeMongoDataWrites(fixture, runId, intercept) {
  const original = Collection.prototype.updateOne;
  const operationIds = [];
  const attemptedOperationIds = [];
  let armed = true;
  Collection.prototype.updateOne = async function (...args) {
    const [filter, update] = args;
    const operationId = update?.$set?.lastCommit?.operationId;
    const exactTarget =
      this.dbName === fixture.database &&
      this.collectionName === "secondary" &&
      filter?.environment === "dev" &&
      filter?.layer === "secondary";
    if (!exactTarget || typeof operationId !== "string")
      return original.apply(this, args);
    const control = await fixture.readControl();
    const intended = control.entries._weaver.upgrades.journal[runId]?.steps.find(
      (step) => step.target.providerId === "secondary" && step.status === "intent",
    );
    if (intended?.operationId !== operationId)
      return original.apply(this, args);
    attemptedOperationIds.push(operationId);
    if (!armed || !intercept) {
      const result = await original.apply(this, args);
      if (result.acknowledged && result.matchedCount === 1)
        operationIds.push(operationId);
      return result;
    }
    armed = false;
    return intercept({
      collection: this,
      args,
      original,
      intended,
      markCommitted: () => operationIds.push(operationId),
    });
  };
  return {
    operationIds,
    attemptedOperationIds,
    restore() {
      Collection.prototype.updateOne = original;
    },
  };
}

export function publicRejection(operation) {
  return operation.then(
    () => assert.fail("Expected public rejection"),
    (error) => error,
  );
}

export function assertPublicSecretSafe(error, fixture, secrets = []) {
  const serialized = JSON.stringify(error);
  for (const value of [
    primaryUri,
    standaloneUri,
    fixture.database,
    "secondary",
    ...secrets,
  ])
    assert.equal(serialized.includes(value), false);
}

export function revision(envelope) {
  return {
    storeId: envelope.storeId,
    environment: envelope.environment,
    layer: envelope.layer,
    epoch: envelope.epoch,
    sequence: envelope.sequence,
  };
}

export function withoutId(document) {
  const { _id: _id, ...value } = document;
  return value;
}

export async function guardedDrop(client, database) {
  assert.match(database, databaseGuard);
  await client.db(database).dropDatabase();
}

async function rawFsBytes(fixture, provider) {
  return readFile(`${fixture.directory}/${provider}/entries.json`, "utf8");
}

async function readFsEnvelope(fixture, provider) {
  return JSON.parse(await rawFsBytes(fixture, provider));
}

export { mongoDefinition };
