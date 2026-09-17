import { createHash } from "node:crypto";
import {
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";

export const sourceSchema = {
  type: "object",
  properties: { keep: { type: "boolean" } },
  additionalProperties: false,
};

export const targetSchema = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    added: { type: "string", default: "planned" },
  },
  additionalProperties: false,
};

export function planRequest(runtime, initialization, schema) {
  const sourceCatalog = {
    registrations: Object.fromEntries(
      initialization.registrations.map((request) => {
        const record = initialRegistrationRecord(request);
        return [internalRegistrationId(record), record];
      }),
    ),
  };
  const record = { version: 1, kind: "service", request: { serviceId: "svc", environment: "dev", owner: { name: "fixture", contact: "fixture@example.test" }, schema, fragmentSlots: [] }, audit: { actor: "planner" } };
  const registrations = { [internalRegistrationId(record)]: record };
  const targetCatalog = { registrations };
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog),
    inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: { catalogDigest: digest(targetCatalog), registrations },
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
