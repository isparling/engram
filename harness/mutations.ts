/** A deliberately small, hand-authored source mutation paired with the
 * property-focused tests that must reject it. */
export type Mutation = {
  /** Stable kebab-case identifier used in output and positional selection. */
  id: string;
  /** A falsifiable claim about the behaviour being pinned. */
  property: string;
  /** Path relative to harness/. */
  file: string;
  /** Exact source text that must occur once in file. */
  find: string;
  /** Syntactically valid replacement that disables the property. */
  replace: string;
  /** Test-name substrings that must appear among the mutated-suite failures. */
  mustFail: string[];
};

export const mutations: Mutation[] = [
  {
    id: "approval-binds-plan",
    property:
      "An approval commits only the mutation it was shown for: a different candidate, record, date, or space cannot reuse the previewed plan hash.",
    file: "src/submit.ts",
    find: "    if (input.expectHash !== planHash) {",
    replace: "    if (false) {",
    mustFail: [
      "approving a DIFFERENT candidate",
      "approving at a different submission date",
      "a plan_hash previewed in one space",
    ],
  },
  {
    id: "approval-required-non-additive",
    property: "A non-additive candidate without approval writes nothing and does not refresh qmd.",
    file: "src/submit.ts",
    find: '  if (plan.classification === "non-additive") {',
    replace: '  if (plan.classification === "non-additive" && input.approve) {',
    mustFail: ["an unapproved non-additive candidate performs no refresh"],
  },
  {
    id: "pattern-no-parent-segment",
    property: "A collection pattern containing a parent (..) segment is refused before qmd can use it.",
    file: "src/qmdConfigGuard.ts",
    find: '  if (pattern.split("/").some((segment) => segment === "..")) {',
    replace: "  if (false) {",
    mustFail: ["a collection pattern with a .. segment is refused"],
  },
  {
    id: "pattern-no-absolute",
    property: "An absolute collection pattern is refused before qmd can use it.",
    file: "src/qmdConfigGuard.ts",
    find: '  if (pattern.startsWith("/")) {',
    replace: "  if (false) {",
    mustFail: ["an absolute collection pattern is refused"],
  },
  {
    id: "config-no-update-field",
    property: "A bound qmd config containing an update field is refused without allowing executable refresh configuration through.",
    file: "src/qmdConfigGuard.ts",
    find: '    raw = await readFile(configPath, "utf8");',
    replace:
      '    raw = (await readFile(configPath, "utf8")).replace(/^[ \\t]*update[ \\t]*:.*$/gm, "");',
    mustFail: ["refuses a config declaring an 'update:' field"],
  },
  {
    id: "config-dir-identity",
    property: "A bound qmd config directory that is the real default is refused by filesystem identity even when its path string differs.",
    file: "src/qmdConfigGuard.ts",
    find: "  return isSameDirectory(qmdConfigDir, defaultQmdConfigDir());",
    replace: "  return qmdConfigDir === defaultQmdConfigDir();",
    mustFail: ["isDefaultQmdConfigDir catches the real macOS firmlink alias"],
  },
  {
    id: "cache-home-identity",
    property: "A bound qmd cache home that is the real default is refused by filesystem identity even when its path string differs.",
    file: "src/qmdConfigGuard.ts",
    find: "  return isSameDirectory(qmdCacheHome, defaultQmdCacheHome());",
    replace: "  return qmdCacheHome === defaultQmdCacheHome();",
    mustFail: ["isDefaultQmdCacheHome catches the real macOS firmlink alias"],
  },
  {
    id: "symlink-no-escape",
    property: "A symlink inside the records root that resolves outside it is refused before a scanning qmd command runs.",
    file: "src/symlinkGuard.ts",
    find: "        if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {",
    replace: "        if (false) {",
    mustFail: [
      "refuses a symlink that resolves outside the records root",
      "refuses a symlinked directory that resolves outside the records root",
      "finds an escaping symlink nested inside an ordinary subdirectory",
    ],
  },
  {
    id: "qmd-env-scoped",
    property:
      "Every qmd invocation carries the bound config/cache paths, clears inherited INDEX_PATH, and sets PWD to the bound records root.",
    file: "src/qmdRunner.ts",
    find: [
      "  delete env.INDEX_PATH;",
      "",
      "  env.QMD_CONFIG_DIR = binding.qmdConfigDir;",
      "  env.XDG_CACHE_HOME = binding.qmdCacheHome;",
      "",
      "  // qmd reads process.env.PWD (falling back to the real cwd) in several",
      "  // places that resolve relative/\".\" paths. child_process.spawn sets the",
      "  // OS-level cwd correctly regardless, but a stale inherited PWD would",
      "  // still be visible to qmd's own process.env.PWD lookup, so it is set to",
      "  // match cwd explicitly rather than left as whatever the harness process",
      "  // happened to inherit.",
      "  env.PWD = binding.recordsRoot;",
    ].join("\n"),
    replace: "  // mutation removes the per-space qmd environment scope.",
    mustFail: [
      "buildQmdInvocation sets PWD to match cwd",
      "buildQmdInvocation always sets QMD_CONFIG_DIR",
      "buildQmdInvocation always clears INDEX_PATH",
    ],
  },
  {
    id: "refresh-exactly-once",
    property: "A committed indexed change causes exactly one indexing pass, including first use where collection provisioning is the refresh.",
    file: "src/qmdRunner.ts",
    find: '  const execution = outcome.provisioned ? outcome.execution : await runQmd(["update"], binding, spawnFn);',
    replace: '  const execution = await runQmd(["update"], binding, spawnFn);',
    mustFail: ["refreshQmdCollection provisions a fresh binding via exactly one 'collection add' call"],
  },
  {
    id: "refresh-fails-closed",
    property: "An unparseable or failed refresh reports index-stale rather than fresh.",
    file: "src/qmdRunner.ts",
    find: "  if (execution.code === 0 && sawIndexedLine) {",
    replace: "  if (execution.code === 0) {",
    mustFail: ["refreshQmdCollection fails closed"],
  },
  {
    id: "preamble-round-trip",
    property: "Content before the first heading survives parse and serialize unchanged.",
    file: "src/markdownRecord.ts",
    find: "  const preambleLines = firstHeadingIndex === -1 ? bodyLines.slice() : bodyLines.slice(0, firstHeadingIndex);",
    replace: "  const preambleLines: string[] = [];",
    mustFail: [
      "preserves preamble prose",
      "a record with no real preamble",
      "withMutatedContent preserves the preamble",
    ],
  },
  {
    id: "classification-from-plan",
    property:
      "Classification is wired to the planned mutation: an additive candidate with the injected content-preservation check returning false is classified non-additive.",
    file: "src/classify.ts",
    find: '  const classification: Classification = declaredNonAdditive || !contentPreserved ? "non-additive" : "additive";',
    replace: '  const classification: Classification = declaredNonAdditive ? "non-additive" : "additive";',
    mustFail: ["planMutation's classification wiring: an injected always-false content check"],
  },
  {
    id: "atomic-write-preserves-mode",
    property: "An atomic write preserves the target file's existing permission bits.",
    file: "src/atomicWrite.ts",
    find: "      await fileHandle.chmod(targetMode);",
    replace: "      await fileHandle.chmod(0o644);",
    mustFail: ["preserves the target file's existing permission mode"],
  },
  {
    id: "registration-config-not-default",
    property:
      "Registration refuses a qmd configuration directory that is the user's real default directory.",
    file: "src/spaceRegistry.ts",
    find: [
      "  if (qmdConfigDir !== undefined && await isDefaultQmdConfigDir(qmdConfigDir)) {",
      '    errors.push("qmd_config_dir must not be the user\'s default qmd configuration directory");',
      "  }",
    ].join("\n"),
    replace: "  // mutation disables the registration-time default-config guard.",
    mustFail: ["the real default qmd config directory is refused during registration"],
  },
  {
    id: "registration-cache-not-default",
    property: "Registration refuses a qmd cache home that is the user's real default cache directory.",
    file: "src/spaceRegistry.ts",
    find: [
      "  if (qmdCacheHome !== undefined && await isDefaultQmdCacheHome(qmdCacheHome)) {",
      '    errors.push("qmd_cache_home must not be the user\'s default qmd cache home");',
      "  }",
    ].join("\n"),
    replace: "  // mutation disables the registration-time default-cache guard.",
    mustFail: ["the real default qmd cache home is refused during registration"],
  },
  {
    id: "write-roots-authorize-records",
    property: "Registration refuses a space whose write roots do not authorize its records directory.",
    file: "src/spaceRegistry.ts",
    find: [
      "  if (recordsRoot !== undefined && !writeRoots.some((root) => containsPath(root, recordsRoot))) {",
      '    errors.push("write_roots must authorize records_dir");',
      "  }",
    ].join("\n"),
    replace: "  // mutation disables records-directory write authorization.",
    mustFail: ["write roots must authorize records even when read roots do"],
  },
  {
    id: "write-roots-within-space",
    property: "Registration refuses a write root that escapes the portable space root.",
    file: "src/spaceRegistry.ts",
    find: [
      "  if (spaceRoot !== undefined && writeRoots.some((root) => !containsPath(spaceRoot, root))) {",
      '    errors.push("write_roots must stay within the portable space root");',
      "  }",
    ].join("\n"),
    replace: "  // mutation disables portable-space write-root containment.",
    mustFail: ["a write root above the portable space root is refused at registration"],
  },
  {
    id: "knowledge-schema-supported",
    property: "Registration refuses a manifest whose knowledge schema version is unsupported.",
    file: "src/spaceRegistry.ts",
    find: [
      "  if (!SUPPORTED_KNOWLEDGE_SCHEMA_VERSIONS.has(manifest.knowledgeSchemaVersion)) {",
      "    errors.push(`unsupported knowledge schema version ${manifest.knowledgeSchemaVersion}`);",
      "  }",
    ].join("\n"),
    replace: "  // mutation disables knowledge-schema compatibility validation.",
    mustFail: ["an unsupported knowledge schema version is refused at registration"],
  },
  {
    id: "qmd-collection-unique",
    property: "Registration refuses two spaces that use the same qmd collection name.",
    file: "src/spaceRegistry.ts",
    find:
      '  if (candidate.qmdCollectionName === existing.qmd_collection_name) return "qmd_collection_name is already used by another space";',
    replace:
      '  if (false) return "qmd_collection_name is already used by another space";',
    mustFail: ["registration refuses a duplicate qmd collection name even when every path is disjoint"],
  },
  {
    id: "stale-space-isolated",
    property: "A stale registered space does not block registration or use of an unrelated healthy space.",
    file: "src/spaceRegistry.ts",
    find: "    for (const entry of registry.spaces) {\n      if (entry.space_id === candidate.value.spaceId) continue;",
    replace: [
      "    for (const entry of registry.spaces) {",
      "      const existingValidation = await loadRegisteredSpace(entry);",
      "      if (!existingValidation.ok) return existingValidation;",
      "      if (entry.space_id === candidate.value.spaceId) continue;",
    ].join("\n"),
    mustFail: ["a stale registered space does not block registering, selecting, or resolving an unrelated space"],
  },
  {
    id: "stale-space-reregisterable",
    property: "Re-registering a stale space fully validates and replaces its recorded boundary through the CLI.",
    file: "src/spaceRegistry.ts",
    find: "      if (entry.space_id === candidate.value.spaceId) continue;",
    replace: "      if (entry.space_id === candidate.value.spaceId) return err([`space_id ${candidate.value.spaceId} is already registered`]);",
    mustFail: ["CLI: re-registering a stale space revalidates its binding and returns it to service"],
  },
  {
    id: "binding-format-insensitive",
    property: "Changing only a registered binding's JSON formatting does not make its semantic boundary stale.",
    file: "src/spaceRegistry.ts",
    find: "  const currentHash = bindingHash(effective.value);",
    replace: [
      '  const bindingText = await readFile(entry.binding_path, "utf8");',
      '  const currentHash = bindingText.includes("\\n") ? "0".repeat(64) : bindingHash(effective.value);',
    ].join("\n"),
    mustFail: ["reserializing a registered binding without semantic changes leaves the space usable"],
  },
  {
    id: "compatible-pack-evolution",
    property: "A compatible required-pack manifest edit does not make the registered boundary stale.",
    file: "src/spaceRegistry.ts",
    find: [
      "    credential_env: [...space.credentialEnv].sort(),",
      "    knowledge_schema_version: space.knowledgeSchemaVersion,",
    ].join("\n"),
    replace: [
      "    credential_env: [...space.credentialEnv].sort(),",
      "    knowledge_schema_version: space.knowledgeSchemaVersion,",
      "    packs: space.packs,",
    ].join("\n"),
    mustFail: ["a compatible required-pack manifest edit leaves the registered space usable"],
  },
  {
    id: "missing-target-named",
    property: "A target present only in an unselected space is refused by naming the missing target in the selected space.",
    file: "src/submit.ts",
    find: "    return invalid([`record not found for target_id: ${candidate.target_id}`]);",
    replace: '    return invalid(["record lookup failed"]);',
    mustFail: ["CLI: a candidate cannot read or write a record that exists only in an unselected registered space"],
  },
  {
    id: "selected-space-only",
    property: "When a target exists in two spaces, a submission modifies only the selected space's record.",
    file: "src/spaceRegistry.ts",
    find: [
      "  const activeSpaceId = registry.active[hostSessionId];",
      "  if (activeSpaceId === undefined) {",
      '    const message = "no active space is selected for this host session";',
      "    const recorded = await recordBoundaryError(registryPath, message);",
      "    if (!recorded.ok) return recorded;",
      "    return err([message]);",
      "  }",
      "  const entry = registry.spaces.find((candidate) => candidate.space_id === activeSpaceId);",
      '  if (entry === undefined) return err(["active space is not registered"]);',
      "  return loadRegisteredSpace(entry);",
    ].join("\n"),
    replace: [
      "  const activeSpaceId = registry.active[hostSessionId];",
      "  if (activeSpaceId === undefined) {",
      '    const message = "no active space is selected for this host session";',
      "    const recorded = await recordBoundaryError(registryPath, message);",
      "    if (!recorded.ok) return recorded;",
      "    return err([message]);",
      "  }",
      "  const entry = registry.spaces.find((candidate) => candidate.space_id !== activeSpaceId);",
      '  if (entry === undefined) return err(["active space is not registered"]);',
      "  return loadRegisteredSpace(entry);",
    ].join("\n"),
    mustFail: ["CLI: a target present in both spaces is modified only in the selected space"],
  },
  {
    id: "active-selections-per-session",
    property: "Selecting a space records one mapping per host session without displacing another session.",
    file: "src/spaceRegistry.ts",
    find: "    registry.active[hostSessionId] = spaceId;",
    replace: "    registry.active = { [hostSessionId]: spaceId };",
    mustFail: [
      "one host session cannot displace another session from its selected space",
      "the registry serializes independent active selections for two host sessions",
    ],
  },
  {
    id: "session-selection-required",
    property: "A host session with no selection cannot adopt another session's active space.",
    file: "src/spaceRegistry.ts",
    find: "  const activeSpaceId = registry.active[hostSessionId];",
    replace: "  const activeSpaceId = registry.active[hostSessionId] ?? Object.values(registry.active)[0];",
    mustFail: ["a knowledge operation resolves only the selected space for the current host session"],
  },
  {
    id: "registry-mutations-locked",
    property: "Registry state mutations fail fast under a live lock and overlapping registrations cannot lose a reported success.",
    file: "src/spaceRegistry.ts",
    find: [
      "  const acquired = await acquireRegistryLock(registryPath);",
      "  if (!acquired.ok) return acquired;",
    ].join("\n"),
    replace: "  return operation();",
    mustFail: [
      "a live registry lock refuses a mutation with a distinct lock-conflict error",
      "every registry state mutation refuses a live lock without changing the registry",
      "overlapping registrations never lose a space whose caller was told it succeeded",
    ],
  },
  {
    id: "proven-stale-lock-recoverable",
    property: "A lock whose same-host owner process is proven absent is recoverable without hand-editing registry state.",
    file: "src/spaceRegistry.ts",
    find: [
      "    const recovered = await recoverProvenStaleLock(lockPath, recoveryPath, existing.value);",
      "    if (!recovered.ok) return recovered;",
    ].join("\n"),
    replace: '    return err(["registry lock owner is absent but recovery is disabled"]);',
    mustFail: ["a lock whose recorded process is proven absent is recovered without assuming a live owner is gone"],
  },
  {
    id: "unverifiable-lock-refused",
    property: "A lock with unverifiable owner metadata is refused and never removed on an assumption that its owner is gone.",
    file: "src/spaceRegistry.ts",
    find: [
      "    const existing = await readRegistryLockOwner(lockPath);",
      "    if (!existing.ok) return existing;",
    ].join("\n"),
    replace: [
      "    const existing = await readRegistryLockOwner(lockPath);",
      "    if (!existing.ok) {",
      "      await unlink(lockPath);",
      "      continue;",
      "    }",
    ].join("\n"),
    mustFail: ["an unverifiable registry lock is refused and never removed as though its owner were absent"],
  },
  {
    id: "guarded-retrieval-foreign-locators",
    property: "Guarded retrieval refuses qmd locators that do not name the active space's collection instead of resolving them under the active records root.",
    file: "src/knowledgeRetrieval.ts",
    find: '  if (!uri.startsWith(prefix)) return { error: retrievalError("foreign_locator", `qmd locator does not name the active collection: ${JSON.stringify(uri)}`, "file") };',
    replace: '  if (false && !uri.startsWith(prefix)) return { error: retrievalError("foreign_locator", `qmd locator does not name the active collection: ${JSON.stringify(uri)}`, "file") };',
    mustFail: ["property: model retrieval stays active-space-only when a qmd locator names a sibling or escapes the records root"],
  },
  {
    id: "unresolved-receipt-active-space-null",
    property: "A guarded retrieval attempted with no active space returns a failure receipt whose activeSpace field is null, never a fabricated space id.",
    file: "src/guardedRetrievalInternal.ts",
    find: "    activeSpace: active === null ? null : active.spaceId,",
    replace: '    activeSpace: active === null ? "" : active.spaceId,',
    mustFail: ["guard: active_space_unresolved"],
  },
  {
    id: "unauthorized-records-withheld",
    property: "Audience-unauthorized records are withheld before rendering while the request continues over authorized matches and records only the withheld count.",
    file: "src/knowledgeRetrieval.ts",
    find: [
      "      if (authorized !== true) {",
      "        withheldCount++;",
      "        continue;",
      "      }",
    ].join("\n"),
    replace: [
      "      if (false && authorized !== true) {",
      "        withheldCount++;",
      "        continue;",
      "      }",
    ].join("\n"),
    mustFail: [
      "property: an unauthorized record is filtered from a render, not a whole-request denial",
      "property: a guarded retrieval whose only qmd match is authorization-restricted is an explicit miss",
    ],
  },
  {
    id: "required-fact-hidden",
    property: "Audience adaptations must preserve every fact the audience-independent projection marked required.",
    file: "src/presentation.ts",
    find: '  if (!projection.requiredFacts.every((fact) => draft.facts.includes(fact))) errors.push(presentationError("required_fact_hidden", "audience adaptation omitted a required baseline fact"));',
    replace: '  if (false && !projection.requiredFacts.every((fact) => draft.facts.includes(fact))) errors.push(presentationError("required_fact_hidden", "audience adaptation omitted a required baseline fact"));',
    mustFail: ["guard: required_fact_hidden"],
  },
  {
    id: "uncertainty-hidden",
    property: "Audience adaptations must preserve every explicit uncertainty item from the audience-independent projection.",
    file: "src/presentation.ts",
    find: '  if (!projection.uncertainty.every((item) => draft.uncertainty.includes(item))) errors.push(presentationError("uncertainty_hidden", "audience adaptation omitted explicit uncertainty"));',
    replace: '  if (false && !projection.uncertainty.every((item) => draft.uncertainty.includes(item))) errors.push(presentationError("uncertainty_hidden", "audience adaptation omitted explicit uncertainty"));',
    mustFail: ["guard: uncertainty_hidden"],
  },
  {
    id: "action-text-bound-to-recommendation",
    property: "Every rendered action is either a projected baseline action or exactly the statement of a cited authorized active recommendation.",
    file: "src/presentation.ts",
    find: "    if (!projection.actions.includes(action) && !authorizedStatements.has(action)) {",
    replace: "    if (false && !projection.actions.includes(action) && !authorizedStatements.has(action)) {",
    mustFail: [
      "property: an adaptation whose action text is neither a view action nor the cited recommendation's statement is refused with action_unauthorized",
      "guard: action_unauthorized",
    ],
  },
  {
    id: "pack-rejects-presentation-policy",
    property: "Pack validation refuses retrieval policies that declare presentation artifacts eligible for ordinary guarded retrieval.",
    file: "src/guardedRetrievalInternal.ts",
    find: [
      "function validatePolicy(policy: PolicySnapshot): KnowledgeError[] {",
      "  const errors: KnowledgeError[] = [];",
      "  if (policy.includePresentations !== false) {",
    ].join("\n"),
    replace: [
      "function validatePolicy(policy: PolicySnapshot): KnowledgeError[] {",
      "  const errors: KnowledgeError[] = [];",
      "  if (false && policy.includePresentations !== false) {",
    ].join("\n"),
    mustFail: ["guard: policy_presentations_included"],
  },
  {
    id: "pack-excludes-presentations",
    property: "Even if a source class classifier names presentation, ordinary guarded retrieval filters presentation artifacts out of pack retrieval results.",
    file: "src/knowledgeRetrieval.ts",
    find: '      if (!filter.includePresentations && sourceClasses.includes("presentation")) continue;',
    replace: '      if (false && !filter.includePresentations && sourceClasses.includes("presentation")) continue;',
    mustFail: [
      "property: pack retrieval policy shapes the query and filters source class, relevance, eligibility, and presentations",
      "property: enumeration excludes presentation artifacts, so a retained rendering cannot become evidence for the next rendering",
    ],
  },
  {
    id: "presentation-root-segregated",
    property: "Retained presentation roots must resolve outside the active records root before any presentation artifact is written.",
    file: "src/presentation.ts",
    find: "  if (pathWithin(recordsRoot, resolvedRoot) || pathWithin(resolvedRoot, recordsRoot)) {",
    replace: "  if (false && (pathWithin(recordsRoot, resolvedRoot) || pathWithin(resolvedRoot, recordsRoot))) {",
    mustFail: ["property: the retention boundary resolves symlinks"],
  },
  {
    id: "presentation-already-retained",
    property: "Re-rendering an identical retained presentation is refused before publish instead of overwriting or colliding generically.",
    file: "src/presentation.ts",
    find: "  if (await directoryExists(paths.directory)) {",
    replace: "  if (false && await directoryExists(paths.directory)) {",
    mustFail: ["property: re-rendering an identical presentation is refused with presentation_already_retained"],
  },
  {
    id: "delivery-definition-snapshot",
    property: "Presentation rendering passes callbacks an immutable delivery snapshot so callback mutation cannot bypass the declared word-limit guard.",
    file: "src/presentation.ts",
    find: "  const delivery = snapshotDelivery(declaredDelivery);",
    replace: "  const delivery = declaredDelivery;",
    mustFail: ["property: a pack callback that mutates the delivery definition it is handed cannot move whether the presentation is retained"],
  },
  {
    id: "authorization-policy-boolean",
    property: "Audience authorization callbacks must return a boolean; truthy non-boolean values cannot expose records.",
    file: "src/knowledgeRetrieval.ts",
    find: '      if (typeof authorized !== "boolean") {',
    replace: '      if (false && typeof authorized !== "boolean") {',
    mustFail: ["guard: authorization_policy_invalid"],
  },
  {
    id: "policy-shape-invalid",
    property: "Malformed runtime presentation packs fail structurally before active-space retrieval dereferences retrievalPolicy.",
    file: "src/guardedRetrievalInternal.ts",
    find: "  if (!isObject(pack) || !isObject(pack.retrievalPolicy)) {",
    replace: "  if (false && (!isObject(pack) || !isObject(pack.retrievalPolicy))) {",
    mustFail: ["guard: policy_shape_invalid"],
  },
  {
    id: "retrieval-policy-snapshot",
    property: "Guarded retrieval snapshots audience authorization before queryStrategy can mutate live pack definitions.",
    file: "src/guardedRetrievalInternal.ts",
    find: "    authorize: audienceSnapshot.authorize,",
    replace: "    authorize: (record) => audience.authorize(record),",
    mustFail: ["guard: retrieval policy and audience authorization are snapshotted"],
  },
  {
    id: "callback-output-shape",
    property: "Malformed projection and adaptation callback outputs return structured presentation errors instead of rejected promises.",
    file: "src/presentation.ts",
    find: '    ...textErrors(projection.title, "view.title", "view_projection_invalid"),',
    replace: '    ...textErrors(projection.title, "view.title"),',
    mustFail: ["guard: view_projection_invalid"],
  },
  {
    id: "presentation-metadata-snapshot",
    property: "Presentation receipts use definition metadata snapshotted before pack callbacks can mutate live view or audience objects.",
    file: "src/presentation.ts",
    find: [
      "    viewVersion: viewSnapshot.version,",
      "    audienceId: audienceSnapshot.id,",
      "    audienceVersion: audienceSnapshot.version,",
    ].join("\n"),
    replace: [
      "    viewVersion: view.version,",
      "    audienceId: audienceSnapshot.id,",
      "    audienceVersion: audience.version,",
    ].join("\n"),
    mustFail: ["property: presentation receipt metadata is snapshotted"],
  },
  {
    id: "presentation-atomic-publish",
    property: "A retained presentation is published by renaming the fully written pending directory into place, so a successful render leaves the final artifact and no pending directory.",
    file: "src/presentation.ts",
    find: "    await rename(temporaryDirectory, paths.directory);",
    replace: "    await rename(temporaryDirectory, temporaryDirectory);",
    mustFail: ["property: retained presentation writes stay beneath a separately authorized presentation root"],
  },
  {
    id: "presentation-draft-snapshot",
    property: "The draft returned by an audience callback is snapshotted, so an accessor-backed field cannot pass validation and then render different text.",
    file: "src/presentation.ts",
    find: "    draft = snapshotDraft(audienceSnapshot.adapt({ projection, delivery, records: recordsForView(records) }));",
    replace: "    draft = audienceSnapshot.adapt({ projection, delivery, records: recordsForView(records) });",
    mustFail: ["property: a draft whose fields answer differently on each read is rendered from the validated snapshot"],
  },
  {
    id: "transaction-approval-revalidation-gate-disabled",
    property:
      "Approval-time revalidation rejects committing (or refreshing qmd for) a proposal whose candidate, space, binding, authoritative source record, related record, or submission date changed since preview, reporting stale_approval instead.",
    file: "src/knowledgeTransaction.ts",
    find: "    if (!revalidated.value.stable || input.expectedPlanHash !== undefined && input.expectedPlanHash !== revalidated.value.actualPlanHash) {",
    replace: "    if (false) {",
    mustFail: [
      "approval of a different candidate, space, binding, source record, related record, or date is stale",
    ],
  },
  {
    id: "transaction-provenance-erasure-permitted",
    property:
      "An update mutation that changes an existing record's sources, session, or scope is rejected with record_trace_loss, even when its relationships and history are otherwise preserved.",
    file: "src/knowledgeTransaction.ts",
    find: "    if (!preservesRecordTrace(current.value.record, mutation.record) || !preservesRecordProvenance(current.value.record, mutation.record)) {",
    replace: "    if (!preservesRecordTrace(current.value.record, mutation.record)) {",
    mustFail: [
      "property: an existing update cannot erase or change sources, session, or scope provenance",
    ],
  },
  {
    id: "transaction-relationship-trace-erasure-permitted",
    property:
      "An update mutation that deletes or alters an existing record's relationships or history is rejected with record_trace_loss, even when provenance fields are otherwise preserved.",
    file: "src/knowledgeTransaction.ts",
    find: "    if (!preservesRecordTrace(current.value.record, mutation.record) || !preservesRecordProvenance(current.value.record, mutation.record)) {",
    replace: "    if (!preservesRecordProvenance(current.value.record, mutation.record)) {",
    mustFail: [
      "the core rejects a pack update that deletes existing relationship or history trace",
    ],
  },
  {
    id: "transaction-stale-recovery-ownership-swap-permitted",
    property:
      "If the transaction lock's owner metadata changes between a stale-lock diagnosis and the recovery removal, recovery fails closed (lock_conflict) and never removes the changed owner.",
    file: "src/transactionLock.ts",
    find: "    if (current.value.pid !== expectedOwner.pid || current.value.hostname !== expectedOwner.hostname || current.value.token !== expectedOwner.token) {",
    replace: "    if (false) {",
    mustFail: [
      "property: ownership changes during stale recovery fail closed without removing the changed owner",
    ],
  },
  {
    id: "transaction-rejection-commits-writes",
    property:
      "A rejected proposal returns status \"rejected\" without writing any planned mutation or attempting a qmd refresh.",
    file: "src/knowledgeTransaction.ts",
    find: "    if (input.decision === \"reject\") {",
    replace: "    if (false) {",
    mustFail: [
      "the complete contradiction plan precedes approval; rejection changes neither Markdown nor qmd state",
    ],
  },
  {
    id: "transaction-no-change-triggers-refresh",
    property:
      "A plan classified no-change returns status \"no_change\" without writing anything or attempting a qmd refresh, rather than falling through to a commit.",
    file: "src/knowledgeTransaction.ts",
    find: "    if (plan.classification === \"no-change\") {",
    replace: "    if (false) {",
    mustFail: [
      "no-change writes nothing and does not refresh",
    ],
  },
  {
    id: "extension-refine-edge-dropped",
    property:
      "The fictional pack's refine reconciliation gives the new successor record a refines edge to the record it refines. This pins that the forward edge exists on the fictional pack's construction, not a reachable core-transaction defense: the core-side half of trace preservation (that an update cannot delete an existing edge) is pinned separately by transaction-relationship-trace-erasure-permitted, which mutates harness core code, not this fixture pack.",
    file: "test/fictionalPack.ts",
    find: "    const revisedCandidate = candidateRecord(submitted, \"active\", { supports: [], contradicts: [], refines: [related.id], supersedes: [] });",
    replace: "    const revisedCandidate = candidateRecord(submitted, \"active\", { supports: [], contradicts: [], refines: [], supersedes: [] });",
    mustFail: [
      "property: refine and supersede relationships point from the new record to the old record only",
    ],
  },
  {
    id: "extension-supersede-reciprocal-edge-permitted",
    property:
      "Supersede reconciliation must not give the retired (old) record a reciprocal supersedes edge back to its successor — the supersedes edge points from the new record to the old record only, not both ways. This pins the fictional pack's construction (wiring), not a reachable core-transaction defense: the core has no independent check against a pack choosing to write a reciprocal edge, since an added array entry is accepted as additive by preservesRecordTrace/mutationIsAdditive.",
    file: "test/fictionalPack.ts",
    find: "  let retired: KnowledgeRecord = { ...related, status: \"retired\" };",
    replace: "  let retired: KnowledgeRecord = { ...related, status: \"retired\", relationships: { ...related.relationships, supersedes: [...related.relationships.supersedes, submitted.id] } };",
    mustFail: [
      "property: refine and supersede relationships point from the new record to the old record only",
    ],
  },
  {
    id: "qmd-refresh-failure-reported-as-fresh",
    property:
      "A qmd refresh whose exit code or stdout does not confirm a successful index update is reported as index-stale, not silently upgraded to fresh, so a commit after qmd failure leaves the index correctly marked stale.",
    file: "src/qmdRunner.ts",
    find: "  if (execution.code === 0 && sawIndexedLine) {",
    replace: "  if (true) {",
    mustFail: [
      "qmd failure after commit leaves Markdown authoritative and pre-write or post-rename failures never refresh",
    ],
  },
  {
    id: "transaction-related-record-symlink-swap-blocked-by-realpath-containment",
    property:
      "Once retrieval and the pre-plan authoritative comparison have accepted a related " +
      "record, replacing its file on disk with a symlink to outside the active records " +
      "root — whether before the mutation plan is built or after an approval preview — " +
      "is caught by realpath containment in readCurrent and fails closed rather than " +
      "reading the outside target into the plan or committing over it.",
    file: "src/knowledgeTransaction.ts",
    find: "  if (!pathWithin(recordsRoot, resolvedPath)) {",
    replace: "  if (false) {",
    mustFail: [
      "replacing a related record with an outside symlink before reconciliation planning cannot enter the plan",
      "replacing a planned record with an outside symlink after preview cannot commit or refresh",
    ],
  },
  {
    id: "retrieval-scoped-to-active-collection",
    property:
      "Related-record retrieval invokes qmd scoped to the active space's own collection " +
      "(`-c <qmdCollectionName>`); dropping that scoping flag is caught because the " +
      "process is invoked with the wrong argument vector.",
    file: "src/knowledgeRetrieval.ts",
    find: "[\"search\", query, \"--json\", \"-c\", binding.qmdCollectionName],",
    replace: "[\"search\", query, \"--json\"],",
    mustFail: [
      "the active space excludes a sibling: only the active collection is queried and sibling content enters no plan",
    ],
  },
  {
    id: "retrieval-foreign-collection-locator-rejected",
    property:
      "A qmd hit locator that names a collection other than the active space's own is " +
      "rejected by safeRelativeMarkdownPath's prefix check before any file is resolved; " +
      "disabling that check lets a foreign-collection locator flow through and the " +
      "candidate is accepted as a bare proposal instead of failing retrieval closed.",
    file: "src/knowledgeRetrieval.ts",
    find: "  if (!uri.startsWith(prefix)) return { error: retrievalError(\"foreign_locator\", `qmd locator does not name the active collection: ${JSON.stringify(uri)}`, \"file\") };",
    replace: "  if (false) return { error: retrievalError(\"foreign_locator\", `qmd locator does not name the active collection: ${JSON.stringify(uri)}`, \"file\") };",
    mustFail: [
      "foreign, malformed, escaped, nonzero, and invalid-current qmd results fail closed without a mutation plan",
    ],
  },
  {
    id: "retrieval-qmd-nonzero-exit-fails-closed",
    property:
      "A nonzero qmd search exit code is reported as a retrieval failure before its " +
      "stdout is ever parsed; disabling that check lets a nonzero exit with `[]` stdout " +
      "fall through to the empty-array miss path and the transaction proceeds to a " +
      "proposal instead of failing retrieval closed.",
    file: "src/knowledgeRetrieval.ts",
    find: "  if (execution.code !== 0) {",
    replace: "  if (false) {",
    mustFail: [
      "foreign, malformed, escaped, nonzero, and invalid-current qmd results fail closed without a mutation plan",
    ],
  },
  {
    id: "retrieval-exact-qmd-miss-string-short-circuit",
    property:
      "qmd's literal \"No results found.\" stdout is recognized as an explicit miss " +
      "before JSON parsing is attempted; disabling that short-circuit sends the literal " +
      "string into JSON.parse, which throws, turning what must be a miss into a " +
      "retrieval failure.",
    file: "src/knowledgeRetrieval.ts",
    find: "  if (execution.stdout === \"No results found.\\n\") return { kind: \"miss\", records: [], receipt: policyReceipt };",
    replace: "  if (false) return { kind: \"miss\", records: [], receipt: policyReceipt };",
    mustFail: [
      "exact qmd miss, empty JSON, and a vanished in-space locator are explicit misses",
    ],
  },
  {
    id: "retrieval-vanished-in-space-locator-is-miss-not-failure",
    property:
      "When a qmd-located record's file vanishes between the search hit and the " +
      "realpath resolution of its target path, that ENOENT is treated as an explicit " +
      "miss, not a retrieval failure; disabling that ENOENT check turns a vanished " +
      "in-space locator into a hard failure instead of a miss.",
    file: "src/knowledgeRetrieval.ts",
    find: [
      "  let resolvedTarget: string;",
      "  try {",
      "    resolvedTarget = await realpath(targetPath);",
      "  } catch (error) {",
      "    if (isMissing(error)) return { kind: \"miss\" };",
    ].join("\n"),
    replace: [
      "  let resolvedTarget: string;",
      "  try {",
      "    resolvedTarget = await realpath(targetPath);",
      "  } catch (error) {",
      "    if (false) return { kind: \"miss\" };",
    ].join("\n"),
    mustFail: [
      "exact qmd miss, empty JSON, and a vanished in-space locator are explicit misses",
    ],
  },
  {
    id: "transaction-related-record-race-fails-closed",
    property:
      "A related record's on-disk content re-read by the pre-plan authoritative " +
      "comparison, after retrieval already read a copy of it, is compared against what " +
      "retrieval returned; disabling that comparison lets a related record rewritten in " +
      "that window flow through as if unchanged, producing a proposal instead of an " +
      "invalid outcome with a related_record_changed error.",
    file: "src/knowledgeTransaction.ts",
    find: "    if (canonicalJson(current.value.record) !== canonicalJson(related.record)) {",
    replace: "    if (false) {",
    mustFail: [
      "a related record rewritten after retrieval but before the authoritative comparison fails the transaction closed",
    ],
  },
  {
    id: "qmd-embed-runs-embed",
    property:
      "embedBoundCollection runs `qmd embed`. Running `update` instead refreshes the " +
      "full-text index while leaving the vectors behind vsearch stale for every record " +
      "just written - the regression is invisible until semantic search stops " +
      "returning recent facts.",
    file: "src/qmdRunner.ts",
    find: '  const execution = await runQmd(["embed"], binding, spawnFn);',
    replace: '  const execution = await runQmd(["update"], binding, spawnFn);',
    mustFail: ["embedBoundCollection runs 'qmd embed' and reports embeddings fresh when it succeeds"],
  },
  {
    id: "qmd-embed-failure-reported",
    property:
      "A nonzero embed exit is reported as embeddings-stale. Treating every run as " +
      "success reports fresh embeddings the space does not have.",
    file: "src/qmdRunner.ts",
    find: "  if (execution.code === 0) {",
    replace: "  if (true) {",
    mustFail: ["embedBoundCollection reports embeddings stale rather than silently succeeding when qmd exits nonzero"],
  },
  {
    id: "qmd-embed-never-started-distinct",
    property:
      "An embed process that never started is reported distinctly from one that ran " +
      "and failed, so a missing qmd binary is not diagnosed as a bad embedding model.",
    file: "src/qmdRunner.ts",
    find: "      detail: `qmd embed never started: ${execution.stderr.trim().slice(0, 500)}`,",
    replace: "      detail: `qmd embed did not succeed: ${execution.stderr.trim().slice(0, 500)}`,",
    mustFail: ["embedBoundCollection distinguishes a process that never started from one that ran and failed"],
  },
  {
    id: "checker-dirty-gate-covers-mutable-roots",
    property:
      "The dirty-tree and restoration checks inspect every directory a mutation may " +
      "touch, not only harness/. Narrowing them to harness/ lets the runner mutate a " +
      "pack file whose restoration it never verifies, which is the one guarantee the " +
      "tool provides.",
    file: "scripts/mutation-check.ts",
    find: "  const roots = canonicalMutableRootPaths(repoRoot).map((root) => relative(repoRoot, root) + \"/\");",
    replace: '  const roots = ["harness/"];',
    mustFail: ["the dirty-tree gate covers every directory the registry can mutate"],
  },
  {
    id: "checker-mutation-containment",
    property:
      "A mutation naming a file outside every mutable root is refused before the file " +
      "is read or written. Without containment the runner still exits nonzero, but " +
      "only after mutating and restoring the escaping file - so the property is the " +
      "refusal, not the exit code.",
    file: "scripts/mutation-check.ts",
    find: "  if (!canonicalMutableRootPaths(repoRoot).some((root) => isCanonicalDescendant(root, candidate))) {",
    replace: "  if (false) {",
    mustFail: ["a mutation naming a file outside every mutable root is still refused"],
  },
  {
    id: "cli-pack-single-required",
    property:
      "The CLI requires the active space to declare exactly one required pack. A " +
      "space declaring more than one is refused with a clear error naming the " +
      "count, rather than the CLI guessing which one to use.",
    file: "src/cli.ts",
    find: "  if (active.packs.length !== 1) {",
    replace: "  if (false) {",
    mustFail: ["a space declaring more than one required pack fails closed with a clear error instead of guessing"],
  },
  {
    id: "cli-pack-config-parse-failure-reported",
    property:
      "The CLI reports every pack resolution failure from resolveKnowledgePack " +
      "(pack_from_required, pack_load_failed, pack_export_invalid, " +
      "pack_identity_mismatch) as a validation error and exits non-zero, never " +
      "silently substituting a default pack.",
    file: "src/cli.ts",
    find: '  if (!resolved.ok) printInvalid(resolved.errors.map((error) => `${error.code}: ${error.message}`));',
    replace: "  if (!resolved.ok) printInvalid([]);",
    mustFail: ["the CLI fails closed with pack_from_required when the required pack omits from"],
  },
  {
    id: "cli-pack-resolved-from-space",
    property:
      "knowledge submit/reconcile/approve/reject resolve the pack only from the " +
      "active space's declared id/version/from via resolveKnowledgePack; the CLI " +
      "never hardcodes a pack identity.",
    file: "src/cli.ts",
    find: "  const resolved = await resolveKnowledgePack(declared.id, declared.version, declared.from, active.bindingPath);",
    replace: '  const resolved = await resolveKnowledgePack("fictional-integrity", "0.1.0", declared.from, active.bindingPath);',
    mustFail: [
      "property: knowledge submit with external pack via from field resolves the pack rather than pack_unknown",
    ],
  },
  {
    id: "cli-pack-unknown-fails-closed",
    property:
      "The CLI passes the declared `from` through to resolution and never " +
      "fabricates one, so a required pack that omits from fails closed as " +
      "pack_from_required rather than the CLI substituting any known pack.",
    file: "src/cli.ts",
    find: "  const resolved = await resolveKnowledgePack(declared.id, declared.version, declared.from, active.bindingPath);",
    replace: '  const resolved = await resolveKnowledgePack(declared.id, declared.version, "NO_SUCH_MODULE", active.bindingPath);',
    mustFail: ["the CLI fails closed with pack_from_required when the required pack omits from"],
  },
  {
    id: "loader-pack-external-from-resolved",
    property:
      "resolveKnowledgePack enforces that the loaded module's declared id and " +
      "version exactly match the binding's declared id and version, refusing a " +
      "mismatch as pack_identity_mismatch rather than returning a pack of a " +
      "different identity.",
    file: "src/packLoader.ts",
    find: '    return packError("pack_identity_mismatch", "the external pack module\'s id or version does not match the declared pack");',
    replace: '    if (false) return packError("pack_identity_mismatch", "the external pack module\'s id or version does not match the declared pack");',
    mustFail: ["resolveKnowledgePack refuses a version mismatch as pack_identity_mismatch"],
  },
  {
    id: "presentation-space-view-enumerates-all",
    property:
      "A space-scoped view enumerates every authorized active record under the active " +
      "space's records root without constructing a qmd query.",
    file: "src/presentation.ts",
    find: '  if (viewSnapshot.scope === "space") {',
    replace: '  if (false && viewSnapshot.scope === "space") {',
    mustFail: ["property: a space-scoped view returns every authorized active record with no query supplied"],
  },
  {
    id: "retrieval-enumerated-receipt-no-threshold",
    property:
      "An enumerated retrieval receipt reports no relevance threshold, because " +
      "enumeration never ranked or filtered candidates by score.",
    file: "src/knowledgeRetrieval.ts",
    find: [
      "    relevanceThreshold: null,",
      "    withheld: { audienceId: filter.audienceId, count: 0 },",
    ].join("\n"),
    replace: [
      "    relevanceThreshold: filter.relevanceThreshold,",
      "    withheld: { audienceId: filter.audienceId, count: 0 },",
    ].join("\n"),
    mustFail: ["property: an enumerated receipt reports no relevance threshold, even though the pack declares one"],
  },
  {
    id: "retrieval-enumerated-receipt-no-query",
    property:
      "An enumerated retrieval receipt records query as null instead of fabricating " +
      "a query that never ran.",
    file: "src/knowledgeRetrieval.ts",
    find: '    ...emptyReceipt(binding, null, "miss", "space"),',
    replace: '    ...emptyReceipt(binding, "fictional-profile", "miss", "space"),',
    mustFail: ["property: an enumerated receipt does not fabricate a query"],
  },
  {
    id: "presentation-space-view-query-refused",
    property:
      "A space-scoped view refuses a caller-supplied query instead of ignoring it " +
      "and returning the whole space while the caller believes it was narrowed.",
    file: "src/presentation.ts",
    find: "    if (requestSnapshot.query !== undefined) {",
    replace: "    if (false && requestSnapshot.query !== undefined) {",
    mustFail: ["property: a space-scoped view refuses a caller-supplied query with query_not_scoped"],
  },
  {
    id: "presentation-view-scope-runtime-closed",
    property:
      "A runtime view scope outside search or space is refused before retrieval " +
      "instead of silently selecting search mode.",
    file: "src/presentation.ts",
    find: '  if (view.scope !== "search" && view.scope !== "space") {',
    replace: '  if (false && view.scope !== "search" && view.scope !== "space") {',
    mustFail: ["property: an unknown runtime view scope is refused before retrieval instead of silently selecting search"],
  },
  {
    id: "retrieval-enumeration-symlink-guarded",
    property:
      "Enumeration includes a Markdown symlink as a candidate so the shared " +
      "realpath-containment guard can refuse an escape instead of silently skipping it.",
    file: "src/knowledgeRetrieval.ts",
    find: '    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))',
    replace: '    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))',
    mustFail: ["property: enumeration does not read a record whose real path escapes the records root"],
  },
  {
    id: "release-evidence-binds-artifact",
    property:
      "Release verification evidence is bound to the exact archive checksum, so a result " +
      "recorded for another artifact cannot qualify this release.",
    file: "../release/engram-release.ts",
    find: "    if (artifactHash !== undefined && archiveHash !== undefined && artifactHash !== archiveHash) {",
    replace: "    if (false && artifactHash !== undefined && archiveHash !== undefined && artifactHash !== archiveHash) {",
    mustFail: ["property: release evidence is bound to the exact artifact and source revision"],
  },
  {
    id: "release-runtime-allowlist",
    property:
      "Release staging enumerates only the approved runtime allowlist, so a neighboring " +
      "machine binding cannot enter the artifact merely because Git tracks it.",
    file: "scripts/release-builder.ts",
    find: 'const ALLOWED_FILES = ["bin/engram", "release/engram-release.ts"] as const;',
    replace: 'const ALLOWED_FILES = ["bin/engram", "release/engram-release.ts", "machine-binding.json"] as const;',
    mustFail: ["property: release staging enumerates only the approved runtime allowlist"],
  },
  {
    id: "release-runtime-package-exact",
    property:
      "The packaged runtime metadata contains exactly the three approved keys, preventing " +
      "development scripts or dependency metadata from crossing the artifact boundary.",
    file: "scripts/release-builder.ts",
    find: 'const RUNTIME_PACKAGE = \'{"name":"engram-harness","private":true,"type":"module"}\\n\';',
    replace: 'const RUNTIME_PACKAGE = \'{"name":"engram-harness","private":true,"type":"module","scripts":{}}\\n\';',
    mustFail: ["property: generated runtime package metadata contains exactly three approved keys"],
  },
  {
    id: "release-clean-source-required",
    property:
      "Release candidate construction refuses every tracked or untracked source change " +
      "before staging, so copied bytes remain attributable to the recorded commit.",
    file: "scripts/release-builder.ts",
    find: "  if (status.exitCode !== 0 || status.stdout.length !== 0) {",
    replace: "  if (status.exitCode !== 0 && status.stdout.length !== 0) {",
    mustFail: ["property: release build refuses tracked or untracked source changes before staging"],
  },
  {
    id: "release-bootstrap-independent",
    property: "Installing a first immutable release establishes current without a development checkout.",
    file: "../release/engram-release.ts",
    find: "    return { ok: true, value: { release_id: record.version } };",
    replace: "    return managerFailed(\"install_failed\");",
    mustFail: ["property: bootstrap installs and selects a release after the development checkout is unavailable"],
  },
  {
    id: "release-integrity-before-extract",
    property: "Archive bytes are verified against the release record before archive inspection or extraction.",
    file: "../release/engram-release.ts",
    find: "    sha256Bytes(archive) !== record.artifact_integrity.archive.sha256 ||",
    replace: "    false && sha256Bytes(archive) !== record.artifact_integrity.archive.sha256 ||",
    mustFail: ["property: archive integrity is refused before staging or selection changes"],
  },
  {
    id: "release-archive-path-contained",
    property: "Physical release boundaries reject linked roots and parents before extraction.",
    file: "../release/engram-release.ts",
    find: "function safeReleaseBoundary(parent: string, child: string, directory: boolean, symbolicLink: boolean): boolean {\n  if (!directory || symbolicLink) return false;\n  return isDirectChild(parent, child);\n}",
    replace: "function safeReleaseBoundary(parent: string, child: string, directory: boolean, symbolicLink: boolean): boolean {\n  return true;\n}",
    mustFail: ["property: archive entries cannot escape the staging directory"],
  },
  {
    id: "release-id-immutable",
    property: "An existing immutable release identifier is never replaced.",
    file: "../release/engram-release.ts",
    find: "  try {\n    await lstat(finalPath);\n    return managerFailed(\"release_exists\");",
    replace: "  try {\n    await lstat(finalPath);\n    await makeTreeWritable(finalPath);\n    await rm(finalPath, { recursive: true, force: true });",
    mustFail: ["property: an installed release identifier is never replaced"],
  },
  {
    id: "release-install-lock-exclusive",
    property: "An observed live installation lock prevents concurrent installer ownership.",
    file: "../release/engram-release.ts",
    find: "    if (state === \"live\") return managerFailed(\"install_lock_conflict\");",
    replace: "    if (state === \"live\") return managerFailed(\"install_failed\");",
    mustFail: ["property: concurrent installers cannot strand or remove shared launchers"],
  },
  {
    id: "release-select-pointer-only",
    property: "Selection changes the atomic current pointer rather than release contents.",
    file: "../release/engram-release.ts",
    find: "    await rename(temporary, join(paths.home, \"current\"));",
    replace: "    await rm(join(paths.releases, releaseId), { recursive: true, force: true });\n    await rename(temporary, join(paths.home, \"current\"));",
    mustFail: ["property: selecting a release changes only current"],
  },
  {
    id: "release-rollback-reselects",
    property: "Rollback reselects an earlier immutable release.",
    file: "../release/engram-release.ts",
    find: "  const target = await validatedTarget(releaseId, paths);",
    replace: "  const target = await validatedTarget(\"r0-0000000000000000000000000000000000000000\", paths);",
    mustFail: ["property: rollback reselects the previous immutable release"],
  },
  {
    id: "release-failure-preserves-current",
    property: "A failed installation does not change the active release.",
    file: "../release/engram-release.ts",
    find: "  if (\n    archive.length !== record.artifact_integrity.archive.byte_length ||\n    sha256Bytes(archive) !== record.artifact_integrity.archive.sha256 ||\n    basename(archivePath) !== record.artifact_integrity.archive.filename\n  ) return managerFailed(\"artifact_integrity_mismatch\");",
    replace: "  if (true) return await selectRelease(record.version, options);",
    mustFail: ["property: failed install and selection leave the active release runnable"],
  },
  {
    id: "release-stable-command-current",
    property: "The stable engram launcher follows the current selection.",
    file: "../release/engram-release.ts",
    find: "exec ${quotedShellPath(join(paths.home, \"current\", \"bin\", \"engram\"))} \"$@\"",
    replace: "exec ${quotedShellPath(join(paths.home, \"releases\", \"missing\", \"bin\", \"engram\"))} \"$@\"",
    mustFail: ["property: one stable engram command executes the currently selected release"],
  },
  {
    id: "release-output-content-free",
    property: "Manager failures are projected through the public error boundary.",
    file: "../release/engram-release.ts",
    find: "errors: projectReleaseErrors(result.errors)",
    replace: "errors: result.errors",
    mustFail: ["property: release artifacts and manager output contain no neighboring runtime state — manager projection"],
  },
  {
    id: "omp-extension-registers-engram-capture-tool",
    property: "if the registerTool call in omp-extension.ts is disabled, the test's toolHandler assert at ompExtension.test.ts:130 fails",
    file: "omp-extension.ts",
    find: "api.registerTool({\n    name: \"engram_capture\",",
    replace: "if (false) api.registerTool({\n    name: \"engram_capture\",",
    mustFail: ["ompExtension property: engram_capture tool resolves external pack via from rather than pack_unknown"],
  },
];

/** Uppercase alias for callers that prefer registry-style constants. */
export const MUTATIONS = mutations;
