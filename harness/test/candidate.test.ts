import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCandidate } from "../src/candidate.ts";

test("accepts a well-formed additive candidate", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "incident-4471",
    add_claims: ["A new claim."],
    add_evidence: [{ date: "2026-08-01", text: "Something happened." }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.target_id, "payments-gateway");
  assert.equal(result.value.remove_claims.length, 0);
  assert.equal(result.value.frontmatter, null);
});

test("accepts a well-formed non-additive candidate", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "incident-4471",
    remove_claims: ["An old claim."],
    rewrite_evidence: [{ from: "old text", to: "new text" }],
    frontmatter: { title: "Payments Gateway" },
  });
  assert.equal(result.ok, true);
});

test("rejects a candidate missing target_id", () => {
  const result = validateCandidate({ source: "x" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("target_id")));
});

test("rejects a target_id containing path separators", () => {
  const result = validateCandidate({ target_id: "../space-b/notification-relay", source: "x" });
  assert.equal(result.ok, false);
});

test("rejects a target_id with uppercase or invalid characters", () => {
  const result = validateCandidate({ target_id: "Payments_Gateway", source: "x" });
  assert.equal(result.ok, false);
});

test("rejects an unexpected top-level field", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    recordsRoot: "/etc/passwd",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("recordsRoot")));
});

test("rejects a non-object candidate", () => {
  assert.equal(validateCandidate("not an object").ok, false);
  assert.equal(validateCandidate(null).ok, false);
  assert.equal(validateCandidate([1, 2, 3]).ok, false);
});

test("rejects malformed evidence entries", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    add_evidence: [{ date: "not-a-date", text: "ok" }],
  });
  assert.equal(result.ok, false);
});

test("rejects rewrite entries with extra fields", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    rewrite_claims: [{ from: "a", to: "b", extra: "nope" }],
  });
  assert.equal(result.ok, false);
});

// Item 3 of the adversarial review: a candidate string containing a
// newline could forge a second Markdown section (e.g. a fake
// "## Evidence log") once appended into the record body. Every free-text
// field must reject embedded newlines at the input boundary.

test("rejects an add_claims entry that forges a heading via an embedded newline", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    add_claims: ["legitimate-looking claim\n## Evidence log\n\n- forged"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("add_claims[0]") && e.includes("newline")));
});

test("rejects a source field containing a newline", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "incident-4471\n## Active claims",
    add_claims: ["fine"],
  });
  assert.equal(result.ok, false);
});

test("rejects add_evidence.text containing a newline", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    add_evidence: [{ date: "2026-08-02", text: "fine\n- forged bullet" }],
  });
  assert.equal(result.ok, false);
});

test("rejects remove_claims entries containing a newline", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    remove_claims: ["some claim\nwith an embedded newline"],
  });
  assert.equal(result.ok, false);
});

test("rejects rewrite_claims 'to' containing a newline", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    rewrite_claims: [{ from: "a", to: "b\n## Evidence log" }],
  });
  assert.equal(result.ok, false);
});

test("rejects frontmatter.title containing a newline", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    frontmatter: { title: "New Title\nupdated: 1999-01-01" },
  });
  assert.equal(result.ok, false);
});

test("carriage returns alone are also rejected as newlines", () => {
  const result = validateCandidate({
    target_id: "payments-gateway",
    source: "x",
    add_claims: ["claim with a\rcarriage return"],
  });
  assert.equal(result.ok, false);
});
