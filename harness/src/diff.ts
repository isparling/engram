// Structural diff helpers for comparing knowledge records before they are
// written.
//
// Small hand-written line-based diff (classic LCS dynamic program). Record
// files are tiny (tens of lines), so the O(n*m) table is not a concern.
// Renders the complete before/after text as a unified-style diff — this is
// the "render the complete diff" step, used both to gate approval and to
// show the reviewer exactly what a write will do.

import { requireDefined } from "./types.ts";

export type DiffOp = { type: "equal" | "add" | "remove"; line: string };

/** Reads the LCS table at [i][j]. Every call site keeps i, j within
 * [0, n] / [0, m] by construction, so an out-of-range read here would
 * indicate a bug in the loop bounds, not a legitimate "no value" case —
 * hence the thrown default instead of a silent `?? 0`. */
function lcsAt(table: number[][], i: number, j: number): number {
  const row = requireDefined(table[i], `lcs table row ${i} out of range`);
  return requireDefined(row[j], `lcs table cell [${i}][${j}] out of range`);
}

function lineAt(lines: string[], i: number): string {
  return requireDefined(lines[i], `line index ${i} out of range`);
}

export function diffLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = requireDefined(lcs[i], `lcs table row ${i} out of range`);
      if (before[i] === after[j]) {
        row[j] = lcsAt(lcs, i + 1, j + 1) + 1;
      } else {
        row[j] = Math.max(lcsAt(lcs, i + 1, j), lcsAt(lcs, i, j + 1));
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", line: lineAt(before, i) });
      i++;
      j++;
    } else if (lcsAt(lcs, i + 1, j) >= lcsAt(lcs, i, j + 1)) {
      ops.push({ type: "remove", line: lineAt(before, i) });
      i++;
    } else {
      ops.push({ type: "add", line: lineAt(after, j) });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", line: lineAt(before, i) });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: lineAt(after, j) });
    j++;
  }
  return ops;
}

export function renderUnifiedDiff(recordId: string, beforeText: string, afterText: string): string {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const ops = diffLines(before, after);

  const lines: string[] = [`--- ${recordId} (before)`, `+++ ${recordId} (after)`];
  for (const op of ops) {
    const prefix = op.type === "equal" ? " " : op.type === "add" ? "+" : "-";
    lines.push(`${prefix}${op.line}`);
  }
  return lines.join("\n");
}
