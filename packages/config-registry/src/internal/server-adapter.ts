import { createWeaverError } from "@weaver-conf/config-types";
import { buildIdentityIndex, type IdentityRef } from "../identity-index";
import { SchemaIdentityPages } from "../identity-pages";
import { evaluateRegistration } from "../registration-evaluation";
import type {
  CanonicalSchemaRegistryOptions,
  CanonicalSchemaRegistryReader,
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
} from "../registry-contracts";
import { createRegistryReader } from "../registry-read";
import {
  applyEvaluation,
  cloneState,
  createEmptyState,
  type RegistryState,
} from "../registry-state";

export { buildIdentityIndex } from "../identity-index";
export { SchemaIdentityPages } from "../identity-pages";
export type { RegistryState, SchemaEntry } from "../registry-state";
export {
  cloneState,
  createEmptyState,
  registryStateSchema,
  schemaEntrySchema,
  schemaKey,
} from "../registry-state";

export interface PreparedRegistration {
  readonly result: SchemaRegistrationResult;
  readonly candidate: RegistryState | undefined;
  publish(): void;
}

export interface RegistryAdapter {
  readonly reader: CanonicalSchemaRegistryReader;
  prepare(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
  ): PreparedRegistration;
}

// Entropy injection is confined to this deliberate host integration/test boundary.
export function createRegistryAdapter(
  options: CanonicalSchemaRegistryOptions,
  initialState = createEmptyState(),
  entropy?: () => Uint8Array,
): RegistryAdapter {
  const authority = new RegistryAuthority(options, initialState, entropy);
  return {
    reader: authority.reader,
    prepare: (request, context) => authority.prepare(request, context),
  };
}

class RegistryAuthority {
  private state: RegistryState;
  private readonly pages: SchemaIdentityPages;
  private generation = 0;
  readonly reader: CanonicalSchemaRegistryReader;

  constructor(
    options: CanonicalSchemaRegistryOptions,
    initialState: RegistryState,
    entropy?: () => Uint8Array,
  ) {
    this.state = structuredClone(initialState);
    this.pages = new SchemaIdentityPages(
      this.state,
      options.schemaIdentityMaxPageSize ?? 200,
      entropy,
    );
    this.reader = createRegistryReader(
      () => this.state,
      this.pages,
      options.defaultEnvironment,
    );
  }

  prepare(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
  ): PreparedRegistration {
    const evaluation = evaluateRegistration(this.state, request, context);
    const result = detachedResult(evaluation.result);
    if (!result.success) return { result, candidate: undefined, publish() {} };
    const candidate = cloneState(this.state);
    applyEvaluation(candidate, evaluation);
    const index = buildIdentityIndex(candidate);
    this.pages.assertCanPublish();
    const expectedGeneration = this.generation;
    return {
      result,
      // Pure synchronous registrations need no persistence snapshot traversal.
      get candidate() {
        return structuredClone(candidate);
      },
      publish: () => this.publish(candidate, index, expectedGeneration),
    };
  }

  private publish(
    candidate: RegistryState,
    index: ReadonlyArray<IdentityRef>,
    expectedGeneration: number,
  ): void {
    if (this.generation !== expectedGeneration)
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Prepared registration is stale",
      );
    this.pages.assertCanPublish();
    this.state = candidate;
    this.pages.publish(index);
    this.generation++;
  }
}

function detachedResult(
  result: SchemaRegistrationResult,
): SchemaRegistrationResult {
  if (!result.success) return result;
  return structuredClone(result);
}
