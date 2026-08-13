// Generic knowledge boundary. This file contains only the
// envelope and pack contract types; it deliberately has no filesystem, qmd,
// registry, hashing, or transaction imports.

export const KNOWLEDGE_KINDS = [
  "evidence",
  "claim",
  "interpretation",
  "decision",
  "recommendation",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = ["candidate", "active", "contested", "retired"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_DISPOSITIONS = ["new", "support", "contradict", "refine", "supersede", "no-change"] as const;
export type KnowledgeDisposition = (typeof KNOWLEDGE_DISPOSITIONS)[number];

export const RELATIONSHIP_KINDS = ["supports", "contradicts", "refines", "supersedes"] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type KnowledgePackRef = {
  id: string;
  version: string;
};

export type KnowledgeScope = {
  space: string;
  subjects: string[];
  topics: string[];
  contexts: string[];
  dimensions: Record<string, string[]>;
};

export type KnowledgeSource = {
  type: string;
  ref: string;
};

export type HostSessionProvenance = {
  id: string;
  host: string;
};

export type KnowledgeEnvelope = {
  id: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  statement: string;
  details: JsonObject;
  scope: KnowledgeScope;
  pack: KnowledgePackRef;
  sources: KnowledgeSource[];
  session: HostSessionProvenance;
  submittedAt: string;
  disposition: KnowledgeDisposition;
};

export type KnowledgeRelationships = {
  supports: string[];
  contradicts: string[];
  refines: string[];
  supersedes: string[];
};

export type KnowledgeHistoryEntry = {
  event: string;
  relatedId: string;
  submittedAt: string;
};

export type KnowledgeRecord = KnowledgeEnvelope & {
  schemaVersion: 0;
  relationships: KnowledgeRelationships;
  history: KnowledgeHistoryEntry[];
};

export type KnowledgeErrorKind =
  | "validation"
  | "retrieval"
  | "plan"
  | "approval"
  | "transaction"
  | "lock"
  | "authorization"
  | "presentation"
  | "artifact";

export type KnowledgeError = {
  kind: KnowledgeErrorKind;
  code: string;
  field?: string;
  message: string;
};

export type KnowledgeResult<T> = { ok: true; value: T } | { ok: false; errors: KnowledgeError[] };

export type RelatedKnowledgeRecord = {
  record: KnowledgeRecord;
  relativePath: string;
  sourceUri: string;
};

export type PackReconcileInput = {
  candidate: KnowledgeEnvelope;
  related: readonly KnowledgeRecord[];
};

export type PackMutation = {
  action: "create" | "update";
  record: KnowledgeRecord;
};

export type PackReconciliation = {
  disposition: KnowledgeDisposition;
  summary: string;
  mutations: PackMutation[];
};

export type KnowledgePack = {
  id: string;
  version: string;
  validateEnvelope: (envelope: KnowledgeEnvelope) => KnowledgeResult<void>;
  relatedQuery: (envelope: KnowledgeEnvelope) => string;
  reconcile: (input: PackReconcileInput) => KnowledgeResult<PackReconciliation>;
};

export type QueryStrategyInput = {
  query: string;
  viewId?: string;
  requestedSourceClasses: readonly string[];
};

export type SourceClassPolicy = {
  allowedSourceClasses: readonly string[];
  queryStrategy: (input: QueryStrategyInput) => string;
  classifySource: (source: KnowledgeSource) => string;
  relevanceThreshold: number | null;
  isEligible: (record: KnowledgeRecord) => boolean;
  includePresentations: false;
};

export type SemanticProjection = {
  title: string;
  summary: string;
  facts: string[];
  requiredFacts: string[];
  uncertainty: string[];
  actions: string[];
  recommendationIds: string[];
};

export type PresentationDraft = {
  title: string;
  summary: string;
  facts: string[];
  uncertainty: string[];
  actions: string[];
  recommendationIds: string[];
};

export type ViewDefinition = {
  id: string;
  version: number;
  // "search" runs the pack's declared query strategy over ranked qmd
  // results. "space" enumerates every Markdown record under the active
  // space's records root instead: no query, no ranking, no relevance
  // threshold. A profile view is an enumeration; guarded retrieval over a
  // search is a different operation, and no literal query stands in for
  // "every active record" reliably. Required, not defaulted, so a view
  // author cannot omit the most consequential thing about their view.
  scope: "search" | "space";
  retrievalQuery: (requestedQuery?: string) => string;
  project: (records: readonly KnowledgeRecord[]) => SemanticProjection;
};

export type AudienceAdaptationInput = {
  projection: SemanticProjection;
  delivery: DeliveryDefinition;
  records: readonly KnowledgeRecord[];
};

export type AudienceDefinition = {
  id: string;
  version: number;
  authorize: (record: KnowledgeRecord) => boolean;
  adapt: (input: AudienceAdaptationInput) => PresentationDraft;
};

export type DeliveryDefinition = {
  id: string;
  version: number;
  format: "markdown" | "plain" | "json";
  maxWords: number;
  retain: boolean;
};

export type TurnToolCall = {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
};

export type TurnContext = {
  session: HostSessionProvenance;
  turnIndex: number;
  timestamp: string;
  narrative: string;
  toolCalls: TurnToolCall[];
};

export type LlmHelper = {
  complete(prompt: string, options?: { system?: string }): Promise<string>;
};

export type PackHelpers = {
  llm?: LlmHelper;
};

/**
 * Async, LLM-backed candidate extraction from raw session transcripts.
 *
 * Called by the host integration at a lifecycle-triggered capture point,
 * once the host determines the session (or turn) is complete.
 * This is separate from the synchronous KnowledgePack interface used by
 * the transaction pipeline — extraction is non-deterministic and may use
 * LLM inference.
 *
 * External pack repos implement this interface. The pack is injected via
 * the binding's `installed_packs[].from` path.
 */
export type KnowledgeExtractor = {
  id: string;
  version: string;
  extractCandidates(turn: TurnContext, helpers: PackHelpers): Promise<Record<string, unknown>[]>;
};

export type PresentationPack = {
  id: string;
  version: string;
  retrievalPolicy: SourceClassPolicy;
  views: readonly ViewDefinition[];
  audiences: readonly AudienceDefinition[];
  deliveries: readonly DeliveryDefinition[];
};
