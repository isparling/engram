import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, renderUnifiedDiff } from "../src/diff.ts";

test("diffLines reports equal lines as equal", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "b", "c"]);
  assert.deepEqual(
    ops.map((o) => o.type),
    ["equal", "equal", "equal"],
  );
});

test("diffLines reports an appended line as add", () => {
  const ops = diffLines(["a", "b"], ["a", "b", "c"]);
  assert.deepEqual(
    ops.map((o) => [o.type, o.line]),
    [
      ["equal", "a"],
      ["equal", "b"],
      ["add", "c"],
    ],
  );
});

test("diffLines reports a removed line as remove", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "c"]);
  assert.deepEqual(
    ops.map((o) => [o.type, o.line]),
    [
      ["equal", "a"],
      ["remove", "b"],
      ["equal", "c"],
    ],
  );
});

test("renderUnifiedDiff includes a header naming the record and both markers", () => {
  const diff = renderUnifiedDiff("payments-gateway", "line one\nline two\n", "line one\nline three\n");
  assert.match(diff, /^--- payments-gateway \(before\)/);
  assert.match(diff, /\+\+\+ payments-gateway \(after\)/);
  assert.match(diff, /-line two/);
  assert.match(diff, /\+line three/);
});
