# Mutation check — specification

## Status

The registry pins ninety-six core properties across the harness runtime, the
standalone release manager, the mutation checker itself, and the omp
extension — 96 properties in total, all listed below. The registry is
core-only: every entry targets a file in `harness/`, `release/`, or the
extension surface, and each entry carries a stable, unique, non-historical
identifier.

## Why this exists

The single highest-value countermeasure for property drift is cheap — revert
the fix and confirm the test fails. Applied once, it exposed an approval-
integrity defect that had survived an entire review cycle aimed directly at it.

Rules 1 and 2 in [CLAUDE.md](../CLAUDE.md) state that as an obligation. This
tool exists because an obligation stated in prose is policy: an agent can
report a revert-check it never ran. This makes the check something that is
executed rather than promised.

## What it is

A registry of **mutations**: small, exact source substitutions that each disable
one property the code is supposed to have, paired with the tests that must then
fail.

The tool applies each mutation, runs the suite, and asserts the expected tests
fail. A mutation that causes **no** failure is the primary finding — it means
the property is not actually pinned by any test.

## What it is not

- Not general mutation testing. It does not generate mutations, measure a mutation
  score, or aim for coverage. It pins properties someone deliberately registered.
- Not a replacement for review. It confirms that known properties stay tested; it
  cannot find properties nobody thought of.
- Not CI. This repository has no CI.
- Not a dependency. Zero runtime dependencies, consistent with the operating
  constraints.

## Registry format

A TypeScript module, `harness/mutations.ts`, exporting a typed array. TypeScript
rather than JSON so entries are type-checked and can carry prose without escaping
pain.

```ts
export type Mutation = {
  /** Stable kebab-case identifier, used in output and to skip individual entries. */
  id: string;
  /** The property being pinned, stated as a falsifiable claim about behaviour. */
  property: string;
  /** Path relative to harness/. */
  file: string;
  /** Exact source substring to replace. Must occur EXACTLY ONCE in the file. */
  find: string;
  /** Replacement that disables the property while keeping the file syntactically valid. */
  replace: string;
  /** Substrings of test names that must appear among the failures. At least one. */
  mustFail: string[];
};
```

## Tool behaviour

`harness/scripts/mutation-check.ts`, run as `node scripts/mutation-check.ts` from
`harness/`, optionally with one or more `id` arguments to run a subset.

1. **Refuse to run on a dirty tree.** If `git status --porcelain` reports any change under
   `harness/` or `release/`, abort before touching anything. This makes restore trivial and
   guarantees a crash cannot destroy uncommitted work.
2. **Establish a green baseline.** Run the full suite. If it is not green, abort — mutation
   results are meaningless against a failing baseline.
3. **For each mutation, in order:**
   - Read the file. Assert `find` occurs **exactly once**. Zero occurrences means the
     registry has rotted against the source; more than one means the entry is ambiguous.
     Either is a hard failure naming the entry.
   - Write the mutated file.
   - Run the suite, capturing failing test names.
   - **Restore the file in a `finally`**, via `git checkout -- <file>`, before any
     assertion. Restoration must not depend on the assertions passing.
   - Assert the suite failed at all. A mutation producing a green suite is the headline
     failure this tool exists to catch, and must be reported as such rather than as a
     generic mismatch.
   - Assert every entry in `mustFail` matched at least one failing test name. Report any
     that did not.
4. **Verify clean exit.** After the loop, confirm `git status --porcelain` for `harness/`
   and `release/` is empty again. If not, report loudly — a restore failed and the working
   tree is modified.
5. **Exit non-zero** if any mutation failed its expectations.

## Output

One line per mutation while running, then a summary. For failures, state which of the
three cases occurred: registry rot (`find` not found or ambiguous), unpinned property
(suite stayed green), or wrong test (suite failed but a `mustFail` name never appeared).

The unpinned-property case should be visually distinct. It is the one that means a test is
lying.

## Mutable roots

Mutations may touch only files under `harness/` and `release/`. Two guards depend on that
list — containment and the dirty-tree/restoration check — and they are pinned together
deliberately, because the failure they jointly prevent is mutating a file whose
restoration is never verified. Packs are external modules resolved through a binding's
`installed_packs[].from` specifier; they are never mutated by this tool.

`checker-mutation-containment` is worth reading closely as an example of a property that a
weaker assertion would have missed. Without containment the runner still exits nonzero:
it mutates the escaping file, finds the property unpinned, and restores it. An entry
asserting only the exit code would have passed against broken containment. The pinned
property is therefore the refusal itself — "never touched it" rather than "touched it and
put it back".

