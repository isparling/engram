// Shared deep-freeze. Two call sites (knowledgeRetrieval.ts and
// presentation.ts) used to carry verbatim copies of this without a seen-set,
// so a self-referential object graph would recurse forever. Not reachable
// from parseKnowledgeRecord output today, but worth one implementation with
// cycle protection before anything else starts feeding it.
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return value;
}
