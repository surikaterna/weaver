import { createWeaverError } from "@weaver-conf/config-types";

export type ApplicationOperationLease = Readonly<object>;
export type BatchOperationLease = Readonly<object>;
export type ControlOperationLease = Readonly<object>;

type LeaseKind = "application" | "batch" | "control";
interface LeaseRecord {
  readonly kind: LeaseKind;
  readonly generation: number;
  live: boolean;
}

export interface OperationLeaseAuthority {
  readonly application: (generation: number) => ApplicationOperationLease;
  readonly batch: (generation: number) => BatchOperationLease;
  readonly control: (generation: number) => ControlOperationLease;
  readonly assertApplication: (lease: ApplicationOperationLease) => void;
  readonly assertBatch: (
    lease: BatchOperationLease,
    generation?: number,
  ) => void;
  readonly assertControl: (lease: ControlOperationLease) => void;
  readonly assertOperation: (
    lease: ApplicationOperationLease | ControlOperationLease,
  ) => void;
  readonly revokeApplication: (lease: ApplicationOperationLease) => void;
  readonly revokeBatch: (lease: BatchOperationLease) => void;
  readonly revokeControl: (lease: ControlOperationLease) => void;
}

export function createOperationLeaseAuthority(): OperationLeaseAuthority {
  const records = new WeakMap<object, LeaseRecord>();
  const mint = (kind: LeaseKind, generation: number) => {
    const lease = Object.freeze({});
    records.set(lease, { kind, generation, live: true });
    return lease;
  };
  const assert = (kind: LeaseKind, lease: object, generation?: number) => {
    const record = records.get(lease);
    if (
      !record?.live ||
      record.kind !== kind ||
      (generation !== undefined && record.generation !== generation)
    )
      throw invalidLeaseError();
  };
  const revoke = (lease: object) => {
    const record = records.get(lease);
    if (record) record.live = false;
  };
  return {
    application: (generation) => mint("application", generation),
    batch: (generation) => mint("batch", generation),
    control: (generation) => mint("control", generation),
    assertApplication: (lease) => assert("application", lease),
    assertBatch: (lease, generation) => assert("batch", lease, generation),
    assertControl: (lease) => assert("control", lease),
    assertOperation: (lease) => {
      const record = records.get(lease);
      if (!record?.live) throw invalidLeaseError();
    },
    revokeApplication: revoke,
    revokeBatch: revoke,
    revokeControl: revoke,
  };
}

export interface ConfigOperationQueue {
  readonly assertSubmissionAllowed: () => void;
  readonly enqueueApplication: <T>(
    lease: ApplicationOperationLease,
    operation: (lease: ApplicationOperationLease) => Promise<T> | T,
  ) => Promise<T>;
  readonly enqueueControl: <T>(
    lease: ControlOperationLease,
    operation: (lease: ControlOperationLease) => Promise<T> | T,
  ) => Promise<T>;
  readonly enqueueBatch: <T>(
    lease: BatchOperationLease,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  readonly continueApplication: <T>(
    lease: ApplicationOperationLease,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  readonly continueControl: <T>(
    lease: ControlOperationLease,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
}

export function createConfigOperationQueue(
  leases: OperationLeaseAuthority,
): ConfigOperationQueue {
  return new OperationQueue(leases);
}

class OperationQueue implements ConfigOperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private synchronousLease: object | undefined;
  constructor(private readonly leases: OperationLeaseAuthority) {}
  assertSubmissionAllowed = () => {
    if (this.synchronousLease) throw reentrantSubmissionError();
  };
  enqueueApplication = <T>(
    lease: ApplicationOperationLease,
    operation: (lease: ApplicationOperationLease) => Promise<T> | T,
  ) => {
    this.leases.assertApplication(lease);
    return this.enqueue(async () => {
      try {
        return await this.invoke(lease, () => operation(lease));
      } finally {
        this.leases.revokeApplication(lease);
      }
    });
  };
  enqueueControl = <T>(
    lease: ControlOperationLease,
    operation: (lease: ControlOperationLease) => Promise<T> | T,
  ) => {
    this.leases.assertControl(lease);
    return this.enqueue(async () => {
      try {
        return await this.invoke(lease, () => operation(lease));
      } finally {
        this.leases.revokeControl(lease);
      }
    });
  };
  enqueueBatch = <T>(
    lease: BatchOperationLease,
    operation: () => Promise<T> | T,
  ) => {
    this.leases.assertBatch(lease);
    return this.enqueue(async () => {
      this.leases.assertBatch(lease);
      return await this.invoke(lease, operation);
    });
  };
  continueApplication = async <T>(
    lease: ApplicationOperationLease,
    operation: () => Promise<T> | T,
  ) => {
    this.leases.assertApplication(lease);
    return this.invoke(lease, operation);
  };
  continueControl = async <T>(
    lease: ControlOperationLease,
    operation: () => Promise<T> | T,
  ) => {
    this.leases.assertControl(lease);
    return this.invoke(lease, operation);
  };
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private invoke<T>(lease: object, operation: () => Promise<T> | T) {
    this.synchronousLease = lease;
    try {
      return operation();
    } finally {
      this.synchronousLease = undefined;
    }
  }
}

function invalidLeaseError() {
  return createWeaverError(
    "FORBIDDEN",
    "Invalid, expired, or mismatched configuration operation lease",
  );
}

function reentrantSubmissionError() {
  return createWeaverError(
    "FORBIDDEN",
    "Nested operations require the current configuration operation lease",
  );
}