## Registry

Each table lists the property an entry pins and the file it mutates. Sections group the
entries by the source file they pin.

## src/submit.ts
| `approval-binds-plan` | An approval commits only the mutation it was shown for: a different candidate, record, date, or space cannot reuse the previewed plan hash. |
| `approval-required-non-additive` | A non-additive candidate without approval writes nothing and does not refresh qmd. |
| `missing-target-named` | A target present only in an unselected space is refused by naming the missing target in the selected space. |

## src/qmdConfigGuard.ts
| `pattern-no-parent-segment` | A collection pattern containing a parent (..) segment is refused before qmd can use it. |
| `pattern-no-absolute` | An absolute collection pattern is refused before qmd can use it. |
| `config-no-update-field` | A bound qmd config containing an update field is refused without allowing executable refresh configuration through. |
| `config-dir-identity` | A bound qmd config directory that is the real default is refused by filesystem identity even when its path string differs. |
| `cache-home-identity` | A bound qmd cache home that is the real default is refused by filesystem identity even when its path string differs. |

## src/symlinkGuard.ts
| `symlink-no-escape` | A symlink inside the records root that resolves outside it is refused before a scanning qmd command runs. |

## src/qmdRunner.ts
| `qmd-env-scoped` | Every qmd invocation carries the bound config/cache paths, clears inherited INDEX_PATH, and sets PWD to the bound records root. |
| `refresh-exactly-once` | A committed indexed change causes exactly one indexing pass, including first use where collection provisioning is the refresh. |
| `refresh-fails-closed` | An unparseable or failed refresh reports index-stale rather than fresh. |
| `qmd-refresh-failure-reported-as-fresh` | A qmd refresh whose exit code or stdout does not confirm a successful index update is reported as index-stale, not silently upgraded to fresh, so a commit after qmd failure leaves the index correctly marked stale. |
| `qmd-embed-runs-embed` | embedBoundCollection runs `qmd embed`. Running `update` instead refreshes the full-text index while leaving the vectors behind vsearch stale for every record just written - the regression is invisible until semantic search stops returning recent facts. |
| `qmd-embed-failure-reported` | A nonzero embed exit is reported as embeddings-stale. Treating every run as success reports fresh embeddings the space does not have. |
| `qmd-embed-never-started-distinct` | An embed process that never started is reported distinctly from one that ran and failed, so a missing qmd binary is not diagnosed as a bad embedding model. |

## src/markdownRecord.ts
| `preamble-round-trip` | Content before the first heading survives parse and serialize unchanged. |

## src/classify.ts
| `classification-from-plan` | Classification is wired to the planned mutation: an additive candidate with the injected content-preservation check returning false is classified non-additive. |

## src/atomicWrite.ts
| `atomic-write-preserves-mode` | An atomic write preserves the target file's existing permission bits. |

## src/spaceRegistry.ts
| `registration-config-not-default` | Registration refuses a qmd configuration directory that is the user's real default directory. |
| `registration-cache-not-default` | Registration refuses a qmd cache home that is the user's real default cache directory. |
| `write-roots-authorize-records` | Registration refuses a space whose write roots do not authorize its records directory. |
| `write-roots-within-space` | Registration refuses a write root that escapes the portable space root. |
| `knowledge-schema-supported` | Registration refuses a manifest whose knowledge schema version is unsupported. |
| `qmd-collection-unique` | Registration refuses two spaces that use the same qmd collection name. |
| `stale-space-isolated` | A stale registered space does not block registration or use of an unrelated healthy space. |
| `stale-space-reregisterable` | Re-registering a stale space fully validates and replaces its recorded boundary through the CLI. |
| `binding-format-insensitive` | Changing only a registered binding's JSON formatting does not make its semantic boundary stale. |
| `compatible-pack-evolution` | A compatible required-pack manifest edit does not make the registered boundary stale. |
| `selected-space-only` | When a target exists in two spaces, a submission modifies only the selected space's record. |
| `active-selections-per-session` | Selecting a space records one mapping per host session without displacing another session. |
| `session-selection-required` | A host session with no selection cannot adopt another session's active space. |
| `registry-mutations-locked` | Registry state mutations fail fast under a live lock and overlapping registrations cannot lose a reported success. |
| `proven-stale-lock-recoverable` | A lock whose same-host owner process is proven absent is recoverable without hand-editing registry state. |
| `unverifiable-lock-refused` | A lock with unverifiable owner metadata is refused and never removed on an assumption that its owner is gone. |

