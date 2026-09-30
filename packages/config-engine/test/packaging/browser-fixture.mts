import { extractErrorMessage, isNodeError } from "@weaver-conf/config-engine";

declare const caught: unknown;
if (isNodeError(caught)) {
  const error: Error = caught;
  const errno: number | undefined = caught.errno;
  const code: string | undefined = caught.code;
  const path: string | undefined = caught.path;
  const syscall: string | undefined = caught.syscall;
  const message: string = extractErrorMessage(error);
  // @ts-expect-error Optional code is not guaranteed to exist.
  const required: string = caught.code;
  // @ts-expect-error errno is numeric.
  caught.errno = "ENOENT";
  // @ts-expect-error code is textual.
  caught.code = 1;
  // @ts-expect-error path is textual.
  caught.path = 1;
  // @ts-expect-error syscall is textual.
  caught.syscall = 1;
}
// @ts-expect-error The structural helper is not a named public API.
import type { NodeError } from "@weaver-conf/config-engine";
// @ts-expect-error The validation schema is internal.
import { nodeErrorSchema } from "@weaver-conf/config-engine";
