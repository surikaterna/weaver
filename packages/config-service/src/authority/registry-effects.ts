import {
  captureServiceData,
  writeResultSchema,
} from "@weaver-conf/config-types";
import type { CapturedWriter } from "./provider-write";

export async function dispatchEffect(
  writer: CapturedWriter,
  effect: () => Promise<unknown>,
  observe: () => void = () => {},
): Promise<"committed" | "rejected" | "unknown"> {
  const accepted = await acceptEffect(writer, effect, observe);
  return accepted === "accepted" ? finishEffect(writer, observe) : accepted;
}

/** Private storage acceptance; only the authority may combine it with finalization. */
export async function acceptEffect(
  writer: CapturedWriter,
  effect: () => Promise<unknown>,
  observe: () => void = () => {},
): Promise<"accepted" | "rejected" | "unknown"> {
  try {
    const output = await effect();
    observe();
    const copied = captureServiceData(output);
    const parsed = copied.success
      ? writeResultSchema.safeParse(copied.value)
      : undefined;
    if (
      !parsed?.success ||
      (parsed.data.success && parsed.data.error !== undefined)
    )
      return "unknown";
    if (!parsed.data.success)
      return writer.declaration.failureSemantics === "rejected-means-no-effect"
        ? "rejected"
        : "unknown";
    return "accepted";
  } catch {
    observe();
    return "unknown";
  }
}

/** Required flush is a separate binding-level guarantee, never a mutation retry. */
export async function finishEffect(
  writer: CapturedWriter,
  observe: () => void = () => {},
): Promise<"committed" | "unknown"> {
  if (!writer.flush) return "committed";
  try {
    const flushed = await writer.flush();
    observe();
    return flushed === undefined ? "committed" : "unknown";
  } catch {
    observe();
    return "unknown";
  }
}
