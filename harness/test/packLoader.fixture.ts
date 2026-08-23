import { join } from "node:path";
import type {
  JsonObject,
  KnowledgeEnvelope,
  KnowledgeExtractor,
  KnowledgePack,
  KnowledgeRecord,
  PresentationPack,
  TurnContext,
  TurnToolCall,
  PackHelpers,
} from "../src/knowledgeTypes.ts";
import type { ArtifactReplacementResult, HostCapturePreview } from "../src/captureTypes.ts";

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
  selectRelatedRecords: (envelope) => {
    const target = envelope.details.fixture_target;
    if (typeof target === "string") {
      return { mode: "exact", description: `record ${target}`, matches: (record) => record.id === target };
    }
    return { mode: "search", query: envelope.statement ?? "external query" };
  },
  reconcile: ({ candidate, related }) => {
    if (candidate.details.fixture_action === "create") {
      const recordId = typeof candidate.details.fixture_record_id === "string"
        ? candidate.details.fixture_record_id
        : `${candidate.id}-record`;
      const record: KnowledgeRecord = {
        ...candidate,
        id: recordId,
        status: "active",
        schemaVersion: 0,
        relationships: { supports: [], contradicts: [], refines: [], supersedes: [] },
        history: [],
      };
      return { ok: true, value: { disposition: "new", summary: "fixture create", mutations: [{ action: "create" as const, record }] } };
    }
    const target = related[0];
    if (target === undefined) {
      return {
        ok: false,
        errors: [{ kind: "plan", code: "fixture_target_missing", message: "fixture update found no related record" }],
      };
    }
    const note = typeof candidate.details.fixture_note === "string" ? candidate.details.fixture_note : "";
    const priorNotes = target.details.fixture_notes;
    const updated: KnowledgeRecord = {
      ...target,
      details: {
        ...target.details,
        fixture_notes: [...(Array.isArray(priorNotes) ? priorNotes : []), note],
      },
      history: [
        ...target.history,
        { event: "fixture-update", relatedId: candidate.id, submittedAt: candidate.submittedAt },
      ],
    };
    return { ok: true, value: { disposition: candidate.disposition, summary: "fixture update", mutations: [{ action: "update" as const, record: updated }] } };
  },
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
export const captureInvocations: Array<{
  sessionId: string;
  narrative: string;
  turnIndex: number;
  toolCalls: TurnToolCall[];
  spaceId: string;
  recordsRoot: string;
  projectRoot: string;
  hasWriteFile: boolean;
  hasRefreshIndex: boolean;
  hasComplete: boolean;
}> = [];

/** Completion requests the fixture asked the host to run, in order. */
export const completionRequests: Array<{
  model: string;
  prompt: string;
  system: string;
  timeoutSeconds: number;
}> = [];

/** Completion outcomes observed by the fixture, in order. */
export const completionOutcomes: string[] = [];

/** Completion failures observed by the fixture, in order. */
export const completionErrors: string[] = [];

/** Clear every ambient-capture observation between tests. */
export function resetCaptureFixtures(): void {
  captureInvocations.length = 0;
  completionRequests.length = 0;
  completionOutcomes.length = 0;
  completionErrors.length = 0;
}

type FixtureCaptureTools = {
  spaceId: string;
  recordsRoot: string;
  projectRoot: string;
  writeFile(path: string, content: string): Promise<void>;
  refreshIndex(): Promise<void>;
  complete(request: {
    model: string;
    prompt: string;
    system: string;
    timeoutSeconds: number;
  }): Promise<string>;
};

