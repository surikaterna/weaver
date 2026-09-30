import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sourceModule } from "./fixtures/load-source.mjs";
import { createRegistryAdapter, createEmptyState, SchemaIdentityPages } from "../dist/internal/server-adapter.js";
import { service } from "./fixtures/requests.mjs";

const codec = await sourceModule(fileURLToPath(new URL("../src/identity-cursor.ts", import.meta.url)));
function former(instance, revision, limit, offset) {
  const bytes = Buffer.alloc(41);
  bytes[0] = 1;
  Buffer.from(instance).copy(bytes, 1);
  bytes.writeBigUInt64BE(BigInt(revision), 17);
  bytes.writeBigUInt64BE(BigInt(limit), 25);
  bytes.writeBigUInt64BE(BigInt(offset), 33);
  return bytes.toString("base64url");
}

test("portable cursors match former Buffer vectors and reject malformed/unsafe/noncanonical encodings", () => {
  const instance = Uint8Array.from({ length: 16 }, (_, index) => index * 17);
  for (const [revision, limit, offset] of [[0, 1, 0], [1, 50, 2], [Number.MAX_SAFE_INTEGER, 200, Number.MAX_SAFE_INTEGER]]) {
    const cursor = codec.encodeCursor(instance, revision, limit, offset);
    assert.equal(cursor, former(instance, revision, limit, offset));
    assert.equal(cursor.length, 55);
    assert.deepEqual(codec.decodeCursor(cursor), { instance, revision, limit, offset });
  }
  const valid = former(instance, 1, 1, 1);
  const badVersion = Buffer.from(valid, "base64url");
  badVersion[0] = 2;
  const unsafe = Buffer.from(valid, "base64url");
  unsafe.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 17);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical = valid.slice(0, -1) + alphabet[alphabet.indexOf(valid.at(-1)) | 1];
  for (const cursor of ["", valid + "=", valid.slice(1), "!".repeat(55), noncanonical, badVersion.toString("base64url"), unsafe.toString("base64url")]) {
    assert.throws(() => codec.decodeCursor(cursor), { code: "VALIDATION_ERROR" });
  }
  assert.throws(() => codec.encodeCursor(instance, -1, 1, 1), { code: "VALIDATION_ERROR" });
});

test("page cursors preserve ordering, limits, offsets, instance and revision checks", () => {
  const entropy = () => new Uint8Array(16).fill(9);
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev", schemaIdentityMaxPageSize: 2 }, undefined, entropy);
  for (const environment of ["z", "a"]) adapter.prepare(service(environment)).publish();
  const first = adapter.reader.listRegisteredSchemaIdentityPage({ limit: 1 });
  assert.equal(first.anchors[0].environment, "a");
  assert.equal(adapter.reader.listRegisteredSchemaIdentityPage({ cursor: first.nextCursor }).slots[0].environment, "a");
  for (const input of [{ limit: 3 }, { limit: 0 }, { limit: 1.5 }, { cursor: first.nextCursor, limit: 2 }, { unexpected: true }]) {
    assert.throws(() => adapter.reader.listRegisteredSchemaIdentityPage(input), { code: "VALIDATION_ERROR" });
  }
  for (const offset of [0, 4, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor: former(entropy(), 2, 1, offset) }), { code: "VALIDATION_ERROR" });
  }
  assert.throws(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor: former(new Uint8Array(16), 2, 1, 1) }), { code: "REVISION_CONFLICT" });
  adapter.prepare(service("b")).publish();
  assert.throws(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor: first.nextCursor }), { code: "REVISION_CONFLICT" });
});

test("revision exhaustion fails before publication and preserves the page index", () => {
  const pages = new SchemaIdentityPages(createEmptyState(), 200, () => new Uint8Array(16));
  pages.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => pages.assertCanPublish(), { code: "INTERNAL_ERROR" });
  assert.throws(() => pages.publish([{ kind: "service", path: "/unexpected", environment: "dev" }]), { code: "INTERNAL_ERROR" });
  assert.deepEqual(pages.page(), { anchors: [], slots: [], nextCursor: null, hasMore: false });
});
