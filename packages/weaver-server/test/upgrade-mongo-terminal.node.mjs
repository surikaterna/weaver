import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { MongoClient } from "mongodb";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import {
  databaseGuard,
  guardedDrop,
  mongoDefinition,
  requireLiveUris,
} from "./upgrade-mongo-fixture.mjs";

test("U9.3 standalone Mongo refuses durable authority without artifacts", async () => {
  const { standaloneUri } = requireLiveUris();
  const database = `weaver_u9_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  assert.match(database, databaseGuard);
  const client = await new MongoClient(standaloneUri, {
    serverSelectionTimeoutMS: 10_000,
  }).connect();
  const fixture = await createStandaloneFixture();
  let unexpectedlyCreated = false;
  try {
    const before = await inspectAbsentDatabase(client, database);
    const beforeFiles = await readdir(fixture.directory, { recursive: true });
    const request = structuredClone(fixture.request);
    request.generation.layout.layers.push({
      name: "secondary",
      type: "static",
      providerId: "secondary",
      config: { mergeId: "deep" },
    });
    request.generation.providers.push(mongoDefinition(database));
    const credentials = {
      resolveCredential(reference) {
        return reference === "mongo-u9"
          ? standaloneUri
          : fixture.credentials.resolveCredential(reference);
      },
    };
    await assert.rejects(
      initializeWeaver(fixture.seed, request, fixture.administrator, {
        credentials,
      }),
      { code: "UNSUPPORTED_AUTHORITY" },
    );
    const after = await inspectAbsentDatabase(client, database);
    const afterFiles = await readdir(fixture.directory, { recursive: true });
    assert.deepEqual(after, before);
    assert.deepEqual(afterFiles, beforeFiles);
    assert.equal(after.databaseListed, false);
    assert.deepEqual(after.collections, []);
    assert.equal(after.documents, 0);
    unexpectedlyCreated = after.databaseListed || after.collections.length > 0;
  } finally {
    if (unexpectedlyCreated) await guardedDrop(client, database);
    await client.close();
    await fixture.dispose();
  }
});

async function inspectAbsentDatabase(client, database) {
  assert.match(database, databaseGuard);
  const databases = await client.db("admin").admin().listDatabases({
    nameOnly: true,
  });
  const collections = await client
    .db(database)
    .listCollections({}, { nameOnly: true })
    .toArray();
  const documents = collections.some((item) => item.name === "secondary")
    ? await client.db(database).collection("secondary").countDocuments({})
    : 0;
  return {
    databaseListed: databases.databases.some((item) => item.name === database),
    collections: collections.map((item) => item.name).sort(),
    documents,
  };
}