## src/knowledgeRetrieval.ts
| `guarded-retrieval-foreign-locators` | Guarded retrieval refuses qmd locators that do not name the active space's collection instead of resolving them under the active records root. |
| `unauthorized-records-withheld` | Audience-unauthorized records are withheld before rendering while the request continues over authorized matches and records only the withheld count. |
| `pack-excludes-presentations` | Even if a source class classifier names presentation, ordinary guarded retrieval filters presentation artifacts out of pack retrieval results. |
| `authorization-policy-boolean` | Audience authorization callbacks must return a boolean; truthy non-boolean values cannot expose records. |
| `retrieval-scoped-to-active-collection` | Related-record retrieval invokes qmd scoped to the active space's own collection (`-c <qmdCollectionName>`); dropping that scoping flag is caught because the process is invoked with the wrong argument vector. |
| `retrieval-foreign-collection-locator-rejected` | A qmd hit locator that names a collection other than the active space's own is rejected by safeRelativeMarkdownPath's prefix check before any file is resolved; disabling that check lets a foreign-collection locator flow through and the candidate is accepted as a bare proposal instead of failing retrieval closed. |
| `retrieval-qmd-nonzero-exit-fails-closed` | A nonzero qmd search exit code is reported as a retrieval failure before its stdout is ever parsed; disabling that check lets a nonzero exit with `[]` stdout fall through to the empty-array miss path and the transaction proceeds to a proposal instead of failing retrieval closed. |
| `retrieval-exact-qmd-miss-string-short-circuit` | qmd's literal "No results found." stdout is recognized as an explicit miss before JSON parsing is attempted; disabling that short-circuit sends the literal string into JSON.parse, which throws, turning what must be a miss into a retrieval failure. |
| `retrieval-vanished-in-space-locator-is-miss-not-failure` | When a qmd-located record's file vanishes between the search hit and the realpath resolution of its target path, that ENOENT is treated as an explicit miss, not a retrieval failure; disabling that ENOENT check turns a vanished in-space locator into a hard failure instead of a miss. |
| `retrieval-enumerated-receipt-no-threshold` | An enumerated retrieval receipt reports no relevance threshold, because enumeration never ranked or filtered candidates by score. |
| `retrieval-enumerated-receipt-no-query` | An enumerated retrieval receipt records query as null instead of fabricating a query that never ran. |
| `retrieval-enumeration-symlink-guarded` | Enumeration includes a Markdown symlink as a candidate so the shared realpath-containment guard can refuse an escape instead of silently skipping it. |

## src/guardedRetrievalInternal.ts
| `unresolved-receipt-active-space-null` | A guarded retrieval attempted with no active space returns a failure receipt whose activeSpace field is null, never a fabricated space id. |
| `pack-rejects-presentation-policy` | Pack validation refuses retrieval policies that declare presentation artifacts eligible for ordinary guarded retrieval. |
| `policy-shape-invalid` | Malformed runtime presentation packs fail structurally before active-space retrieval dereferences retrievalPolicy. |
| `retrieval-policy-snapshot` | Guarded retrieval snapshots audience authorization before queryStrategy can mutate live pack definitions. |

## src/presentation.ts
| `required-fact-hidden` | Audience adaptations must preserve every fact the audience-independent projection marked required. |
| `uncertainty-hidden` | Audience adaptations must preserve every explicit uncertainty item from the audience-independent projection. |
| `action-text-bound-to-recommendation` | Every rendered action is either a projected baseline action or exactly the statement of a cited authorized active recommendation. |
| `presentation-root-segregated` | Retained presentation roots must resolve outside the active records root before any presentation artifact is written. |
| `presentation-already-retained` | Re-rendering an identical retained presentation is refused before publish instead of overwriting or colliding generically. |
| `delivery-definition-snapshot` | Presentation rendering passes callbacks an immutable delivery snapshot so callback mutation cannot bypass the declared word-limit guard. |
| `callback-output-shape` | Malformed projection and adaptation callback outputs return structured presentation errors instead of rejected promises. |
| `presentation-metadata-snapshot` | Presentation receipts use definition metadata snapshotted before pack callbacks can mutate live view or audience objects. |
| `presentation-atomic-publish` | A retained presentation is published by renaming the fully written pending directory into place, so a successful render leaves the final artifact and no pending directory. |
| `presentation-draft-snapshot` | The draft returned by an audience callback is snapshotted, so an accessor-backed field cannot pass validation and then render different text. |
| `presentation-space-view-enumerates-all` | A space-scoped view enumerates every authorized active record under the active space's records root without constructing a qmd query. |
| `presentation-space-view-query-refused` | A space-scoped view refuses a caller-supplied query instead of ignoring it and returning the whole space while the caller believes it was narrowed. |
| `presentation-view-scope-runtime-closed` | A runtime view scope outside search or space is refused before retrieval instead of silently selecting search mode. |

