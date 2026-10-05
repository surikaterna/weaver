import { createConfigurationService, configurationServiceHostOptionsSchema, type ConfigurationServiceHostOptions, type ConfigurationServiceOptions, type HydratedConfigurationService } from "@weaver-conf/config-service";
import * as types from "@weaver-conf/config-types";
import type { z } from "zod";
import { prepareConfigMutation, admissionContextSchema, admissionRegistrySchema, mutationSchema, preparedMutationSchema, type AdmissionContext, type AdmissionRegistry, type Mutation, type PreparedMutation } from "@weaver-conf/config-service/admission";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Options = Assert<Equal<z.output<typeof types.configurationServiceOptionsSchema>, ConfigurationServiceOptions>>;
type OptionsInput = Assert<Equal<z.input<typeof types.configurationServiceOptionsSchema>, unknown>>;
type RegistrationOrder = Assert<Equal<ConfigurationServiceOptions["schemas"], readonly types.SchemaRegistrationRequest[]>>;
type Layers = Assert<Equal<z.infer<typeof types.configurationServiceLayerSlotSchema>, types.ConfigurationServiceLayerSlot>>;
type Binding = Assert<Equal<z.output<typeof types.configurationServiceProviderBindingSchema>, types.ConfigurationServiceProviderBinding>>;
type Environment = Assert<Equal<z.output<typeof types.configurationServiceProviderEnvironmentSchema>, types.ConfigurationServiceProviderEnvironment>>;
type Ownership = Assert<Equal<z.output<typeof types.configurationServiceProviderOwnershipSchema>, types.ConfigurationServiceProviderOwnership>>;
type Read = Assert<Equal<z.output<typeof types.configurationServiceProviderReadSchema>, types.ConfigurationServiceProviderRead>>;
type Context = Assert<Equal<z.output<typeof types.configurationServiceProviderReadContextSchema>, types.ConfigurationServiceProviderReadContext>>;
declare const options: ConfigurationServiceOptions;
const promised: Promise<HydratedConfigurationService> = createConfigurationService(options);
async function check() {
  const root = await promised;
  const path = types.canonicalConfigurationPathSchema.parse("/example/enabled");
  const inspection: types.HydratedConfigurationInspection = root.inspect(path);
  root.get(path); root.getWithDefault(path, true); root.getAtLayer("base", path); root.getNamespace(path);
  root.getForScope(path, []); await root.preloadScope([]);
  root.onChange(path, (change: types.ConfigurationEffectiveChange) => { void change; });
  const write: types.ConfigurationServiceWriteResult = await root.set(path, true, { layer: "base" });
  if (!write.success) { const code: types.WeaverErrorCode = write.error.code; void code; }
  await root.remove(path, { layer: "base" }); await root.reloadProvider("p"); await root.flush(); await root.dispose();
  // @ts-expect-error Factory identities are readonly.
  options.identity.environment = "different";
  // @ts-expect-error Factory layer order is readonly.
  options.layers.push({ kind: "fixed", layer: "other", providerIds: [] });
  // @ts-expect-error No provider/client/transport authority is exposed.
  root.transport;
  // @ts-expect-error No async inspection contract.
  const asyncInspection: Promise<types.HydratedConfigurationInspection> = inspection;
  void asyncInspection;
}
void check;
type HostOutput = Assert<Equal<z.output<typeof configurationServiceHostOptionsSchema>, ConfigurationServiceHostOptions>>;
type HostInput = Assert<Equal<z.input<typeof configurationServiceHostOptionsSchema>, unknown>>;
type Principal = Assert<Equal<z.infer<typeof types.trustedPrincipalSnapshotSchema>, types.TrustedPrincipalSnapshot>>;
type Grant = Assert<Equal<z.infer<typeof types.authorityGrantSchema>, types.AuthorityGrant>>;
type Decision = Assert<Equal<z.infer<typeof types.authorizationDecisionSchema>, types.AuthorizationDecision>>;
type Request = Assert<Equal<z.infer<typeof types.authorizationRequestSchema>, types.AuthorizationRequest>>;
type Audit = Assert<Equal<z.infer<typeof types.configurationAuthorityAuditRecordSchema>, types.ConfigurationAuthorityAuditRecord>>;
type Writer = Assert<Equal<z.infer<typeof types.configurationProviderWriteBindingSchema>, types.ConfigurationProviderWriteBinding>>;
type Token = Assert<Equal<z.infer<typeof types.configurationAuthorityCapabilitySchema>, types.ConfigurationAuthorityCapability>>;
declare const host: ConfigurationServiceHostOptions;
const hosted: Promise<HydratedConfigurationService> = createConfigurationService(options, host);
declare const claims: types.TrustedPrincipalSnapshot;
const binding: ConfigurationServiceHostOptions = {
  ...host,
  onAuthorityReady(controller) {
    const token: types.ConfigurationAuthorityCapability = controller.mint(claims);
    const namespace = types.canonicalConfigurationPathSchema.parse("/example");
    const port: types.ConfigurationAuthorityRequest = controller.forIdentity(token, options.identity, namespace);
    const preparation: Promise<void> = port.prepare();
    const inspection: types.HydratedConfigurationInspection = port.inspect(namespace);
    const write: Promise<types.ConfigurationServiceWriteResult> = port.set(namespace, 1, { layer: "base" });
    controller.bindRoot(token); controller.revoke(token);
    controller.replace(token, claims);
    // @ts-expect-error Field-shaped objects cannot manufacture an opaque capability.
    controller.bindRoot({});
    // @ts-expect-error Captured grants are readonly.
    claims.grants[0]!.layers.push("other");
    void preparation; void inspection; void write;
  },
};
void hosted; void binding;
type Admission = Assert<Equal<z.output<typeof admissionContextSchema>, AdmissionContext>>;
type AdmissionInput = Assert<Equal<z.input<typeof admissionContextSchema>, unknown>>;
type RegistryBoundary = Assert<Equal<z.output<typeof admissionRegistrySchema>, AdmissionRegistry>>;
type MutationBoundary = Assert<Equal<z.output<typeof mutationSchema>, Mutation>>;
type PreparedBoundary = Assert<Equal<z.output<typeof preparedMutationSchema>, PreparedMutation>>;
declare const admission: AdmissionContext;
const prepared: PreparedMutation = prepareConfigMutation(admission);
if (prepared.success) { const entries: Record<string, unknown> = prepared.layerAfter; void entries; }
