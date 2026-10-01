import { domainSchema } from "@weaver-conf/config-types";
import { literalSnapshotPath } from "./snapshot-capture-data";
import {
  type ConfigurationSnapshot,
  captureSnapshotContract,
  isConfigurationSnapshot,
  isResolutionCeiling,
  isResolutionContribution,
  isResolutionLayer,
  isResolutionOrigin,
  isResolutionSnapshotInput,
  isResolvedPathInspection,
  type ResolutionCeiling,
  type ResolutionContribution,
  type ResolutionLayer,
  type ResolutionOrigin,
  type ResolutionSnapshotInput,
  type ResolvedPathInspection,
} from "./snapshot-captures";

export type {
  ConfigurationSnapshot,
  ResolutionCeiling,
  ResolutionContribution,
  ResolutionLayer,
  ResolutionOrigin,
  ResolutionSnapshotInput,
  ResolvedPathInspection,
} from "./snapshot-captures";

export const resolutionPathSchema = domainSchema<unknown, readonly string[]>(
  (input) => captureSnapshotContract(input, literalSnapshotPath),
  "Invalid resolution path",
);
export const resolutionOriginSchema = domainSchema<unknown, ResolutionOrigin>(
  (input) => captureSnapshotContract(input, isResolutionOrigin),
  "Invalid resolution origin",
);
export const resolutionLayerSchema = domainSchema<unknown, ResolutionLayer>(
  (input) => captureSnapshotContract(input, isResolutionLayer),
  "Invalid resolution layer",
);
export const resolutionCeilingSchema = domainSchema<unknown, ResolutionCeiling>(
  (input) => captureSnapshotContract(input, isResolutionCeiling),
  "Invalid resolution ceiling",
);
export const resolutionSnapshotInputSchema = domainSchema<
  unknown,
  ResolutionSnapshotInput
>(
  (input) => captureSnapshotContract(input, isResolutionSnapshotInput),
  "Invalid resolution snapshot input",
);
export const resolutionContributionSchema = domainSchema<
  unknown,
  ResolutionContribution
>(
  (input) => captureSnapshotContract(input, isResolutionContribution),
  "Invalid resolution contribution",
);
export const configurationSnapshotSchema = domainSchema<
  unknown,
  ConfigurationSnapshot
>(
  (input) => captureSnapshotContract(input, isConfigurationSnapshot),
  "Invalid configuration snapshot",
);
export const resolvedPathInspectionSchema = domainSchema<
  unknown,
  ResolvedPathInspection
>(
  (input) => captureSnapshotContract(input, isResolvedPathInspection),
  "Invalid resolved path inspection",
);
