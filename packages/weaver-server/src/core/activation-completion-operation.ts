import { sha256Hex } from "@weaver-conf/config-types";

export function activationCompletionOperationId(runId: string): string {
  const value = sha256Hex(`weaver.activation-completion.v1:${runId}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
