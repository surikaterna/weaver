import { captureDomain, domainSchema } from "./domain-capture";
import {
  isPublicSlashPath,
  isRegistrationEnvironment,
  isReservedPathSegment,
  providerIdPattern,
  publicSlashPathIssue,
  serviceIdPattern,
  slotPathIssue,
} from "./domain-paths";

export {
  isReservedPathSegment,
  providerIdPattern,
  serviceIdPattern,
} from "./domain-paths";

export const serviceIdSchema = domainSchema<string, string>(
  (input) =>
    captureDomain(
      input,
      (value): value is string =>
        typeof value === "string" && serviceIdPattern.test(value),
    ),
  `Invalid string: must match pattern ${serviceIdPattern}`,
);
export const providerIdSchema = domainSchema<string, string>(
  (input) =>
    captureDomain(
      input,
      (value): value is string =>
        typeof value === "string" && providerIdPattern.test(value),
    ),
  `Invalid string: must match pattern ${providerIdPattern}`,
);
export const registrationEnvironmentSchema = domainSchema<string, string>(
  (input) => captureDomain(input, isRegistrationEnvironment),
  (input) =>
    typeof input === "string" && isReservedPathSegment(input)
      ? "Environment uses a reserved identifier"
      : "Invalid registration environment",
);
export const publicConfigPathSchema = domainSchema<string, string>(
  (input) => captureDomain(input, isPublicSlashPath),
  (input) => publicSlashPathIssue(input) ?? "Invalid public configuration path",
);
export const slotPathSchema = domainSchema<string, string>(
  (input) =>
    captureDomain(
      input,
      (value): value is string =>
        typeof value === "string" && slotPathIssue(value) === undefined,
    ),
  (input) => slotPathIssue(input) ?? "Invalid fragment slot path",
);
