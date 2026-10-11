import { z } from "zod";
import {
  configurationInspectionValueSchema,
  configurationServiceIdentitySchema,
} from "./schemas-service-capabilities";
import { configurationValueSchema } from "./schemas-service-mutations";
import {
  configurationNamespaceSchema,
  configurationViewIdSchema,
} from "./schemas-service-paths";
import { serviceDataBoundary } from "./service-data-boundary";
import type { ConfigurationReader } from "./service-readers";

export const configurationReaderSelectionSchema = serviceDataBoundary(
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      namespace: configurationNamespaceSchema,
      viewId: configurationViewIdSchema.optional(),
    })
    .refine((value) => value.namespace !== "/" || value.viewId === undefined, {
      message: "A view requires a nonroot namespace",
    })
    .refine((value) => !value.namespace.split("/").includes("instances"), {
      message: "Instance storage is not a reader namespace",
    })
    .readonly(),
);

export const configurationReaderGetOptionsSchema = serviceDataBoundary(
  z
    .strictObject({
      layer: z.string().min(1).optional(),
      defaultValue: configurationValueSchema.optional(),
    })
    .readonly(),
);

export const configurationReaderSnapshotSchema = serviceDataBoundary(
  z
    .strictObject({
      selection: configurationReaderSelectionSchema,
      revision: z.string().min(1),
      value: configurationInspectionValueSchema,
      mode: z.enum(["live", "degraded"]),
      degradedProviders: z.array(z.string().min(1)).readonly(),
    })
    .readonly(),
);

function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}

/** Shape validation neither invokes methods nor issues an authenticated handle. */
export const configurationReaderSchema = serviceDataBoundary(
  z
    .strictObject({
      selection: configurationReaderSelectionSchema,
      revision: z.string().min(1),
      prepare: callable<ConfigurationReader["prepare"]>(),
      get: callable<ConfigurationReader["get"]>(),
      snapshot: callable<ConfigurationReader["snapshot"]>(),
      inspect: callable<ConfigurationReader["inspect"]>(),
      validate: callable<ConfigurationReader["validate"]>(),
      withScope: callable<ConfigurationReader["withScope"]>(),
      forView: callable<ConfigurationReader["forView"]>(),
      onChange: callable<ConfigurationReader["onChange"]>(),
      dispose: callable<ConfigurationReader["dispose"]>(),
    })
    .readonly(),
);
