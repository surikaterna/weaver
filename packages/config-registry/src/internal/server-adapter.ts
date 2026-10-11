import { createWeaverError } from "@weaver-conf/config-types";
import { buildIdentityIndex, type IdentityRef } from "../identity-index";
import { SchemaIdentityPages } from "../identity-pages";
import { evaluateRegistration } from "../registration-evaluation";
import { guardRegistrationInput } from "../registration-parser";
import type {
  CanonicalSchemaRegistryOptions,
  CanonicalSchemaRegistryReader,
  RegistryProjectionReader,
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
} from "../registry-contracts";
import {
  createRegistryProjectionReader,
  createRegistryReader,
} from "../registry-read";
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
  readonly preview: RegistryProjectionReader | undefined;
  readonly environment: string | undefined;
  readonly context: SchemaRegistrationContext | undefined;
  publish(): void;
}

export interface RegistryAdapter {
  readonly reader: CanonicalSchemaRegistryReader;
  readonly revision: number;
  snapshot(): RegistryState;
  prepare(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
    fallbackEnvironment?: string,
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
    get revision() {
      return authority.revision;
    },
    snapshot: () => authority.snapshot(),
    prepare: (request, context, fallbackEnvironment) =>
      authority.prepare(request, context, fallbackEnvironment),
  };
}

class RegistryAuthority {
  private state: RegistryState;
  private readonly pages: SchemaIdentityPages;
  private generation = 0;
  private readonly defaultEnvironment: string;
  readonly reader: CanonicalSchemaRegistryReader;

  constructor(
    options: CanonicalSchemaRegistryOptions,
    initialState: RegistryState,
    entropy?: () => Uint8Array,
  ) {
    this.state = structuredClone(initialState);
    this.defaultEnvironment = options.defaultEnvironment;
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

  get revision(): number {
    return this.generation;
  }

  snapshot(): RegistryState {
    return structuredClone(this.state);
  }

  prepare(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
    fallbackEnvironment?: string,
  ): PreparedRegistration {
    const input = guardRegistrationInput(request, context, fallbackEnvironment);
    if (!input.success) return rejectedPreparation(input.result);
    const evaluation = evaluateRegistration(
      this.state,
      input.request,
      input.context,
    );
    const result = detachedResult(evaluation.result);
    if (!result.success) return rejectedPreparation(result);
    const candidate = cloneState(this.state);
    applyEvaluation(candidate, evaluation);
    const index = buildIdentityIndex(candidate);
    this.pages.assertCanPublish();
    const expectedGeneration = this.generation;
    return {
      result,
      preview: createRegistryProjectionReader(
        () => candidate,
        this.defaultEnvironment,
      ),
      environment: input.request.environment,
      context: input.context,
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

function rejectedPreparation(
  result: SchemaRegistrationResult,
): PreparedRegistration {
  return {
    result,
    candidate: undefined,
    preview: undefined,
    environment: undefined,
    context: undefined,
    publish() {},
  };
}

function detachedResult(
  result: SchemaRegistrationResult,
): SchemaRegistrationResult {
  if (!result.success) return result;
  return structuredClone(result);
}
