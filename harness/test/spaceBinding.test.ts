import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRecordPath, type SpaceBinding } from "../src/spaceBinding.ts";

const BINDING: SpaceBinding = {
  recordsRoot: "/space/records",
  qmdConfigDir: "/space/qmd-config",
  qmdCacheHome: "/space/qmd-cache",
  qmdCollectionName: "space-a",
};

test("resolveRecordPath accepts a bare kebab-case id", () => {
  const result = resolveRecordPath(BINDING, "payments-gateway");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "/space/records/payments-gateway.md");
});

test("resolveRecordPath rejects an id containing a path separator", () => {
  const result = resolveRecordPath(BINDING, "../space-b/notification-relay");
  assert.equal(result.ok, false);
});

test("resolveRecordPath rejects an id that is just '..'", () => {
  const result = resolveRecordPath(BINDING, "..");
  assert.equal(result.ok, false);
});

test("resolveRecordPath rejects an absolute-path-shaped id", () => {
  const result = resolveRecordPath(BINDING, "/etc/passwd");
  assert.equal(result.ok, false);
});

test("resolveRecordPath rejects uppercase and underscore characters", () => {
  assert.equal(resolveRecordPath(BINDING, "Payments_Gateway").ok, false);
});
