import { cloneValue, deepRemove, deepSet } from "@weaver-conf/config-engine";
import {
  type ConfigurationStorageProvider,
  captureServiceData,
  type WriteResult,
} from "@weaver-conf/config-types";

/** Single entry store. Eligibility changes do not erase a queued publication's input. */
export class SessionStorage {
  private entries: Record<string, unknown> = {};
  readonly provider: ConfigurationStorageProvider;

  constructor(id: string, layer: string, eligible: () => boolean) {
    this.provider = {
      id,
      layer,
      writable: true,
      load: async () => ({ entries: this.snapshot() }),
      write: async (key, value) => this.change(eligible, key, value, false),
      remove: async (key) => this.change(eligible, key, undefined, true),
    };
  }

  snapshot(): Record<string, unknown> {
    return cloneValue(this.entries);
  }

  clear(): number {
    const count = Object.keys(this.entries).length;
    this.entries = {};
    return count;
  }

  private change(
    eligible: () => boolean,
    key: string,
    value: unknown,
    remove: boolean,
  ): WriteResult {
    if (!eligible())
      return this.rejected("SESSION_REQUIRED", "No active session");
    try {
      const next = this.snapshot();
      if (remove) deepRemove(next, key);
      else {
        const captured = captureServiceData(value);
        if (!captured.success)
          return this.rejected("VALIDATION_ERROR", "Invalid session value");
        deepSet(next, key, cloneValue(captured.value));
      }
      this.entries = next;
      return { success: true };
    } catch {
      return this.rejected(
        "VALIDATION_ERROR",
        "Invalid session storage path or value",
      );
    }
  }

  private rejected(
    code: "SESSION_REQUIRED" | "VALIDATION_ERROR",
    message: string,
  ): WriteResult {
    return { success: false, error: { code, message } };
  }
}
