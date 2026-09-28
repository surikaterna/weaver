// Imports are allowed for bundling; calling a Node filesystem adapter must fail.
export function existsSync() {
  throw new Error("node:fs not available in browser");
}
export function mkdirSync() {
  throw new Error("node:fs not available in browser");
}
export function readFileSync() {
  throw new Error("node:fs not available in browser");
}
export function renameSync() {
  throw new Error("node:fs not available in browser");
}
export function writeFileSync() {
  throw new Error("node:fs not available in browser");
}