export async function captureFromTurn(
  turn: TurnContext,
  tools: FixtureCaptureTools,
): Promise<{ created: string[]; existing: string[]; invalid: []; warnings: string[] }> {
  captureInvocations.push({
    narrative: turn.narrative,
    sessionId: turn.session.id,
    turnIndex: turn.turnIndex,
    toolCalls: turn.toolCalls,
    spaceId: tools.spaceId,
    recordsRoot: tools.recordsRoot,
    projectRoot: tools.projectRoot,
    hasWriteFile: typeof tools.writeFile === "function",
    hasRefreshIndex: typeof tools.refreshIndex === "function",
    hasComplete: typeof tools.complete === "function",
  });
  if (turn.narrative.includes("linked-write")) {
    await tools.writeFile(join(tools.recordsRoot, "linked", "probe.md"), "probe");
  }
  if (turn.narrative.includes("run-completion")) {
    // A sub-second deadline proves the bounded timer fires without making the
    // suite wait out a realistic 60-second budget.
    const request = {
      model: "synthetic/provider-model",
      prompt: "synthetic extraction prompt",
      system: "",
      timeoutSeconds: turn.narrative.includes("fast-deadline") ? 0.05 : 60,
    };
    completionRequests.push(request);
    try {
      completionOutcomes.push(await tools.complete(request));
    } catch (error) {
      // The pack owns failure policy: a completion failure produces a warning
      // and no draft. There is no deterministic fallback.
      completionErrors.push(String(error));
      return { created: [], existing: [], invalid: [], warnings: [String(error)] };
    }
  }
  return { created: ["fixture-draft"], existing: [], invalid: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Structured capture fixture surface: previewStructuredCapture returns the
// candidate plus a public preview; the host extension must retain the
// candidate privately and expose only the mutation summary.
// ---------------------------------------------------------------------------

export function fixtureCandidate(changeSet: JsonObject): KnowledgeEnvelope {
  const target = changeSet.target;
  return {
    id: `structured-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "claim",
    status: "candidate",
    disposition: "new",
    scope: {
      space: typeof changeSet.space === "string" ? changeSet.space : "external-fixture-space",
      subjects: [],
      topics: ["test:structured"],
      contexts: [],
      dimensions: {},
    },
    pack: { id: "external-demo", version: "0.1.0" },
    sources: [{ type: "engram-capture-tool", ref: "structured-change-set" }],
    session: { id: typeof changeSet.session_id === "string" ? changeSet.session_id : "pending", host: "omp" },
    submittedAt: new Date().toISOString(),
    details: {
      fixture_target: typeof target === "string" ? target : "",
      fixture_note: typeof changeSet.note === "string" ? changeSet.note : "",
    },
    statement: typeof changeSet.note === "string" ? changeSet.note : "structured fixture observation",
  };
}

export type FixturePreviewTools = {
  previewCandidate(candidate: KnowledgeEnvelope): Promise<HostCapturePreview>;
};

export async function previewStructuredCapture(changeSet: JsonObject, tools: FixturePreviewTools) {
  const candidate = fixtureCandidate(changeSet);
  const host = await tools.previewCandidate(candidate);
  if (host.status === "blocked") return { schemaVersion: 0, status: "blocked" as const, errors: host.errors };
  return {
    schemaVersion: 0,
    status: "ready" as const,
    planHash: host.planHash,
    candidate,
    changes: host.mutations.map((mutation) => ({ recordId: mutation.recordId, action: mutation.action })),
    artifacts: ["generated/status-view.yaml"],
  };
}

export type FixtureMaterializeTools = {
  listRecords(): Promise<KnowledgeRecord[]>;
  replaceArtifact(request: { root: string; relativePath: string; content: string }): Promise<ArtifactReplacementResult>;
  projectRoot: string;
  appliedAt: string;
};

let materializeFailuresRemaining = 0;

/** Stage N injected materialization failures for retry testing. */
export function stageMaterializeFailure(count: number): void {
  materializeFailuresRemaining = count;
}

export const materializeInvocations: Array<{ planHash: string }> = [];

export async function materialize(
  appliedPlan: { planHash: string; mutations: Array<{ recordId: string; action: string }> },
  tools: FixtureMaterializeTools,
): Promise<{ written: ArtifactReplacementResult[]; unchanged: ArtifactReplacementResult[]; stale: Array<{ path: string; reason: string }> }> {
  materializeInvocations.push({ planHash: appliedPlan.planHash });
  if (materializeFailuresRemaining > 0) {
    materializeFailuresRemaining -= 1;
    throw new Error("injected materialization failure");
  }
  const records = await tools.listRecords();
  const written = await tools.replaceArtifact({
    root: tools.projectRoot,
    relativePath: "generated/status-view.yaml",
    content: `# generated from plan ${appliedPlan.planHash} at ${tools.appliedAt} over ${records.length} records\n`,
  });
  return { written: [written], unchanged: [], stale: [] };
}
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
  selectRelatedRecords: (envelope) => ({ mode: "search", query: envelope.statement ?? "mismatched query" }),
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
