import { createWeaverError } from "@weaver-conf/config-types";
import {
  type ApplicationOperationLease,
  type BatchOperationLease,
  type ControlOperationLease,
  createConfigOperationQueue,
  createOperationLeaseAuthority,
} from "./config-operation-lease";

type AdmissionState = "open" | "pending" | "active" | "closed";
interface FenceResolution {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface ApplicationMaintenanceBarrier {
  readonly state: () => AdmissionState;
  readonly assertApplicationAccess: () => void;
  readonly assertSubmissionAllowed: () => void;
  readonly runApplication: <T>(
    operation: (lease: ApplicationOperationLease) => Promise<T> | T,
  ) => Promise<T>;
  readonly runBatch: <T>(
    operation: (lease: BatchOperationLease) => Promise<T>,
  ) => Promise<T>;
  readonly submitBatch: <T>(
    lease: BatchOperationLease,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  readonly assertBatchLease: (lease: BatchOperationLease) => void;
  readonly isAdmissionFailure: (error: unknown) => boolean;
  readonly runControl: <T>(
    operation: (lease: ControlOperationLease) => Promise<T> | T,
  ) => Promise<T>;
  readonly run: <T>(
    operation: (lease: ControlOperationLease) => Promise<T> | T,
  ) => Promise<T>;
  readonly continueApplication: <T>(
    lease: ApplicationOperationLease,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  readonly continueControl: <T>(
    lease: ControlOperationLease,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  readonly assertOperationLease: (
    lease: ApplicationOperationLease | ControlOperationLease,
  ) => void;
  readonly closeApplicationAdmission: (
    fenceOperation: (lease: ControlOperationLease) => Promise<void>,
  ) => Promise<void>;
  readonly reopenApplicationAdmission: () => void;
  readonly sealApplicationAdmission: () => void;
}

export function createApplicationMaintenanceBarrier(): ApplicationMaintenanceBarrier {
  return new MaintenanceBarrier();
}

class MaintenanceBarrier implements ApplicationMaintenanceBarrier {
  private readonly leases = createOperationLeaseAuthority();
  private readonly queue = createConfigOperationQueue(this.leases);
  private readonly admissionFailures = new WeakMap<object, number>();
  private readonly liveBatches = new Set<BatchOperationLease>();
  private admissionState: AdmissionState = "open";
  private generation = 0;
  private fence: Promise<void> | undefined;
  private fenceOperation:
    | ((lease: ControlOperationLease) => Promise<void>)
    | undefined;
  private fenceResolution: FenceResolution | undefined;
  private fenceQueued = false;
  state = () => this.admissionState;
  assertApplicationAccess = () => {
    if (this.admissionState !== "open") throw this.admissionError();
  };
  assertSubmissionAllowed = this.queue.assertSubmissionAllowed;
  runApplication = <T>(
    operation: (lease: ApplicationOperationLease) => Promise<T> | T,
  ) => {
    if (this.admissionState !== "open")
      return Promise.reject(this.admissionError());
    try {
      this.queue.assertSubmissionAllowed();
    } catch (error) {
      return Promise.reject(error);
    }
    const lease = this.leases.application(this.generation);
    return this.queue.enqueueApplication(lease, operation);
  };
  runBatch = <T>(operation: (lease: BatchOperationLease) => Promise<T>) => {
    if (this.admissionState !== "open")
      return Promise.reject(this.admissionError());
    try {
      this.queue.assertSubmissionAllowed();
    } catch (error) {
      return Promise.reject(error);
    }
    const lease = this.leases.batch(this.generation);
    this.liveBatches.add(lease);
    let result: Promise<T>;
    try {
      result = Promise.resolve(operation(lease));
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => this.releaseBatch(lease));
  };
  submitBatch = <T>(
    lease: BatchOperationLease,
    operation: () => Promise<T> | T,
  ) => {
    this.leases.assertBatch(lease, this.generation);
    return this.queue.enqueueBatch(lease, operation);
  };
  assertBatchLease = (lease: BatchOperationLease) =>
    this.leases.assertBatch(lease, this.generation);
  isAdmissionFailure = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    this.admissionFailures.get(error) === this.generation;
  runControl = <T>(
    operation: (lease: ControlOperationLease) => Promise<T> | T,
  ): Promise<T> => {
    if (this.admissionState === "pending" && this.fence)
      return this.fence.then(() => this.runControl(operation));
    try {
      this.queue.assertSubmissionAllowed();
    } catch (error) {
      return Promise.reject(error);
    }
    const lease = this.leases.control(this.generation);
    return this.queue.enqueueControl(lease, () => {
      if (this.admissionState === "pending")
        throw createWeaverError(
          "MAINTENANCE",
          "Maintenance admission drain is incomplete",
        );
      return operation(lease);
    });
  };
  run = this.runControl;
  continueApplication = this.queue.continueApplication;
  continueControl = this.queue.continueControl;
  assertOperationLease = this.leases.assertOperation;
  closeApplicationAdmission = (
    operation: (lease: ControlOperationLease) => Promise<void>,
  ): Promise<void> => {
    if (this.fence) return this.fence;
    this.admissionState = "pending";
    this.fenceOperation = operation;
    const resolution = createFenceResolution();
    this.fenceResolution = resolution;
    this.fence = resolution.promise;
    this.queueFence();
    return resolution.promise;
  };
  reopenApplicationAdmission = () => {
    if (this.admissionState !== "active")
      throw createWeaverError(
        "MAINTENANCE",
        "Application admission cannot reopen before maintenance is active",
      );
    this.admissionState = "open";
    this.generation++;
    this.fence = undefined;
    this.fenceOperation = undefined;
    this.fenceResolution = undefined;
    this.fenceQueued = false;
  };
  sealApplicationAdmission = () => {
    this.admissionState = "closed";
  };

  private admissionError() {
    const error =
      this.admissionState === "closed"
        ? createWeaverError("SERVER_DEGRADED", "Service admission is closed")
        : maintenanceError();
    this.admissionFailures.set(error, this.generation);
    return error;
  }

  private releaseBatch(lease: BatchOperationLease): void {
    this.leases.revokeBatch(lease);
    this.liveBatches.delete(lease);
    this.queueFence();
  }

  private queueFence(): void {
    if (
      this.admissionState !== "pending" ||
      this.liveBatches.size > 0 ||
      this.fenceQueued ||
      !this.fenceOperation ||
      !this.fenceResolution
    )
      return;
    this.fenceQueued = true;
    const lease = this.leases.control(this.generation);
    void this.queue
      .enqueueControl(lease, async () => {
        await this.fenceOperation?.(lease);
        if (this.admissionState !== "closed") this.admissionState = "active";
      })
      .then(this.fenceResolution.resolve, this.fenceResolution.reject);
  }
}

export const maintenanceDrainDeadlineMs = 30_000;

export interface MaintenanceDeadlineTimer {
  readonly schedule: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;
}

const systemDeadlineTimer: MaintenanceDeadlineTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle),
};

export async function waitForMaintenanceFence(
  fence: Promise<void>,
  timer: MaintenanceDeadlineTimer = systemDeadlineTimer,
): Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = timer.schedule(
      () => reject(maintenanceError("Maintenance drain deadline exceeded")),
      maintenanceDrainDeadlineMs,
    );
  });
  try {
    await Promise.race([fence, deadline]);
  } finally {
    if (handle !== undefined) timer.cancel(handle);
  }
}

function maintenanceError(
  message = "Application configuration is in maintenance",
) {
  return createWeaverError("MAINTENANCE", message);
}

function createFenceResolution(): FenceResolution {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
