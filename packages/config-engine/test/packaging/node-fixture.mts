import { isNodeError } from "@weaver-conf/config-engine";

type GuardResult<T> = T extends (value: unknown) => value is infer R ? R : never;
type Result = GuardResult<typeof isNodeError>;
declare const node: NodeJS.ErrnoException;
declare const result: Result;
const toResult: Result = node;
const toNode: NodeJS.ErrnoException = result;
declare const caught: unknown;
if (isNodeError(caught)) {
  const narrowed: NodeJS.ErrnoException = caught;
  const back: Result = narrowed;
}
