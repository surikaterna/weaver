import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createFileSystemOverrideTracker,
  createInMemoryOverrideTracker,
} from "../dist/index.js";

function makeTempPath() {
  return join(
    tmpdir(),
    `override-tracker-test-${randomUUID()}`,
    "overrides.json",
  );
}

function makeRecord(overrides = {}) {
  return {
    id: "override-1",
    key: "example.app.maxConnections",
    actor: "ops-admin",
    reason: "Production incident #1234",
    layer: "tenant",
    createdAt: "2026-04-13T12:00:00.000Z",
    ...overrides,
  };
}

test("create() adds record with followUpDeadline = createdAt + 24h", async () => {
  const filePath = makeTempPath();
  const tracker = createFileSystemOverrideTracker(filePath);

  try {
    const record = await tracker.create(makeRecord());
    expect(record.id).toBe("override-1");
    expect(record.followUpDeadline).toBe("2026-04-14T12:00:00.000Z");
    expect(record.regularizedAt).toBe(undefined);
  } finally {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("create() respects configurable followUpDeadlineMs", async () => {
  const oneHourMs = 60 * 60 * 1000;
  const tracker = createInMemoryOverrideTracker({ followUpDeadlineMs: oneHourMs });

  const record = await tracker.create(makeRecord());
  expect(record.followUpDeadline).toBe("2026-04-13T13:00:00.000Z");
});

test("listActive() returns only non-regularized records", async () => {
  const filePath = makeTempPath();
  const tracker = createFileSystemOverrideTracker(filePath);

  try {
    await tracker.create(makeRecord({ id: "o-1" }));
    await tracker.create(makeRecord({ id: "o-2" }));
    await tracker.regularize("o-1", "senior-ops");

    const active = await tracker.listActive();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("o-2");
  } finally {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("regularize() sets regularizedAt and regularizedBy", async () => {
  const filePath = makeTempPath();
  const tracker = createFileSystemOverrideTracker(filePath);

  try {
    await tracker.create(makeRecord());
    const result = await tracker.regularize("override-1", "senior-ops");

    expect(result !== undefined).toBeTruthy();
    expect(result.regularizedBy).toBe("senior-ops");
    expect(result.regularizedAt !== undefined).toBeTruthy();
    // Verify it's a valid ISO date
    expect(!isNaN(new Date(result.regularizedAt).getTime())).toBeTruthy();
  } finally {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("listOverdue() returns records past deadline", async () => {
  const filePath = makeTempPath();
  const tracker = createFileSystemOverrideTracker(filePath);

  try {
    // createdAt is 48h ago, so deadline is 24h ago
    await tracker.create(
      makeRecord({
        id: "o-old",
        createdAt: "2026-04-11T12:00:00.000Z",
      }),
    );
    // createdAt is just now, so deadline is 24h from now
    await tracker.create(
      makeRecord({
        id: "o-new",
        createdAt: "2026-04-13T12:00:00.000Z",
      }),
    );

    const overdue = await tracker.listOverdue("2026-04-13T12:00:00.000Z");
    expect(overdue.length).toBe(1);
    expect(overdue[0].id).toBe("o-old");
  } finally {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("listOverdue() excludes already-regularized records", async () => {
  const filePath = makeTempPath();
  const tracker = createFileSystemOverrideTracker(filePath);

  try {
    await tracker.create(
      makeRecord({
        id: "o-old",
        createdAt: "2026-04-11T12:00:00.000Z",
      }),
    );
    await tracker.regularize("o-old", "senior-ops");

    const overdue = await tracker.listOverdue("2026-04-13T12:00:00.000Z");
    expect(overdue.length).toBe(0);
  } finally {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("handle empty/missing file gracefully", async () => {
  const filePath = makeTempPath();
  const tracker = createFileSystemOverrideTracker(filePath);

  const active = await tracker.listActive();
  expect(active).toEqual([]);

  const overdue = await tracker.listOverdue();
  expect(overdue).toEqual([]);

  const result = await tracker.regularize("nonexistent", "someone");
  expect(result).toBe(undefined);
});

test("InMemoryOverrideTracker works identically", async () => {
  const tracker = createInMemoryOverrideTracker();

  // create with followUpDeadline
  const record = await tracker.create(makeRecord());
  expect(record.followUpDeadline).toBe("2026-04-14T12:00:00.000Z");

  // listActive
  let active = await tracker.listActive();
  expect(active.length).toBe(1);

  // regularize
  const regularized = await tracker.regularize("override-1", "senior-ops");
  expect(regularized !== undefined).toBeTruthy();
  expect(regularized.regularizedBy).toBe("senior-ops");

  // listActive after regularize
  active = await tracker.listActive();
  expect(active.length).toBe(0);

  // regularize nonexistent
  const missing = await tracker.regularize("nonexistent", "someone");
  expect(missing).toBe(undefined);

  // listOverdue with an overdue record
  await tracker.create(
    makeRecord({
      id: "o-overdue",
      createdAt: "2026-04-11T12:00:00.000Z",
    }),
  );
  const overdue = await tracker.listOverdue("2026-04-13T12:00:00.000Z");
  expect(overdue.length).toBe(1);
  expect(overdue[0].id).toBe("o-overdue");
});

test("fs-override-tracker respects configurable followUpDeadlineMs", async () => {
  const filePath = makeTempPath();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const tracker = createFileSystemOverrideTracker(filePath, { followUpDeadlineMs: twoHoursMs });

  try {
    const record = await tracker.create(makeRecord());
    expect(record.followUpDeadline).toBe("2026-04-13T14:00:00.000Z");
  } finally {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  }
});
