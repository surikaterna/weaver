// Imports are allowed for bundling; calling a Node path adapter must fail.
export function dirname() {
  throw new Error("node:path not available in browser");
}
export function resolve() {
  throw new Error("node:path not available in browser");
}
export function join() {
  throw new Error("node:path not available in browser");
}
