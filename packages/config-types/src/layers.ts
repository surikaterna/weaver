import type { MergeFunction } from "./merge-types";
import type {
  ConfigurationChange,
  ConfigurationStorageProvider,
} from "./providers";
import type { ScopeDefinition } from "./types";

// --- Core interfaces ---

/** Resolution context passed to layer resolvers */
export interface ResolutionContext {
  readonly scopeId?: string | undefined;
  readonly scopeValue?: string | undefined;
  readonly userId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly scopeInstances?: ReadonlyMap<string, string> | undefined;
  readonly [key: string]: unknown;
}

/** Data returned by a layer resolver */
export interface LayerData {
  readonly layerId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly revision?: string | undefined;
}

/** Runtime resolver created by a LayerType */
export interface LayerResolver {
  resolve(context: ResolutionContext): Promise<LayerData[]>;
  onChange?(cb: (changes: ConfigurationChange[]) => void): () => void;
  dispose?(): void;
}

/** The contract for a layer type implementation */
export interface LayerType {
  readonly id: string;
  readonly persistent: boolean;
  readonly defaultMerge: MergeFunction;
  createResolver(
    provider: ConfigurationStorageProvider,
    config: unknown,
  ): LayerResolver;
}

/** A bound layer definition — name + type + config */
export interface LayerDefinition<N extends string = string> {
  readonly name: N;
  readonly type: LayerType;
  readonly config: unknown;
}

// --- Config for built-in layer types ---

/** Configuration for a static (non-scoped) layer. */
export interface StaticLayerConfig {
  readonly merge?: MergeFunction | undefined;
}

/** Configuration for a dynamic (scope-aware) layer. */
export interface DynamicLayerConfig {
  readonly scopes?: readonly ScopeDefinition[] | undefined;
  readonly merge?: MergeFunction | undefined;
}

/** Configuration for a personal (per-user) layer. */
export interface PersonalLayerConfig {
  readonly merge?: MergeFunction | undefined;
}

/** Configuration for an ephemeral (non-persistent, in-memory) layer. */
export interface EphemeralLayerConfig {
  readonly merge?: MergeFunction | undefined;
}