## src/knowledgeTransaction.ts
| `transaction-approval-revalidation-gate-disabled` | Approval-time revalidation rejects committing (or refreshing qmd for) a proposal whose candidate, space, binding, authoritative source record, related record, or submission date changed since preview, reporting stale_approval instead. |
| `transaction-provenance-erasure-permitted` | An update mutation that changes an existing record's sources, session, or scope is rejected with record_trace_loss, even when its relationships and history are otherwise preserved. |
| `transaction-relationship-trace-erasure-permitted` | An update mutation that deletes or alters an existing record's relationships or history is rejected with record_trace_loss, even when provenance fields are otherwise preserved. |
| `transaction-rejection-commits-writes` | A rejected proposal returns status "rejected" without writing any planned mutation or attempting a qmd refresh. |
| `transaction-no-change-triggers-refresh` | A plan classified no-change returns status "no_change" without writing anything or attempting a qmd refresh, rather than falling through to a commit. |
| `transaction-related-record-symlink-swap-blocked-by-realpath-containment` | Once retrieval and the pre-plan authoritative comparison have accepted a related record, replacing its file on disk with a symlink to outside the active records root — whether before the mutation plan is built or after an approval preview — is caught by realpath containment in readCurrent and fails closed rather than reading the outside target into the plan or committing over it. |
| `transaction-related-record-race-fails-closed` | A related record's on-disk content re-read by the pre-plan authoritative comparison, after retrieval already read a copy of it, is compared against what retrieval returned; disabling that comparison lets a related record rewritten in that window flow through as if unchanged, producing a proposal instead of an invalid outcome with a related_record_changed error. |

## src/transactionLock.ts
| `transaction-stale-recovery-ownership-swap-permitted` | If the transaction lock's owner metadata changes between a stale-lock diagnosis and the recovery removal, recovery fails closed (lock_conflict) and never removes the changed owner. |

## test/fictionalPack.ts
| `extension-refine-edge-dropped` | The fictional pack's refine reconciliation gives the new successor record a refines edge to the record it refines. This pins that the forward edge exists on the fictional pack's construction, not a reachable core-transaction defense: the core-side half of trace preservation (that an update cannot delete an existing edge) is pinned separately by transaction-relationship-trace-erasure-permitted, which mutates harness core code, not this fixture pack. |
| `extension-supersede-reciprocal-edge-permitted` | Supersede reconciliation must not give the retired (old) record a reciprocal supersedes edge back to its successor — the supersedes edge points from the new record to the old record only, not both ways. This pins the fictional pack's construction (wiring), not a reachable core-transaction defense: the core has no independent check against a pack choosing to write a reciprocal edge, since an added array entry is accepted as additive by preservesRecordTrace/mutationIsAdditive. |

## scripts/mutation-check.ts
| `checker-dirty-gate-covers-mutable-roots` | The dirty-tree and restoration checks inspect every directory a mutation may touch, not only harness/. Narrowing them to harness/ lets the runner mutate a pack file whose restoration it never verifies, which is the one guarantee the tool provides. |
| `checker-mutation-containment` | A mutation naming a file outside every mutable root is refused before the file is read or written. Without containment the runner still exits nonzero, but only after mutating and restoring the escaping file - so the property is the refusal, not the exit code. |

## src/cli.ts
| `cli-pack-single-required` | The CLI requires the active space to declare exactly one required pack. A space declaring more than one is refused with a clear error naming the count, rather than the CLI guessing which one to use. |
| `cli-pack-config-parse-failure-reported` | The CLI reports every pack resolution failure from resolveKnowledgePack (pack_from_required, pack_load_failed, pack_export_invalid, pack_identity_mismatch) as a validation error and exits non-zero, never silently substituting a default pack. |
| `cli-pack-resolved-from-space` | knowledge submit/reconcile/approve/reject resolve the pack only from the active space's declared id/version/from via resolveKnowledgePack; the CLI never hardcodes a pack identity. |
| `cli-pack-unknown-fails-closed` | The CLI passes the declared `from` through to resolution and never fabricates one, so a required pack that omits from fails closed as pack_from_required rather than the CLI substituting any known pack. |

