// Public host-capture DTOs shared between the OMP adapter and external packs.
// JSON-safe by construction: these shapes cross process boundaries verbatim,
// so they deliberately carry no functions, classes, or host handles.

import type { JsonObject, KnowledgeError, KnowledgeRecord } from "./knowledgeTypes.ts";

export type CaptureMutationView = {
  recordId: string;
  action: "create" | "update";
  beforeHash: string | null;
  after: KnowledgeRecord;
};

export type HostCapturePreview =
  | { schemaVersion: 0; status: "ready"; planHash: string; mutations: CaptureMutationView[] }
  | { schemaVersion: 0; status: "blocked"; errors: KnowledgeError[] };

export type HostCaptureApply = {
  schemaVersion: 0;
  status: "committed" | "no-change" | "stale" | "failed";
  planHash: string;
  mutations: CaptureMutationView[];
  index: "fresh" | "stale" | "not-attempted";
  errors: string[];
};

export type ArtifactReplacementResult = { status: "replaced" | "unchanged"; path: string };

export type CompletionRequest = { model: string; prompt: string; system: string; timeoutSeconds: number };

export type CaptureChangeSetInput = JsonObject;
