// Shared result, error, and helper types for the harness runtime.
//
// Shared hand-written validation result type. No schema library is used
// (zero runtime dependencies); every validating function in this package
// returns one of these instead of throwing on bad input.

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(errors: string[]): Result<T> {
  return { ok: false, errors };
}

/**
 * Structural stand-in for NodeJS.ProcessEnv that doesn't require importing
 * Node's ambient global type or casting object literals to it in tests.
 * `process.env` is structurally assignable to this without a cast.
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * Use in place of the non-null assertion operator (`!`) wherever a value is
 * known by loop/validation invariant to be defined but the type checker
 * cannot prove it (array indexing without noUncheckedIndexedAccess, regex
 * capture groups, Map.get after a prior .has check, etc.). Unlike `!`,
 * this fails loudly with a descriptive error if the invariant is ever
 * actually violated, instead of silently producing `undefined` typed as
 * the non-optional type.
 */
export function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(`internal invariant violated: ${message}`);
  }
  return value;
}
