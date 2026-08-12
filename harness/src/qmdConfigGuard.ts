// qmd configuration guard: a bound config directory or cache home that is the
// user's real default is refused, and a config declaring an `update:` field is
// refused, so every qmd invocation stays scoped to a space.
//
// The bound qmd config directory holds `index.yml`, and that file is
// executable content, not passive configuration: qmd's `updateCollections`
// runs any collection's `update:` field through
// `Bun.spawn(["/usr/bin/env", "bash", "-c", yamlCol.update], ...)` on every
// `qmd update`. If anything ever wrote (or a local binding pointed at a
// config with) an `update:` field, refresh would
// be arbitrary shell execution. This module is the gate: every qmd
// invocation that would read this file is checked against it first, and
// checked for the config directory not being the user's real default.
//
// The same class of danger applies to the bound qmd cache home: qmd writes its
// sqlite index under XDG_CACHE_HOME/qmd, so a binding pointed at the
// user's real cache home would make refresh operate on the personal
// index. `isDefaultQmdCacheHome` refuses that the same way.
//
// Both default-location checks compare by FILESYSTEM IDENTITY (device +
// inode via realPath.ts's isSameDirectory), not string equality. On macOS,
// APFS firmlinks mean `/Users/<user>/.config/qmd` and
// `/System/Volumes/Data/Users/<user>/.config/qmd` are the same directory
// but compare unequal as strings (and realpath() does not collapse the
// firmlink either — verified directly), so a string- or realpath-based
// check misses a real, reachable way to point at the same dangerous
// location.
//
// This is a deliberately strict, ALLOWLIST-only reader for the exact shape
// `qmd collection add` produces for a single collection — it is not a
// general YAML parser, and does not try to be one. Anything outside that
// shape is refused, not tolerated.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isSameDirectory, realOrResolvedPath } from "./realPath.ts";
import { err, ok, type Result } from "./types.ts";
import type { SpaceBinding } from "./spaceBinding.ts";

export function defaultQmdConfigDir(): string {
  return resolve(homedir(), ".config", "qmd");
}

export async function isDefaultQmdConfigDir(qmdConfigDir: string): Promise<boolean> {
  return isSameDirectory(qmdConfigDir, defaultQmdConfigDir());
}

/** qmd's own fallback when XDG_CACHE_HOME is unset (store.ts:
 * `Bun.env.XDG_CACHE_HOME || resolve(homedir(), ".cache")`) — this is the
 * root a binding's qmd cache home must not collide with. */
export function defaultQmdCacheHome(): string {
  return resolve(homedir(), ".cache");
}

export async function isDefaultQmdCacheHome(qmdCacheHome: string): Promise<boolean> {
  return isSameDirectory(qmdCacheHome, defaultQmdCacheHome());
}

