import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { createWeaverError } from "@weaver-conf/config-types";
import { parseBootstrapSeed } from "./seed-trust";

/** Validate the opened inode, not a pathname that could be replaced after lstat. */
export async function readPrivateJson(
  path: string,
  maxBytes = 65_536,
): Promise<unknown> {
  if (typeof process.getuid !== "function")
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Private seed files require a POSIX owner/permission model",
    );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > maxBytes
    )
      throw createWeaverError(
        "FORBIDDEN",
        "Seed/input file must be owner-only, regular, and within its size bound",
      );
    const content = await readBoundedFile(handle, maxBytes);
    try {
      return JSON.parse(content);
    } catch {
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Invalid JSON in bootstrap input",
      );
    }
  } finally {
    await handle.close();
  }
}

/** A file can grow after fstat; bound actual bytes through EOF on the same descriptor. */
async function readBoundedFile(
  handle: FileHandle,
  maxBytes: number,
): Promise<string> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  while (length <= maxBytes) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) return buffer.subarray(0, length).toString("utf8");
    length += bytesRead;
  }
  throw createWeaverError(
    "FORBIDDEN",
    "Bootstrap input exceeds its size bound",
  );
}
export async function readBootstrapSeed(path: string) {
  return parseBootstrapSeed(await readPrivateJson(path));
}