## src/packLoader.ts
| `loader-pack-external-from-resolved` | resolveKnowledgePack enforces that the loaded module's declared id and version exactly match the binding's declared id and version, refusing a mismatch as pack_identity_mismatch rather than returning a pack of a different identity. |

## ../release/engram-release.ts
| `release-evidence-binds-artifact` | Release verification evidence is bound to the exact archive checksum, so a result recorded for another artifact cannot qualify this release. |
| `release-bootstrap-independent` | Installing a first immutable release establishes current without a development checkout. |
| `release-integrity-before-extract` | Archive bytes are verified against the release record before archive inspection or extraction. |
| `release-archive-path-contained` | Physical release boundaries reject linked roots and parents before extraction. |
| `release-id-immutable` | An existing immutable release identifier is never replaced. |
| `release-install-lock-exclusive` | An observed live installation lock prevents concurrent installer ownership. |
| `release-select-pointer-only` | Selection changes the atomic current pointer rather than release contents. |
| `release-rollback-reselects` | Rollback reselects an earlier immutable release. |
| `release-failure-preserves-current` | A failed installation does not change the active release. |
| `release-stable-command-current` | The stable engram launcher follows the current selection. |
| `release-output-content-free` | Manager failures are projected through the public error boundary. |

## scripts/release-builder.ts
| `release-runtime-allowlist` | Release staging enumerates only the approved runtime allowlist, so a neighboring machine binding cannot enter the artifact merely because Git tracks it. |
| `release-runtime-package-exact` | The packaged runtime metadata contains exactly the three approved keys, preventing development scripts or dependency metadata from crossing the artifact boundary. |
| `release-clean-source-required` | Release candidate construction refuses every tracked or untracked source change before staging, so copied bytes remain attributable to the recorded commit. |

## omp-extension.ts
| `omp-extension-registers-engram-capture-tool` | if the registerTool call in omp-extension.ts is disabled, the test's toolHandler assert at ompExtension.test.ts:130 fails |

## Notes on individual entries

`extension-refine-edge-dropped` and `extension-supersede-reciprocal-edge-permitted` both
mutate `test/fictionalPack.ts`, the fixture reconciliation pack, not core transaction
code. Both pin that the fixture pack's own relationship construction is correct rather
than a reachable core-transaction defense: the core has no independent check that would
reject a pack choosing to add a reciprocal or missing relationship edge, since an added
array entry is accepted as additive by `preservesRecordTrace`/`mutationIsAdditive`. The
core-side half of supersession traceability — that an *update* mutation cannot delete an
existing relationship or history entry — is pinned separately and non-tautologically by
`transaction-relationship-trace-erasure-permitted`, which mutates core code.

`classification-from-plan` is known to be reachable only through its injected seam: once
preamble round-trip is fixed, no real candidate drives the content check false. Its entry
should mutate the injected check rather than pretend otherwise, and the `property` text
should say the entry pins wiring rather than a reachable defect.

The batched-rollup property has **no entry of its own**, deliberately. A rollup whose
later plan an earlier commit invalidated is stopped by the same source seam
`transaction-related-record-race-fails-closed` already pins, and the registry convention
is one seam per entry. Its test is also worth a caveat: with that comparison disabled the
transaction still closes, because `record_trace_loss` independently blocks it. The test
is sensitive to the guard because it asserts the specific error code, but the underlying
safety is redundantly defended — the entry pins the code path, not the last line of
defence.

`release-evidence-binds-artifact` shares its pinning property name with a pre-existing
qualification-flow test in `test/releaseQualification.test.ts`. The registered entry
mutates the parser-level guard in `parseVerificationSummary`
(`../release/engram-release.ts`) and is pinned by the parser-level test of the same name
in `test/releaseMetadata.test.ts`, which fails directly against the mutation; the
qualification-flow test of the same name never observes a mismatch because the synthetic
release it qualifies is built with matching hashes to begin with.

## Acceptance

- Running with a clean tree and no arguments reports every seed entry passing.
- Deliberately deleting one test from the suite causes exactly the corresponding entry to
  report an unpinned property.
- Editing a `find` string to something absent causes that entry to report registry rot.
- Killing the process mid-run leaves the working tree clean, or the next run refuses to
  start and says why.
- The tool has no dependencies and runs under the same Node used for the suite.

## Maintenance

Every new property pinned by a test gets a registry entry in the same change. An entry
whose `find` string no longer matches is a signal to re-derive the property against the
new code, not to delete the entry — deletion is how a pinned property silently stops being
pinned.
