import type {
  KnowledgeExtractor,
  KnowledgePack,
  PresentationPack,
  TurnContext,
  PackHelpers,
} from "../src/knowledgeTypes.ts";

/**
 * Minimal KnowledgeExtractor fixture for pack loader tests.
 * Returns one candidate per turn with a claim kind and "new" disposition.
 */
export const fictionalExtractor: KnowledgeExtractor = {
  id: "fictional-extractor",
  version: "0.1.0",
  async extractCandidates(turn: TurnContext, _helpers: PackHelpers) {
    if (turn.narrative.length === 0) return [];
    return [
      {
        id: `turn-${turn.turnIndex}-${Date.now()}`,
        kind: "claim",
        status: "candidate",
        disposition: "new",
        scope: {
          space: "test-space",
          subjects: ["test-subject"],
          topics: ["test:observation"],
          contexts: [],
          dimensions: {},
        },
        pack: { id: "fictional-extractor", version: "0.1.0" },
        sources: [],
        session: turn.session,
        submittedAt: turn.timestamp,
        statement: `Extracted from turn ${turn.turnIndex}: ${turn.narrative.slice(0, 100)}`,
      },
    ];
  },
};

/**
 * Minimal external KnowledgePack + PresentationPack fixture. Exports both
 * interfaces so it type-checks as the intersection `resolveCliPack` returns,
 * and its `validateEnvelope` accepts every envelope so a candidate carrying
 * its pack id is submitted rather than rejected. Used to pin that a space
 * declaring an external pack via `installed_packs[].from` is resolved by
 * `knowledge submit` instead of failing as `pack_unknown`.
 */
export const externalDemo: KnowledgePack & PresentationPack & KnowledgeExtractor = {
  id: "external-demo",
  version: "0.1.0",
  validateEnvelope: () => ({ ok: true, value: undefined }),
  relatedQuery: (envelope) => envelope.statement ?? "external query",
  reconcile: () => ({ ok: true, value: { disposition: "new", summary: "synthetic", mutations: [] } }),
  retrievalPolicy: {
    allowedSourceClasses: ["all"],
    queryStrategy: (input) => input.query,
    classifySource: (source) => source.type,
    relevanceThreshold: null,
    isEligible: (record) => record.status === "active",
    includePresentations: false,
  },
  views: [],
  audiences: [],
  deliveries: [],
  async extractCandidates() {
    return [];
  },
};
export const miskeyedExtractor: KnowledgeExtractor = {
  id: "declared-extractor-a",
  version: "0.1.0",
  async extractCandidates() {
    return [];
  },
};

/**
 * Default export whose declared id/version intentionally differ from a binding
 * request for fictional-integrity@0.1.0. A loader must refuse it as
 * pack_identity_mismatch rather than accept a mismatched identity: the default
 * export is found by the requested id lookup but fails the exact identity
 * check on both id and version.
 */
const mismatchedIdentity: KnowledgePack & PresentationPack = {
  id: "fictional-integrity",
  version: "9.9.9",
  validateEnvelope: () => ({ ok: true, value: undefined }),
  relatedQuery: (envelope) => envelope.statement ?? "mismatched query",
  reconcile: () => ({ ok: true, value: { disposition: "new", summary: "synthetic", mutations: [] } }),
  retrievalPolicy: {
    allowedSourceClasses: ["all"],
    queryStrategy: (input) => input.query,
    classifySource: (source) => source.type,
    relevanceThreshold: null,
    isEligible: (record) => record.status === "active",
    includePresentations: false,
  },
  views: [],
  audiences: [],
  deliveries: [],
};

export default mismatchedIdentity;
