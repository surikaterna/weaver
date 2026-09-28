// Imports are allowed for bundling; calling a Node filesystem adapter must fail.
export function readFile() {
  throw new Error("node:fs/promises not available in browser");
}
export function writeFile() {
  throw new Error("node:fs/promises not available in browser");
}
export function mkdir() {
  throw new Error("node:fs/promises not available in browser");
}
export function rename() {
  throw new Error("node:fs/promises not available in browser");
}
export function stat() {
  throw new Error("node:fs/promises not available in browser");
}
export function appendFile() {
  throw new Error("node:fs/promises not available in browser");
}
