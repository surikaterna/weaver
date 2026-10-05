export const owner = { name: "owner", contact: "owner@example.org" };
export function service(environment = "dev", slotPath = "/plugins") {
  return {
    serviceId: "svc", environment, owner: { ...owner },
    schema: { type: "object", properties: { name: { type: "string" } } },
    fragmentSlots: [{ slotPath, accepts: "object" }],
  };
}
export function fragment(environment = "dev", slotPath = "/plugins", providerId = "p") {
  return { serviceId: "svc", environment, slotPath, providerId, owner: { ...owner }, schema: { type: "object" } };
}
export function requests() {
  return [
    fragment(), service(), fragment(), fragment(),
    { ...service(), fragmentSlots: [] },
    service(),
    { ...service(), schemaVersion: "2", schema: { type: "object", properties: { name: { type: "number" } } } },
    fragment("other"),
    { ...service("bad"), fragmentSlots: [{ slotPath: "../escape", accepts: "object" }] },
    { ...service("bad"), fragmentSlots: [{ slotPath: "/same", accepts: "object" }, { slotPath: "/same", accepts: "object" }] },
    { ...service("invalid"), schema: { type: "string" } },
    service("prod/dev:x"), service("x", "/plugins/p:prod"),
    fragment("prod/dev:x"), fragment("x", "/plugins/p:prod", "dev"),
    service("雪/e\u0301", "/literal.dot/😀"), fragment("雪/e\u0301", "/literal.dot/😀", "p.dot"),
    fragment("雪/e\u0301", "/literal.dot/😀", "雪.dot"),
  ];
}
export function outcome(result) {
  const { error, ...data } = result;
  return { ...data, ...(error ? { error: { code: error.code, message: error.message } } : {}) };
}

export function digest(value) {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return createHash("sha256").update(json).digest("hex");
}
import { createHash } from "node:crypto";
