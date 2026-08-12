/**
 * Public external-pack interface types.
 *
 * A normal knowledge operation requires the full KnowledgePack and
 * PresentationPack surface. KnowledgeExtractor is separately optional and is
 * selected only by a binding entry with extract: true.
 */
export type {
  KnowledgeExtractor,
  KnowledgePack,
  PresentationPack,
} from "./knowledgeTypes.ts";
