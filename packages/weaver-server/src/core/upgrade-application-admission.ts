import {
  canonicalInternalJson,
  createWeaverError,
  internalConfigurationSchema,
  type LayerEnvelope,
  layerCommitRequestSchema,
  type ProviderInventory,
  type ProviderRevision,
  providerInventorySchema,
  type UpgradeActivation,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { activationCompletionOperationId } from "./activation-completion-operation";
import type { ConfigServiceController } from "./config-service-controller";
import {
  assertConstructedFinalContexts,
  type ValidatedFinalContexts,
} from "./final-context-evidence";
import { releasePinnedRecoveryContext } from "./pinned-recovery-context";
import { filterProtectedConfigEntries } from "./protected-config-paths";
import type { TerminalControlSnapshot } from "./terminal-control-authority";

export interface UpgradeApplicationAdmission {
  readonly fresh: (
    contexts: ValidatedFinalContexts,
    control: TerminalControlSnapshot,
  ) => Promise<void>;
  readonly terminal: (
    control: TerminalControlSnapshot,
    contexts?: ValidatedFinalContexts,
  ) => Promise<void>;
}

interface AuthorityRead {
  readonly provider: ConfigServiceController["providers"][number];
  readonly inventory: ProviderInventory;
  readonly envelopes: readonly LayerEnvelope[];
}

/** Admission owns the last authority read and synchronous install/open boundary. */
export function createUpgradeApplicationAdmission(
  host: ConfigServiceController,
  markReady: () => void,
): UpgradeApplicationAdmission {
  const open = (
    control: TerminalControlSnapshot,
    contexts?: ValidatedFinalContexts,
  ) => {
    if (contexts)
      host.installUpgradeSnapshot(
        contexts,
        host.pipeline.contracts.prepare(control.state),
      );
    host.maintenance.resume();
    releasePinnedRecoveryContext(host);
    markReady();
  };
  const admit = (
    control: TerminalControlSnapshot,
    contexts?: ValidatedFinalContexts,
  ) =>
    host.coordinator.run(async () => {
      host.assertReady(true);
      const verification = await readVerification(host, control, contexts);
      verification();
      open(control, contexts);
    });
  return {
    fresh: (contexts, control) => admit(control, contexts),
    terminal: (control, contexts) => admit(control, contexts),
  };
}

async function readVerification(
  host: ConfigServiceController,
  control: TerminalControlSnapshot,
  contexts?: ValidatedFinalContexts,
): Promise<() => void> {
  if (contexts) assertConstructedFinalContexts(contexts);
  const reads = await Promise.all(
    host.providers.map(async (provider) => {
      const authority = provider.authority;
      if (!authority) failAuthority();
      const inventory = providerInventorySchema.parse(
        await authority.inventory(),
      );
      const envelopes = await Promise.all(
        inventory.revisions.map((revision) =>
          authority.readLayer(revision.layer),
        ),
      );
      return { provider, inventory, envelopes };
    }),
  );
  return () => verify(host, control, contexts, reads);
}

function verify(
  host: ConfigServiceController,
  control: TerminalControlSnapshot,
  contexts: ValidatedFinalContexts | undefined,
  reads: readonly AuthorityRead[],
): void {
  const controlProvider = host.pipeline.controlProvider;
  const current = reads.find((item) => item.provider.id === control.providerId);
  const controlEnvelope = current?.envelopes.find(
    (item) => item?.layer === control.envelope.layer,
  );
  if (!controlEnvelope || !sameEnvelope(controlEnvelope, control.envelope))
    failAuthority();
  assertDurableBinding(control, contexts);
  if (contexts)
    assertApplicationAuthorities(controlProvider.id, contexts, reads);
}

function assertDurableBinding(
  control: TerminalControlSnapshot,
  contexts?: ValidatedFinalContexts,
): void {
  if (
    !internalConfigurationSchema.safeParse(control.envelope.entries._weaver)
      .success
  )
    failAuthority();
  if (!contexts) return;
  const journal = control.state.upgrades.journal[contexts.binding.runId];
  const activation = journal?.activation;
  if (
    !activation ||
    activation.status !== "complete" ||
    !exactCompletionReceipt(control, journal.runId, activation) ||
    canonicalInternalJson(activation.finalContexts) !==
      canonicalInternalJson(contexts.binding)
  )
    failAuthority();
}

function exactCompletionReceipt(
  control: TerminalControlSnapshot,
  runId: string,
  activation: Extract<UpgradeActivation, { status: "complete" }>,
): boolean {
  const receipt = control.envelope.lastCommit;
  const operationId = activationCompletionOperationId(runId);
  return (
    !!receipt &&
    receipt.operationId === operationId &&
    sameRevision(receipt.previousRevision, activation.receipt.revision) &&
    sameRevision(receipt.revision, control.envelope) &&
    receipt.mutationDigest ===
      computeProviderMutationDigest(
        layerCommitRequestSchema.parse({
          layer: control.envelope.layer,
          expectedRevision: activation.receipt.revision,
          operationId,
          mutation: { action: "set", key: "_weaver", value: control.state },
        }),
      )
  );
}

function assertApplicationAuthorities(
  controlId: string,
  contexts: ValidatedFinalContexts,
  reads: readonly AuthorityRead[],
): void {
  const expected = expectedApplicationLayers(contexts);
  if (
    reads.reduce((count, item) => count + item.envelopes.length, 0) !==
    expected.size
  )
    failAuthority();
  for (const item of reads)
    assertAuthorityRead(controlId, contexts, expected, item);
}

function expectedApplicationLayers(contexts: ValidatedFinalContexts) {
  return new Map(
    contexts.binding.layers.map((layer) => [
      canonicalInternalJson([layer.providerId, layer.revision.layer]),
      layer,
    ]),
  );
}

function assertAuthorityRead(
  controlId: string,
  contexts: ValidatedFinalContexts,
  expected: ReturnType<typeof expectedApplicationLayers>,
  item: AuthorityRead,
): void {
  for (const envelope of item.envelopes)
    assertAuthorityEnvelope(controlId, contexts, expected, item, envelope);
}

function assertAuthorityEnvelope(
  controlId: string,
  contexts: ValidatedFinalContexts,
  expected: ReturnType<typeof expectedApplicationLayers>,
  item: AuthorityRead,
  envelope: LayerEnvelope,
): void {
  const inventoryRevision = item.inventory.revisions.find(
    (revision) => revision.layer === envelope.layer,
  );
  if (!inventoryRevision || !sameRevision(envelope, inventoryRevision))
    failAuthority();
  const binding = expected.get(
    canonicalInternalJson([item.provider.id, envelope.layer]),
  );
  const source = sourceEntries(
    contexts,
    item.provider.id,
    envelope.layer,
    envelope.layer === item.provider.layer,
  );
  if (!binding || !source || binding.namespace !== namespace(item.provider))
    failAuthority();
  if (
    item.provider.id !== controlId &&
    !sameRevision(envelope, binding.revision)
  )
    failAuthority();
  const observed = applicationEntries(
    item.provider.id,
    controlId,
    envelope.entries,
  );
  const prior = applicationEntries(item.provider.id, controlId, source);
  if (canonicalInternalJson(observed) !== canonicalInternalJson(prior))
    failAuthority();
}

function applicationEntries(
  providerId: string,
  controlId: string,
  entries: Readonly<Record<string, unknown>>,
) {
  return providerId === controlId
    ? filterProtectedConfigEntries(entries)
    : entries;
}

function sourceEntries(
  contexts: ValidatedFinalContexts,
  providerId: string,
  layer: string,
  base: boolean,
): Readonly<Record<string, unknown>> | undefined {
  return base
    ? contexts.base.find((item) => item.id === providerId)?.entries
    : contexts.scoped.find((item) => item.id === layer)?.entries;
}

function namespace(
  provider: ConfigServiceController["providers"][number],
): string {
  const capabilities = provider.authority?.capabilities;
  if (!capabilities || !("namespace" in capabilities)) failAuthority();
  return capabilities.namespace;
}

function sameEnvelope(left: LayerEnvelope, right: LayerEnvelope) {
  return (
    sameRevision(left, right) &&
    canonicalInternalJson(left.entries) === canonicalInternalJson(right.entries)
  );
}

function sameRevision(left: ProviderRevision, right: ProviderRevision) {
  return (
    left.storeId === right.storeId &&
    left.environment === right.environment &&
    left.layer === right.layer &&
    left.epoch === right.epoch &&
    left.sequence === right.sequence
  );
}

function failAuthority(): never {
  throw createWeaverError(
    "VALIDATION_ERROR",
    "Terminal application authority is missing, malformed, or divergent",
  );
}
