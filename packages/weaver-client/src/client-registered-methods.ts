import {
  createWeaverError,
  registeredSchemaDetailRequestSchema,
  registeredSchemaDetailResponseSchema,
  registeredSchemaIdentityListResponseSchema,
  registeredSchemaIdentityPageRequestSchema,
  registeredSchemaIdentityPageResponseSchema,
  registeredSchemasResponseSchema,
} from "@weaver-conf/config-types";
import type { ClientRuntime } from "./client-runtime";
import type { WeaverClient } from "./client-types";
import {
  unsupportedRegistration,
  unsupportedValidation,
  unsupportedWrite,
} from "./client-unsupported";

export function registeredMethods(
  runtime: ClientRuntime,
): Pick<
  WeaverClient,
  | "setRegisteredObject"
  | "patchRegisteredPath"
  | "validateRegisteredEffective"
  | "registerSchema"
  | "fetchSchemas"
  | "listRegisteredSchemaIdentities"
  | "listRegisteredSchemaIdentityPage"
  | "getRegisteredSchema"
> {
  return {
    ...registeredWriteMethods(runtime),
    ...registeredBrowseMethods(runtime),
  };
}

function registeredWriteMethods(
  runtime: ClientRuntime,
): Pick<
  WeaverClient,
  | "setRegisteredObject"
  | "patchRegisteredPath"
  | "validateRegisteredEffective"
  | "registerSchema"
> {
  return {
    async setRegisteredObject(path, value, options) {
      return (
        runtime.transport.setRegisteredObject?.(path, value, options) ??
        unsupportedWrite("setRegisteredObject")
      );
    },
    async patchRegisteredPath(path, value, options) {
      return (
        runtime.transport.patchRegisteredPath?.(path, value, options) ??
        unsupportedWrite("patchRegisteredPath")
      );
    },
    async validateRegisteredEffective(options) {
      return (
        runtime.transport.validateRegisteredEffective?.(options) ??
        unsupportedValidation("validateRegisteredEffective")
      );
    },
    async registerSchema(request) {
      return (
        runtime.transport.registerSchema?.(request) ??
        unsupportedRegistration("registerSchema")
      );
    },
  };
}

function registeredBrowseMethods(
  runtime: ClientRuntime,
): Pick<
  WeaverClient,
  | "fetchSchemas"
  | "listRegisteredSchemaIdentities"
  | "listRegisteredSchemaIdentityPage"
  | "getRegisteredSchema"
> {
  return {
    async fetchSchemas() {
      if (!runtime.transport.fetchSchemas) return null;
      return registeredSchemasResponseSchema.parse({
        schemas: await runtime.transport.fetchSchemas(),
      });
    },
    async listRegisteredSchemaIdentities() {
      if (!runtime.transport.listRegisteredSchemaIdentities)
        throw createWeaverError(
          "UNSUPPORTED_OPERATION",
          "Schema identity listing is unsupported by this transport",
        );
      return registeredSchemaIdentityListResponseSchema.parse(
        await runtime.transport.listRegisteredSchemaIdentities(),
      );
    },
    async listRegisteredSchemaIdentityPage(input) {
      if (!runtime.transport.listRegisteredSchemaIdentityPage)
        throw createWeaverError(
          "UNSUPPORTED_OPERATION",
          "Schema identity paging is unsupported by this transport",
        );
      const request = registeredSchemaIdentityPageRequestSchema.parse(
        input ?? {},
      );
      return registeredSchemaIdentityPageResponseSchema.parse(
        await runtime.transport.listRegisteredSchemaIdentityPage(request),
      );
    },
    async getRegisteredSchema(anchorPath, environment) {
      const request = registeredSchemaDetailRequestSchema.parse({
        anchorPath,
        environment,
      });
      if (!runtime.transport.getRegisteredSchema)
        throw createWeaverError(
          "UNSUPPORTED_OPERATION",
          "Schema detail lookup is unsupported by this transport",
        );
      return registeredSchemaDetailResponseSchema.parse(
        await runtime.transport.getRegisteredSchema(
          request.anchorPath,
          request.environment,
        ),
      );
    },
  };
}
