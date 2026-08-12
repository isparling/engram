// A deliberately small fictional pack. It supplies only envelope checks,
// query construction, and reconciliation policy. It does not know how records
// are stored, how qmd runs, how approval works, or how a transaction commits.

import type {
  KnowledgeEnvelope,
  KnowledgePack,
  KnowledgeRecord,
  KnowledgeResult,
  KnowledgeRelationships,
  PresentationPack,
  PackReconciliation,
  PackReconcileInput,
} from "../src/knowledgeTypes.ts";

function unique(values: string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function withRelationship(record: KnowledgeRecord, relationship: keyof KnowledgeRelationships, relatedId: string): KnowledgeRecord {
  return {
    ...record,
    relationships: {
      ...record.relationships,
      [relationship]: unique(record.relationships[relationship], relatedId),
    },
  };
}

function withHistory(record: KnowledgeRecord, event: string, relatedId: string, submittedAt: string): KnowledgeRecord {
  return {
    ...record,
    history: [...record.history, { event, relatedId, submittedAt }],
  };
}

function candidateRecord(envelope: KnowledgeEnvelope, status: KnowledgeRecord["status"], relationships: KnowledgeRelationships): KnowledgeRecord {
  return {
    schemaVersion: 0,
    ...envelope,
    status,
    relationships,
    history: [],
  };
}

function requiresRelated(input: PackReconcileInput): KnowledgeRecord | undefined {
  return input.related[0];
}

function missingRelated(): KnowledgeResult<PackReconciliation> {
  return {
    ok: false,
    errors: [{ kind: "plan", code: "related_record_required", message: "this disposition requires one related current record" }],
  };
}

function reconcile(input: PackReconcileInput): KnowledgeResult<PackReconciliation> {
  const submitted = input.candidate;
  const related = requiresRelated(input);

  if (submitted.disposition === "new") {
    return {
      ok: true,
      value: {
        disposition: submitted.disposition,
        summary: "create a new synthetic candidate record",
        mutations: [{ action: "create", record: candidateRecord(submitted, submitted.status, { supports: [], contradicts: [], refines: [], supersedes: [] }) }],
      },
    };
  }
  if (submitted.disposition === "no-change") {
    return { ok: true, value: { disposition: submitted.disposition, summary: "no durable change is requested", mutations: [] } };
  }
  if (related === undefined) return missingRelated();

  if (submitted.disposition === "support") {
    const revisedCandidate = candidateRecord(submitted, "active", { supports: [related.id], contradicts: [], refines: [], supersedes: [] });
    return {
      ok: true,
      value: {
        disposition: submitted.disposition,
        summary: `support ${related.id} with a retained related candidate`,
        mutations: [
          { action: "update", record: withRelationship(related, "supports", submitted.id) },
          { action: "create", record: revisedCandidate },
        ],
      },
    };
  }

  if (submitted.disposition === "contradict") {
    let contested = withRelationship(related, "contradicts", submitted.id);
    contested = { ...contested, status: "contested" };
    contested = withHistory(contested, "contested-by", submitted.id, submitted.submittedAt);
    const revisedCandidate = candidateRecord(submitted, "active", { supports: [], contradicts: [related.id], refines: [], supersedes: [] });
    return {
      ok: true,
      value: {
        disposition: submitted.disposition,
        summary: `contest ${related.id} while retaining its history`,
        mutations: [
          { action: "update", record: contested },
          { action: "create", record: revisedCandidate },
        ],
      },
    };
  }

  if (submitted.disposition === "refine") {
    const revisedCandidate = candidateRecord(submitted, "active", { supports: [], contradicts: [], refines: [related.id], supersedes: [] });
    return {
      ok: true,
      value: {
        disposition: submitted.disposition,
        summary: `refine ${related.id} with a retained successor record`,
        mutations: [{ action: "create", record: revisedCandidate }],
      },
    };
  }

  let retired: KnowledgeRecord = { ...related, status: "retired" };
  retired = withHistory(retired, "superseded-by", submitted.id, submitted.submittedAt);
  const successor = candidateRecord(submitted, "active", { supports: [], contradicts: [], refines: [], supersedes: [related.id] });
  return {
    ok: true,
    value: {
      disposition: submitted.disposition,
      summary: `supersede ${related.id} while retaining its trace`,
      mutations: [
        { action: "update", record: retired },
        { action: "create", record: successor },
      ],
    },
  };
}

function sourceClass(record: KnowledgeRecord): string[] {
  return record.sources.map((source) => source.type);
}

function projectStatus(records: readonly KnowledgeRecord[]) {
  const ordered = [...records].sort((left, right) => left.id.localeCompare(right.id));
  const facts = ordered
    .filter((record) => record.kind !== "recommendation")
    .map((record) => record.statement);
  const requiredFacts = ordered
    .filter((record) => record.kind !== "recommendation" && record.details.priority === "baseline")
    .map((record) => record.statement);
  const uncertainty = ordered
    .map((record) => record.details.uncertainty)
    .filter((value): value is string => typeof value === "string");
  const baselineRecommendations = ordered
    .filter((record) => record.kind === "recommendation" && record.details.baseline !== false);
  const actions = baselineRecommendations
    .map((record) => record.statement);
  return {
    title: "Synthetic project status",
    summary: "Current status from authorized synthetic project records.",
    facts,
    requiredFacts,
    uncertainty: uncertainty.length > 0 ? uncertainty : ["The current status remains subject to the configured evidence policy."],
    actions,
    recommendationIds: baselineRecommendations.map((record) => record.id),
  };
}

const presentationPolicy: PresentationPack["retrievalPolicy"] = {
  allowedSourceClasses: ["status", "risk", "recommendation", "restricted"],
  queryStrategy: ({ query, viewId, requestedSourceClasses }) => viewId === "project-status"
    ? query
    : `${query} [view:${viewId ?? "none"}] [sources:${requestedSourceClasses.join(",")}]`,
  classifySource: (source) => source.type,
  relevanceThreshold: 0.5,
  isEligible: (record) => record.status === "active",
  includePresentations: false,
};

const projectStatusView: PresentationPack["views"][number] = {
  id: "project-status",
  version: 1,
  scope: "search",
  retrievalQuery: (requestedQuery) => requestedQuery ?? "beacon",
  project: projectStatus,
};

const supervisorAudience: PresentationPack["audiences"][number] = {
  id: "supervisor",
  version: 1,
  authorize: (record) => record.status === "active",
  adapt: ({ projection }) => ({
    title: "Supervisor project status",
    summary: "Decision-ready framing for the synthetic review.",
    facts: [...projection.facts],
    uncertainty: [...projection.uncertainty],
    actions: [...projection.actions],
    recommendationIds: [],
  }),
};

const peerAudience: PresentationPack["audiences"][number] = {
  id: "peer",
  version: 1,
  authorize: (record) => record.status === "active" && !sourceClass(record).includes("restricted"),
  adapt: ({ projection }) => ({
    title: "Working project status",
    summary: "A concise handoff for the synthetic project team.",
    facts: [...projection.requiredFacts],
    uncertainty: [...projection.uncertainty],
    actions: [...projection.actions],
    recommendationIds: [],
  }),
};

const presentationDeliveries: PresentationPack["deliveries"] = [
  { id: "weekly-markdown", version: 1, format: "markdown", maxWords: 120, retain: true },
  { id: "chat-brief", version: 1, format: "plain", maxWords: 60, retain: false },
];

export const fictionalPack: KnowledgePack & PresentationPack = {
  id: "fictional-integrity",
  version: "0.1.0",
  validateEnvelope: (envelope): KnowledgeResult<void> => {
    if (envelope.pack.id !== "fictional-integrity" || envelope.pack.version !== "0.1.0") {
      return { ok: false, errors: [{ kind: "validation", code: "pack_mismatch", message: "envelope pack does not match the fictional pack" }] };
    }
    if (typeof envelope.details.basis !== "string" || typeof envelope.details.certainty !== "string") {
      return { ok: false, errors: [{ kind: "validation", code: "fictional_details_invalid", message: "fictional pack requires basis and certainty details" }] };
    }
    return { ok: true, value: undefined };
  },
  relatedQuery: (envelope) => {
    const relatedPhrase = envelope.details.related_phrase;
    return typeof relatedPhrase === "string" && relatedPhrase.length > 0 ? relatedPhrase : envelope.statement;
  },
  reconcile,
  retrievalPolicy: presentationPolicy,
  views: [projectStatusView],
  audiences: [supervisorAudience, peerAudience],
  deliveries: presentationDeliveries,
};

export const fictionalPresentationPack: PresentationPack = fictionalPack;

/**
 * Default export so the external pack loader can resolve this test fixture by
 * its declared id (`fictional-integrity`) when a CLI binding names it via a
 * `from` module specifier. The loader's named-export lookup keys on the
 * declared id, which the `fictionalPack` named export does not satisfy.
 */
export default fictionalPack;
