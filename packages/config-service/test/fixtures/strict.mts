import { createConfigurationService, configurationServiceHostOptionsSchema, type ConfigurationServiceHostOptions, type ConfigurationServiceOptions, type ConfigurationService } from "@weaver-conf/config-service";
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
const promised: Promise<ConfigurationService> = createConfigurationService(options, host);
declare const reader: types.ConfigurationReader;
async function check() {
  const root = await promised;
  const path = types.canonicalConfigurationPathSchema.parse("/example/enabled");
  const inspection: types.HydratedConfigurationInspection = reader.inspect(["enabled"]);
  reader.get(["enabled"]); reader.get(["enabled"], { defaultValue: true }); reader.get(["enabled"], { layer: "base" }); reader.get();
  const scoped = reader.withScope([]); await scoped.prepare();
  const snapshot: types.ConfigurationReaderSnapshot = scoped.snapshot(["enabled"]);
  reader.onChange(["enabled"], (change: types.ConfigurationReaderChange) => { void change; });
  reader.forView("one").forView().dispose(); void snapshot;
  // @ts-expect-error Host roots have no data reads.
  root.get(path);
  // @ts-expect-error Native roots no longer have data writers.
  root.set(path, true, { layer: "base" });
  // @ts-expect-error Native roots no longer have data writers.
  root.remove(path, { layer: "base" });
  await root.reloadProvider("p"); await root.flush(); await root.dispose();
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
type Command = Assert<Equal<z.output<typeof types.configurationMutationCommandSchema>, types.ConfigurationMutationCommand>>;
type MutationResult = Assert<Equal<z.output<typeof types.configurationMutationResultSchema>, types.ConfigurationMutationResult>>;
type MutationReceipt = Assert<Equal<z.output<typeof types.configurationMutationReceiptSchema>, types.ConfigurationMutationReceipt>>;
type MutationRevision = Assert<Equal<z.output<typeof types.configurationMutationRevisionSchema>, types.ConfigurationMutationRevision>>;
type Validation = Assert<Equal<z.output<typeof types.configurationValidationResponseSchema>, types.ConfigurationValidationResponse>>;
type JsonValue = Assert<Equal<z.output<typeof types.configurationValueSchema>, types.ConfigurationValue>>;
declare const host: ConfigurationServiceHostOptions;
declare const externalReader: import("@weaver-conf/config-registry").CanonicalSchemaRegistryReader;
// @ts-expect-error Callable reader injection is removed; hosts supply persisted data.
const invalidRegistryHost: ConfigurationServiceHostOptions = { registry: externalReader };
void invalidRegistryHost;
const hosted: Promise<ConfigurationService> = createConfigurationService(options, host);
declare const claims: types.TrustedPrincipalSnapshot;
const binding: ConfigurationServiceHostOptions = {
  ...host,
  onAuthorityReady(controller) {
    const token: types.ConfigurationAuthorityCapability = controller.mint(claims);
    const namespace = types.canonicalConfigurationPathSchema.parse("/example");
    const port: types.ConfigurationReader = controller.forIdentity(token, { identity: options.identity, namespace });
    const schemas: types.ConfigurationSchemaAuthorityRequest = controller.forSchemas(token);
    const metadata: types.SchemaSnapshot = schemas.snapshot();
    const page: types.SchemaIdentityPage = schemas.list({ limit: 1 });
    const detail: types.SchemaDetail = schemas.get("/example", "test", { ifRevision: schemas.revision });
    const registered: Promise<types.SchemaOperationResult> = schemas.register(options.schemas[0]!);
    void metadata; void page; void detail; void registered;
    const preparation: Promise<void> = port.prepare();
    const inspection: types.HydratedConfigurationInspection = port.inspect();
    const validation: types.ConfigurationValidationResponse = port.validate();
    const validationResult: types.SchemaValidationResult = validation.validation;
    // @ts-expect-error Validation is synchronous and performs no provider IO.
    const asynchronousValidation: Promise<types.ConfigurationValidationResponse> = port.validate();
    void validationResult; void asynchronousValidation;
    const mutations: types.ConfigurationMutationAuthority = controller.forMutations(token);
    const sessions: types.ConfigurationSessionAuthority = controller.forSessions(token);
    const activated: Promise<types.Result<types.ConfigurationSessionInfo, types.WeaverError>> = sessions.activate({ identity: options.identity, namespace, reason: "incident", emergency: false });
    const infos: readonly types.ConfigurationSessionInfo[] = sessions.list();
    const one: types.ConfigurationSessionInfo | null = sessions.get("opaque-selector");
    const extended: Promise<types.Result<types.ConfigurationSessionInfo, types.WeaverError>> = sessions.extend({ sessionId: "opaque-selector" });
    const deactivated: Promise<types.Result<types.ConfigurationSessionDeactivation, types.WeaverError>> = sessions.deactivate({ sessionId: "opaque-selector" });
    // @ts-expect-error Session metadata is not a provider or payload capability.
    one?.overrides;
    // @ts-expect-error Lifecycle ports do not supply a second data writer.
    sessions.setOverride("opaque-selector", "key", 1);
    // @ts-expect-error Readers cannot issue lifecycle authority.
    port.forSessions(token);
    void activated; void infos; void extended; void deactivated;
    const write: Promise<types.ConfigurationMutationResult> = mutations.apply([{ identity: options.identity, namespace, path: namespace, layer: "base", operation: "set", value: { count: 1 } }]);
    // @ts-expect-error Captured query ports no longer have data writers.
    port.set(namespace, 1, { layer: "base" });
    controller.revoke(token);
    controller.replace(token, claims);
    // @ts-expect-error Field-shaped objects cannot manufacture an opaque capability.
    controller.forIdentity({}, { identity: options.identity, namespace });
    // @ts-expect-error Mutable root principal binding has been removed.
    controller.bindRoot(token);
    // @ts-expect-error Old positional factory overload has been removed.
    controller.forIdentity(token, options.identity, namespace);
    // @ts-expect-error Captured grants are readonly.
    claims.grants[0]!.layers.push("other");
    void preparation; void inspection; void write;
  },
};
void hosted; void binding;
type SessionInfo = Assert<Equal<z.output<typeof types.configurationSessionInfoSchema>, types.ConfigurationSessionInfo>>;
type SessionPort = Assert<Equal<z.output<typeof types.configurationSessionAuthoritySchema>, types.ConfigurationSessionAuthority>>;
// @ts-expect-error Deprecated mode alias is removed rather than retained as authority.
type RetiredMode = types.SessionMode;
// @ts-expect-error Deprecated session alias is removed.
type RetiredSession = types.GodModeSession;
type Admission = Assert<Equal<z.output<typeof admissionContextSchema>, AdmissionContext>>;
type AdmissionInput = Assert<Equal<z.input<typeof admissionContextSchema>, unknown>>;
type RegistryBoundary = Assert<Equal<z.output<typeof admissionRegistrySchema>, AdmissionRegistry>>;
type MutationBoundary = Assert<Equal<z.output<typeof mutationSchema>, Mutation>>;
type PreparedBoundary = Assert<Equal<z.output<typeof preparedMutationSchema>, PreparedMutation>>;
declare const admission: AdmissionContext;
const prepared: PreparedMutation = prepareConfigMutation(admission);
if (prepared.success) { const entries: Record<string, unknown> = prepared.layerAfter; void entries; }