// qmd passes a collection's `pattern` straight to `Bun.Glob.scan({ cwd })`,
// so the pattern decides what the space actually covers — and the symlink
// guard cannot see it, since the tree is clean and the pattern is what
// reaches out of it.
//
// Two shapes reach above the records root. An ABSOLUTE pattern matches
// wherever it points and survives qmd's own filtering; this is the live one.
// A parent-relative pattern is resolved out of cwd by Bun (verified: `..`
// forms return sibling files), but qmd then discards any result with a
// dot-prefixed path component, and `..` is dot-prefixed — so in this
// installed version those results are dropped before being read.
//
// Both are refused here regardless. The `..` rule does not depend on qmd's
// incidental dotfile filter continuing to exist, and relying on a downstream
// consumer's unrelated exclusion rule for containment would be fragile.
const ALLOWED_PATTERN_CHARS = /^[A-Za-z0-9_\-./*?{},[\]]+$/;

export function validateGlobPattern(pattern: string): Result<void> {
  const errors: string[] = [];

  if (pattern.trim() === "") {
    errors.push("collection pattern is empty");
    return err(errors);
  }
  if (!ALLOWED_PATTERN_CHARS.test(pattern)) {
    errors.push(
      `collection pattern contains disallowed characters: ${JSON.stringify(pattern)} (allowed: letters, digits, _ - . / * ? { } , [ ])`,
    );
  }
  if (pattern.startsWith("/")) {
    errors.push(`collection pattern must be relative to the records root, not absolute: ${JSON.stringify(pattern)}`);
  }
  if (pattern.split("/").some((segment) => segment === "..")) {
    errors.push(
      `collection pattern escapes the records root via a ".." segment: ${JSON.stringify(pattern)}`,
    );
  }

  if (errors.length > 0) return err(errors);
  return ok(undefined);
}

type ParsedLine = { indent: number; content: string };

function toIndentedLines(raw: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    result.push({ indent, content: line.trim() });
  }
  return result;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Validates that the qmd config at `configPath` declares exactly one
 * collection, named and pathed to match `binding`, with no `update:`
 * field (or any field beyond `path`/`pattern`) anywhere. Call only after
 * confirming the file exists — a missing config is a bootstrap case
 * handled by the caller (ensureBoundCollection), not a validation failure
 * here.
 */
export async function validateBoundQmdConfig(configPath: string, binding: SpaceBinding): Promise<Result<void>> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    return err([
      `failed to read qmd config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const errors: string[] = [];

  // Defense in depth ahead of the structural parse below: an `update:` key
  // at any indentation is refused outright, parse-tree position aside.
  if (/^[ \t]*update[ \t]*:/m.test(raw)) {
    errors.push(
      "qmd config declares an 'update:' field; qmd runs this via bash on every 'qmd update', so it is refused unconditionally",
    );
  }

  const lines = toIndentedLines(raw);
  if (lines.length === 0) {
    errors.push("qmd config is empty");
    return err(errors);
  }

  const first = lines[0];
  if (first === undefined || first.indent !== 0 || first.content !== "collections:") {
    errors.push('qmd config must begin with a top-level "collections:" key and no other top-level key');
  }

  const collectionNames: string[] = [];
  const collectionProps = new Map<string, Map<string, string>>();
  let currentCollection: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const { indent, content } = line;

    if (indent === 0) {
      errors.push(`qmd config has an unexpected top-level key: ${JSON.stringify(content)}`);
      continue;
    }

    if (indent === 2) {
      const match = /^([^:]+):\s*$/.exec(content);
      if (!match) {
        errors.push(`unexpected line under "collections:": ${JSON.stringify(content)}`);
        currentCollection = null;
        continue;
      }
      const name = match[1] === undefined ? "" : match[1].trim();
      collectionNames.push(name);
      collectionProps.set(name, new Map());
      currentCollection = name;
      continue;
    }

    if (indent === 4 && currentCollection !== null) {
      const match = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(content);
      if (!match) {
        errors.push(`unexpected line under collection ${JSON.stringify(currentCollection)}: ${JSON.stringify(content)}`);
        continue;
      }
      const key = match[1] === undefined ? "" : match[1];
      const value = match[2] === undefined ? "" : match[2].trim();
      if (key !== "path" && key !== "pattern") {
        errors.push(`collection ${JSON.stringify(currentCollection)} has a disallowed field: ${JSON.stringify(key)}`);
        continue;
      }
      const props = collectionProps.get(currentCollection);
      if (props) props.set(key, stripQuotes(value));
      continue;
    }

    errors.push(`unexpected indentation in qmd config: ${JSON.stringify(content)}`);
  }

  if (collectionNames.length !== 1) {
    errors.push(`qmd config must declare exactly one collection; found ${collectionNames.length}`);
  } else {
    const name = collectionNames[0];
    const props = name === undefined ? undefined : collectionProps.get(name);
    if (name !== binding.qmdCollectionName) {
      errors.push(
        `qmd config's collection name ${JSON.stringify(name)} does not match the bound collection ${JSON.stringify(binding.qmdCollectionName)}`,
      );
    }
    // qmd stores the collection's REAL path (symlinks resolved) when it
    // writes this file, so the comparison must resolve symlinks on both
    // sides too, or a symlinked temp-directory component (e.g. macOS's
    // /var -> /private/var) produces a false mismatch.
    const expectedPath = await realOrResolvedPath(binding.recordsRoot);
    const configuredPath = props?.get("path");
    const resolvedConfiguredPath = configuredPath ? await realOrResolvedPath(configuredPath) : undefined;
    if (!configuredPath || resolvedConfiguredPath !== expectedPath) {
      errors.push(
        `qmd config's collection path ${JSON.stringify(configuredPath ?? null)} does not match the bound records root ${JSON.stringify(expectedPath)}`,
      );
    }
    const configuredPattern = props?.get("pattern");
    if (configuredPattern === undefined) {
      errors.push(`qmd config's collection is missing a "pattern" field`);
    } else {
      const patternResult = validateGlobPattern(configuredPattern);
      if (!patternResult.ok) errors.push(...patternResult.errors);
    }
  }

  if (errors.length > 0) return err(errors);
  return ok(undefined);
}
