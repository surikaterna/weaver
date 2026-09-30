import { z } from "zod";
import {
  isReservedPathSegment,
  publicConfigPathSchema,
} from "./schemas-registration-paths";
import { serviceDataBoundary } from "./service-data-boundary";

const literalSegmentSchema = z
  .string()
  .min(1)
  .refine(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      segment !== "_weaver" &&
      !/[/[\]]/.test(segment) &&
      !isReservedPathSegment(segment),
    { message: "Expected a literal configuration segment" },
  );

export const canonicalConfigurationPathSchema = publicConfigPathSchema
  .refine((path) =>
    path
      .slice(1)
      .split("/")
      .every((segment) => literalSegmentSchema.safeParse(segment).success),
  )
  .brand<"CanonicalConfigurationPath">();

export const relativeConfigurationPathSchema = serviceDataBoundary(
  z.tuple([literalSegmentSchema]).rest(literalSegmentSchema).readonly(),
);
