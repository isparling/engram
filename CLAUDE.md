# Working in this repository

`engram` is a personal knowledge harness. It is early: the governing documents are more
developed than the code. Read [VISION.md](VISION.md) and [KNOWLEDGE_MODEL.md](KNOWLEDGE_MODEL.md)
for what it is, [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md) for the product contract and
its acceptance properties, and [OPERATING_CONSTRAINTS.md](OPERATING_CONSTRAINTS.md) for
the durable rules that bind it.

`AGENTS.md` is a symlink to this file. Both Claude Code and Codex work in this repository;
neither gets its own ruleset.

## Two rules that exist because we paid for them

### 1. A fix is not done until its test has been observed failing

Write the test, **revert the fix, confirm the test fails, restore the fix, confirm it
passes.** Report that observation, not just the final green run.

A test that has never been seen failing proves nothing: a property that is never
observed broken can rot silently behind a green suite. This applies to your own work as
much as to work you are reviewing. If reverting the fix produces no failure, you have
not tested the property; say so rather than moving on.

### 2. State properties, not fixes

A finding or a task is closed by a test named for the **property**, derived from a concrete
scenario: these inputs, in this state, produce this wrong outcome.

"Bind approval to the plan" sounds falsifiable and is not — hashing the record satisfies
the words and misses the property entirely. "Previewing candidate A and then approving
candidate B against an unchanged record must not commit B" cannot be satisfied by the
wrong mechanism.

When you write a brief for another agent, state the property and name the adversarial
case. When you receive one, if the property is not falsifiable as written, stop and say so.

## Hard constraints

- **No private content, ever.** No work source, knowledge, transcripts, identifiers,
  paths, logs, or credentials. Personal knowledge is never copied here for tests,
  examples, or debugging. Fixtures are synthetic and fictional. This includes incidental
  detail — real qmd collection names and home directory paths have both been caught and
  removed.
- **Do not run a global `qmd update`.** The machine has real personal collections. Every
  qmd invocation must carry `QMD_CONFIG_DIR` and `XDG_CACHE_HOME` scoped to a bound space.
  The harness enforces this in code rather than in prose.
- **TypeScript with real types.** Never `as any`. Also never `as unknown as`, and no
  non-null assertions in validation code — they evade compiler proof in the places that
  most need it.
- **Zero runtime dependencies** in the harness.
- **Governing documents belong to the orchestrator.** `VISION.md`,
  `KNOWLEDGE_MODEL.md`, `ARCHITECTURE.md`, `PRODUCT_CONTRACT.md`, and
  `OPERATING_CONSTRAINTS.md` are not edited by implementation agents.
  `harness/README.md` is.


## Process

- When a behavior change makes a canonical contract stale, update the affected document
  in the same change.
- Record a correction visibly in the affected current document rather than silently
  obscuring it.
- Verify claims from other agents and tools before acting on them. Exit code 0 is not
  evidence of work: Codex runs have exited 0 while asking a clarifying question, while
  being blocked by a content filter, and while hung on a dead connection. Read the
  artifact.
