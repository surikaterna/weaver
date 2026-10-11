export {
  type AdmissionContext,
  type AdmissionRegistry,
  admissionContextSchema,
  admissionRegistrySchema,
  type Mutation,
  mutationSchema,
  type PreparedMutation,
  preparedMutationSchema,
} from "./authority/admission-contracts";
export { prepareConfigMutation } from "./authority/schema-admission";
export {
  buildSchemaPatch,
  type SchemaPatchResult,
  schemaPatchResultSchema,
} from "./authority/value-patch";
