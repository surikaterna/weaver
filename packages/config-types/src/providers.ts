import type { ConfigurationLayer, ConfigurationLayerData } from "./types";

/** Structured error details returned from a failed write operation. */
export interface WriteError {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

/** Outcome of a write or remove operation against a storage provider. */
export interface WriteResult {
  success: boolean;
  revision?: string | undefined;
  error?: WriteError | undefined;
}

/** Describes a single key change detected by a storage provider. */
export interface ConfigurationChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Pluggable storage backend for a single configuration layer. */
export interface ConfigurationStorageProvider {
  readonly id: string;
  readonly layer: ConfigurationLayer | string;
  readonly writable: boolean;
  load(): Promise<ConfigurationLayerData>;
  loadLayer?(layer: string): Promise<ConfigurationLayerData>;
  write(key: string, value: unknown): Promise<WriteResult>;
  writeLayer?(layer: string, key: string, value: unknown): Promise<WriteResult>;
  remove(key: string): Promise<WriteResult>;
  removeLayer?(layer: string, key: string): Promise<WriteResult>;

  /** Pull latest state from remote source (e.g., git pull). No-op for local-only providers. */
  refresh?(): Promise<void>;

  /** Commit and push any buffered writes (e.g., git commit + push). No-op for immediate-write providers. */
  flush?(): Promise<void>;

  /** Whether this provider has unflushed local changes. */
  readonly dirty?: boolean;

  onExternalChange?(
    listener: (changes: ConfigurationChange[]) => void,
  ): () => void;
}

/** Discriminated union representing the current synchronization state. */
export type SyncStatus =
  | { status: "synced"; lastSyncedAt: number }
  | { status: "syncing" }
  | { status: "offline"; lastSyncedAt: number; pendingWriteCount: number }
  | { status: "conflict"; conflicts: ConfigurationConflict[] }
  | { status: "error"; error: string; lastSyncedAt?: number | undefined };

/** A detected conflict between local and remote values for the same key. */
export interface ConfigurationConflict {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
  localRevision: string;
  remoteRevision: string;
}

/** Summary of a sync cycle — counts of pulled/pushed changes and any conflicts. */
export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: ConfigurationConflict[];
}

/** Opaque cursor for resumable sync — tracks server revision and feed position. */
export interface SyncCursor {
  /**
   * Authoritative server revision token.
   */
  serverRevision: string;
  /**
   * Server-side clock (epoch ms) associated with this cursor.
   */
  serverTime: number;
  /**
   * Optional transport-specific token for feed resume.
   */
  feedToken?: string | undefined;
}

/** Metadata about the current state of the mutation queue. */
export interface SyncQueueMetadata {
  pendingCount: number;
  inFlightCount: number;
  oldestQueuedAt?: number | undefined;
  newestQueuedAt?: number | undefined;
}

/** The type of mutation: set a value or remove a key. */
export type SyncMutationOperation = "set" | "remove";

/** Tracking metadata for a queued mutation (attempt count, timestamps). */
export interface SyncMutationMetadata {
  queuedAt: number;
  attemptCount: number;
  lastAttemptAt?: number | undefined;
  policyAllowed: boolean;
}

/** A mutation waiting in the local queue to be pushed to the server. */
export interface SyncQueuedMutation {
  mutationId: string;
  key: string;
  operation: SyncMutationOperation;
  value?: unknown;
  baseRevision?: string | undefined;
  metadata: SyncMutationMetadata;
}

/** A change received from the server during a pull operation. */
export interface SyncRemoteChange {
  key: string;
  value?: unknown;
  operation: SyncMutationOperation;
  revision: string;
  serverTime: number;
}

/** Categorized error codes for sync transport failures. */
export type SyncErrorCode =
  | "network"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "validation"
  | "conflict"
  | "rate-limited"
  | "server"
  | "unknown";

/** Structured error details from a failed sync operation. */
export interface SyncErrorMetadata {
  code: SyncErrorCode;
  message: string;
  retryable: boolean;
  status?: number | undefined;
  key?: string | undefined;
  mutationId?: string | undefined;
  serverTime?: number | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
}

/** Conflict details when a local mutation collides with a server-side change. */
export interface SyncConflictMetadata {
  key: string;
  mutationId?: string | undefined;
  localRevision?: string | undefined;
  serverRevision: string;
  localValue?: unknown;
  serverValue?: unknown;
  serverTime: number;
}

/** Request payload for pulling remote changes since a cursor position. */
export interface ConfigSyncPullRequest {
  cursor?: SyncCursor | undefined;
  limit?: number | undefined;
}

/** Server response containing remote changes and an updated cursor. */
export interface ConfigSyncPullResponse {
  cursor: SyncCursor;
  serverTime: number;
  changes: ReadonlyArray<SyncRemoteChange>;
}

/** Request payload for pushing local mutations to the server. */
export interface ConfigSyncPushRequest {
  requestId: string;
  mutations: ReadonlyArray<SyncQueuedMutation>;
}

/** Per-mutation result within a push response — accepted, conflicted, or errored. */
export interface ConfigSyncPushResult {
  mutationId: string;
  accepted: boolean;
  revision?: string | undefined;
  conflict?: SyncConflictMetadata | undefined;
  error?: SyncErrorMetadata | undefined;
}

/** Server response to a push request with per-mutation results. */
export interface ConfigSyncPushResponse {
  requestId: string;
  serverRevision: string;
  serverTime: number;
  results: ReadonlyArray<ConfigSyncPushResult>;
}

/** Request to acknowledge successful processing of a push response. */
export interface ConfigSyncAckRequest {
  requestId: string;
}

/** Server confirmation that a push acknowledgement was received. */
export interface ConfigSyncAckResponse {
  requestId: string;
  acked: boolean;
  serverRevision: string;
  serverTime: number;
}

/** Durable cache for sync snapshots and cursor state (survives restarts). */
export interface SyncSnapshotCache {
  loadSnapshot(): Promise<ConfigurationLayerData>;
  saveSnapshot(data: ConfigurationLayerData): Promise<void>;
  getCursor(): Promise<SyncCursor | undefined>;
  setCursor(cursor: SyncCursor): Promise<void>;
}

/** Durable queue for pending mutations with in-flight tracking. */
export interface SyncMutationQueue {
  enqueueMutation(mutation: SyncQueuedMutation): Promise<void>;
  peekQueuedMutations(
    limit: number,
  ): Promise<ReadonlyArray<SyncQueuedMutation>>;
  markRequestInFlight(
    requestId: string,
    mutationIds: ReadonlyArray<string>,
  ): Promise<void>;
  acknowledgeRequest(requestId: string): Promise<void>;
  releaseRequest(requestId: string, error: SyncErrorMetadata): Promise<void>;
  getQueueMetadata(): Promise<SyncQueueMetadata>;
}

/** Combined snapshot cache and mutation queue for full offline-capable sync. */
export type DurableConfigCache = SyncSnapshotCache & SyncMutationQueue;

/** Transport abstraction for sync protocol (pull/push/ack cycle). */
export interface ConfigSyncTransport {
  pull(request: ConfigSyncPullRequest): Promise<ConfigSyncPullResponse>;
  push(request: ConfigSyncPushRequest): Promise<ConfigSyncPushResponse>;
  ack(request: ConfigSyncAckRequest): Promise<ConfigSyncAckResponse>;
}
