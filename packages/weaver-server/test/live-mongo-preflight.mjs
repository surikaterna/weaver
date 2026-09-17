import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";

const timeoutMs = 5_000;
export const liveMongoEnvironment = Object.freeze([
  "WEAVER_TEST_MONGO_URI",
  "WEAVER_TEST_MONGO_STANDALONE_URI",
]);

function requiredUri(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function readLiveMongoUris(environment = process.env) {
  const replicaSet = requiredUri(environment, liveMongoEnvironment[0]);
  const standalone = requiredUri(environment, liveMongoEnvironment[1]);
  return Object.freeze({ replicaSet, standalone });
}

export function mongoAuthorities(uri) {
  const client = new MongoClient(uri);
  return Object.freeze(client.options.hosts.map((host) => host.toString()).sort());
}

export function assertDistinctAuthorities(replicaSetUri, standaloneUri) {
  const replicaSet = new Set(mongoAuthorities(replicaSetUri));
  const overlap = mongoAuthorities(standaloneUri).filter((host) => replicaSet.has(host));
  if (overlap.length > 0) {
    throw new Error("Mongo replica-set and standalone URIs must use distinct host authorities");
  }
}

export function assertMongoTopology(kind, hello) {
  const setName = typeof hello?.setName === "string" && hello.setName.length > 0;
  if (kind === "replica-set" && !setName) {
    throw new Error("WEAVER_TEST_MONGO_URI must identify a Mongo replica set");
  }
  if (kind === "standalone" && (setName || hello?.msg === "isdbgrid")) {
    throw new Error("WEAVER_TEST_MONGO_STANDALONE_URI must identify a standalone Mongo server");
  }
}

async function checkMongo(name, uri, kind) {
  const client = new MongoClient(uri, {
    connectTimeoutMS: timeoutMs,
    serverSelectionTimeoutMS: timeoutMs,
    socketTimeoutMS: timeoutMs,
  });
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 }, { maxTimeMS: timeoutMs });
    assertMongoTopology(kind, hello);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} failed its bounded ${kind} hello check: ${detail}`);
  } finally {
    await client.close();
  }
}

export async function runLiveMongoPreflight(environment = process.env) {
  let uris;
  try {
    uris = readLiveMongoUris(environment);
    assertDistinctAuthorities(uris.replicaSet, uris.standalone);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Live Mongo prerequisites are invalid: ${detail}. Set both ${liveMongoEnvironment.join(" and ")} to separate test-only authorities.`);
  }
  await checkMongo(liveMongoEnvironment[0], uris.replicaSet, "replica-set");
  await checkMongo(liveMongoEnvironment[1], uris.standalone, "standalone");
  console.log("Live Mongo preflight passed: distinct replica-set and standalone authorities responded to hello.");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  runLiveMongoPreflight().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
