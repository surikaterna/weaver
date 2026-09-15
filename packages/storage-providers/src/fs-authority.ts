import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isNodeError, runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type FileAuthorityOptions,
  fileAuthorityOptionsSchema,
  type LayerEnvelope,
  type ProviderCapabilities,
  type ProviderPreflight,
} from "@weaver-conf/config-types";
import { freshEnvelope, parseEnvelope } from "./authority-envelope";
import { type AuthorityBackend, LayerAuthority } from "./layer-authority";

/** Dedicated persistent local directory; no NFS, overlays, or uncooperative writers. */
export type { FileAuthorityOptions } from "@weaver-conf/config-types";

class FileAuthorityBackend implements AuthorityBackend {
  readonly capabilities: ProviderCapabilities;
  private readonly directory: string;
  private readonly knownLayers: readonly string[];
  private canonicalFile: string | undefined;
  private ownedToken: string | undefined;
  constructor(
    private readonly filePath: string,
    private readonly baseLayer: string,
    private readonly options: FileAuthorityOptions,
  ) {
    this.directory = dirname(resolve(filePath));
    this.knownLayers = [
      ...new Set([baseLayer, ...(options.layers ?? [])]),
    ].sort();
    this.capabilities = {
      kind: "durable-exclusive",
      durability: "local-fsync",
      namespace: this.directory,
      maxEnvelopeBytes: 16_000_000,
      scopedIO: "complete",
    };
  }
  private path(layer: string): string {
    if (!this.knownLayers.includes(layer))
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        `Uncatalogued physical layer: ${layer}`,
      );
    return layer === this.baseLayer
      ? resolve(this.filePath)
      : `${resolve(this.filePath)}.${encodeURIComponent(layer)}.json`;
  }
  private async identity(): Promise<string> {
    this.canonicalFile ??= `${await realpath(this.directory)}/${basename(this.filePath)}`;
    return `fs:${this.canonicalFile}`;
  }
  async acquire(): Promise<void> {
    await this.preflight();
    if (this.options.initialize) await createDurableDirectory(this.directory);
    await this.identity();
    try {
      await mkdir(`${this.directory}/.weaver-writer`);
      this.ownedToken = randomUUID();
    } catch (error) {
      throw createWeaverError(
        isNodeError(error) && error.code === "EEXIST"
          ? "WRITER_CONFLICT"
          : "COMMIT_OUTCOME_UNKNOWN",
        "Cannot acquire filesystem namespace; never auto-steal a lock",
        { cause: String(error) },
      );
    }
    try {
      await syncDirectory(this.directory);
      await this.checkNamespace();
      await this.initialize();
    } catch (error) {
      await runIndependentCleanup(
        [{ name: "filesystem writer", run: () => this.release() }],
        error,
      );
    }
  }
  async release(): Promise<void> {
    const token = this.ownedToken;
    if (!token)
      throw createWeaverError(
        "WRITER_CONFLICT",
        "Filesystem writer release already initiated",
      );
    this.ownedToken = undefined;
    try {
      await rmdir(`${this.directory}/.weaver-writer`);
      await syncDirectory(this.directory);
    } catch (error) {
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Filesystem release is quarantined; never retry pathname deletion",
        {
          namespace: this.directory,
          token,
          phase: "release-initiated",
          cause: String(error),
        },
      );
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
        "Filesystem declared layers differ from catalog",
      );
    const namespace = await canonicalDirectory(this.directory);
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      files = [];
    }
    if (files.includes(".weaver-writer"))
      throw createWeaverError(
        "WRITER_CONFLICT",
        "Filesystem namespace is already owned",
      );
    if (!files.length && this.options.initialize)
      return {
        namespace,
        layers: [...this.knownLayers],
        initialization: "fresh",
      };
    await this.checkNamespace();
    for (const layer of this.knownLayers) await this.read(layer);
    return {
      namespace,
      layers: [...this.knownLayers],
      initialization: "existing",
    };
  }
  private async checkNamespace(): Promise<void> {
    const allowed = new Set([
      ".weaver-writer",
      ...this.knownLayers.map((layer) => basename(this.path(layer))),
    ]);
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (!allowed.has(entry.name) || entry.isSymbolicLink())
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          `Unmanaged namespace entry: ${entry.name}`,
        );
    }
  }
  private async initialize(): Promise<void> {
    const files = await readdir(this.directory);
    const empty = files.every((name) => name === ".weaver-writer");
    if (!empty || !this.options.initialize) return;
    for (const layer of this.knownLayers)
      await this.persist(
        freshEnvelope(await this.identity(), this.options.environment, layer),
      );
  }
  async layers(): Promise<string[]> {
    await this.checkNamespace();
    return [...this.knownLayers];
  }
  async read(layer: string): Promise<LayerEnvelope> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.path(layer), "utf8"));
    } catch (error) {
      throw createWeaverError(
        "PROVIDER_CORRUPT",
        "Missing or unreadable initialized layer envelope",
        { layer, cause: String(error) },
      );
    }
    const envelope = parseEnvelope(value);
    if (
      envelope.storeId !== (await this.identity()) ||
      envelope.environment !== this.options.environment ||
      envelope.layer !== layer
    )
      throw createWeaverError(
        "PROVIDER_CORRUPT",
        "Envelope identity does not match backend locator",
      );
    return envelope;
  }
  async persist(envelope: LayerEnvelope): Promise<void> {
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content) > 16_000_000)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Layer envelope exceeds supported size",
      );
    await durableReplace(this.path(envelope.layer), content);
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return resolve(await canonicalDirectory(dirname(path)), basename(path));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDurableDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true });
  if (!firstCreated) return;
  const parent = dirname(firstCreated);
  for (let current = path; current !== parent; current = dirname(current))
    await syncDirectory(current);
  await syncDirectory(parent);
}

async function durableReplace(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw createWeaverError(
      "COMMIT_OUTCOME_UNKNOWN",
      "Filesystem commit was not durably acknowledged; reconcile receipt before recovery",
      { cause: String(error) },
    );
  } finally {
    await cleanTemporary(temporary);
  }
}

async function cleanTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT")
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Temporary file cleanup failed",
      );
  }
}

export function createFileAuthority(
  filePath: string,
  layer: string,
  options: FileAuthorityOptions,
): LayerAuthority {
  return new LayerAuthority(
    new FileAuthorityBackend(
      filePath,
      layer,
      fileAuthorityOptionsSchema.parse(options),
    ),
  );
}
