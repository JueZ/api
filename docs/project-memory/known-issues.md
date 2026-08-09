# Known issues and unresolved risks

## Phase 3 automatic learning rollout is not yet accepted

- Branch `codex/agent-learning-phase-3-triage` implements the rollout-bounded extension to repair triage, but no protected PR, merge, exact-main CI, scheduled write, or idempotent live candidate evidence exists yet.
- Until that evidence is accepted, significant post-rollout repair issues are not proven to create or update learning candidates automatically. Do not backfill historical issues without an exact manually dispatched range; backfill defaults to dry run and is bounded to 100 issue numbers.
- Repository tests are evidence of deterministic behavior only. They do not prove GitHub label permissions, issue-marker persistence, candidate linking, scheduled rerun idempotency, or closure behavior on the live repository.

## Main Delivery artifact contract incident is resolved

- PR #386 merged exact head `af3c3131d7dd9cb842c273e9e4bef4582bb33f5f` as `a56a932393a885976ad85f56df6cf3ba0f142e1b` after all four protected aggregates passed. Main Delivery `31329669160` then failed before main CI because the post-merge consumer requested the removed `autonomous-review-*` artifact contract.
- PR #388 merged the exact artifact, evaluator, decision, and trigger-head binding as `2a616bbe76fa2bf972fee68d51714ebacdffc143`. Main Delivery `31330087561`, exact-main CI `31330102189`, Deploy Test `31330187457`, and Promote Production `31330356402` passed with public/authenticated smoke, telemetry, test provenance, and both ledgers. Issue #387 is closed.
- Merge `a56a932393a885976ad85f56df6cf3ba0f142e1b` remains without independent runtime evidence, but its code is contained in later accepted runtime generation `2a616bbe76fa2bf972fee68d51714ebacdffc143`. Do not rewrite the historical failure as a pass.

## Historical Main Delivery canonicalization over-groups unrelated triggers

- PR #385 exact repair head `b88703cfa0ecb2c7d512c0030a4ebc4ad073a19b` passed every free aggregate, then protected controller `31329139128` failed closed while verifying historical Phase 2 evidence. Main Delivery run `31279667347` is the exact successful lineage triggered by autonomous-governance run `31279529529`, but later skipped runs for unrelated trigger IDs share implementation merge SHA `9310c94f97541e57f83b186af2cacf989d6f5330` and were incorrectly treated as superseding it.
- PR #385 closed unmerged after one formatting repair; no merge, deployment, model call, or runtime acceptance exists. Issue #359 records recurrence count 6 and artifact `historical-main-delivery-lineage` records the implemented disposition.
- PR #386 merged the narrow repair selecting canonical Main Delivery records within the independently derived exact trigger title while still rejecting a later duplicate/failure for that same trigger. PR #388 subsequently delivered that code through terminal test and production runtime evidence.

## Phase 2 evidence verification is accepted

- PR #376 exact head `d6f207117e770aabc7b7baa4414c35f4d318072a` passed all free aggregates, but autonomous review run `31319465352` rejected the acceptance design because `Autonomous review complete` was published before the protected program-evidence verifier ran in the later merge job.
- Branch protection intentionally requires exactly four stable aggregates and does not separately require `merge exact PR head`. PR #375's bounded bootstrap merge proved that ordinary protected merge can remain available after the later verifier fails. The verifier therefore must participate in the existing review aggregate rather than relying only on autonomous-controller merge behavior or adding a fifth context.
- PR #378 delivered the issue #377 aggregate-boundary correction as merge `f56422021640b34be2588c33999f63b59a87399a` with terminal delivery/runtime evidence. PR #385 proved the required deterministic aggregate invokes the verifier and fails closed on invalid canonical history.
- PR #389 passed the required deterministic historical verifier and merged as `c71db002a86ac82f1076f6e6fe031c4bbc2b91b7`. Main Delivery `31330909296`, exact-main CI `31330924386`, Deploy Test `31331003596`, and Promote Production `31331166859` passed with public/authenticated smoke, telemetry, provenance, and ledgers. Phase 2 is accepted; preserve this section as historical fail-closed evidence.

## Identical-compare compatibility is delivered; durable learning remains

- PR #372 proved that the protected evidence verifier runs after independent review and before merge, but job `93255754296` rejected an exact controller/protected-main comparison because GitHub omitted `head_commit` for `status: identical`.
- Compatibility PR #375 merged the bounded fix as `f7ec8cbb4d9bc44fecd9a833c3d7cc483f6974f2` and completed exact-main CI, test/production delivery, smoke, telemetry, release-ledger, and fresh runtime verification. Omitted `head_commit` is accepted only for the fully bound identical case; non-identical comparisons retain exact head binding and fail closed.
- Issue #374 remains open because operational recovery is not a versioned learning artifact. It still requires the recurrence fingerprint, executable regression reference, and exact broken/fixed counterfactual proof through an ordinary protected PR.

## Phase 2 acceptance evidence is delivered

- PR #349 implemented and delivered the versioned-learning system. PR #389 subsequently exercised the trusted verifier at the required aggregate boundary and completed terminal post-merge runtime delivery. Public-safe evidence is archived at `docs/agent-learning/evidence/phase-2-versioned-artifacts.json`.
- PR #350 closed after its second repair because environment identity was not independently bound. PR #352 final head `54d76353d72d5342f4b7f3944b58d384a95b7075` passed all free gates, but autonomous review `31301156652` rejected the design because it exported an authenticated Actions/deployment token to scripts from the PR checkout. The same review found that generic HTTPS origins plus default redirects permit SSRF/redirect escape.
- PR #354 moved authenticated verification into protected-main controller code and repaired the runtime-host, redirect, byte-bound, digest, and candidate/controller identity boundaries. Its final head `0fef86e2de488545970507f362e2abbc974681ca` passed CI `31305790271`, Policy Check `31305790288`, and CodeQL `31305790267`, but autonomous review `31305789487` found that generic authenticated evidence was not pinned to designated Phase 2 implementation PR #349. It closed unmerged after both repairs.
- PR #358 and library-only successor #362 also closed unmerged after their two-repair limits. PR #362 final exact head `1f53529064742eb7d224eb3362b88aa6e3f52aa7` passed CI `31310187492`, Policy Check `31310187489`, and CodeQL `31310187546`, but autonomous review `31310186793` rejected an ambiguous implementation-commit/final-head claim and controller code checked only against a caller-provided SHA.
- Library PR #364 closed after both repairs. Final head `c44278942e5c9252e529959487ad20c9e355c1a1` passed same-head CI retry `31312184558`, Policy Check `31312184559`, and CodeQL `31312184545`, but controller `31312367284` stopped before model generation when the exact-input estimate exceeded the unchanged cost ceiling by `$0.002460`. No review approval, merge, or runtime evidence exists.
- PRs #367, #369, #371, #375, and #378 delivered the trusted primitives, orchestration, controller invocation, identical-compare compatibility, and required-aggregate boundary with terminal evidence. PRs #386 and #388 delivered the issue #359 lineage and post-merge artifact-contract repairs, and PR #389 exercised the complete protected verifier before completing post-merge runtime proof. Phase 2 is accepted; keep ordinary PR CI tokenless and retain every artifact, identity, history, workflow, and runtime boundary. No waiver substitutes for proof.

## Test and production are accepted on the same immutable release

- Main CI `30744552173`, Deploy Test `30744611475`, and Promote Production `30744732911` accepted exact commit `e8e1070b4a4f2e67b9d60b97a3586bf16b3bfeea` after exact-generation, runtime, authenticated-smoke, telemetry, ledger, and provenance gates passed.
- Codex Auto-Merge, Codex Main Delivery, Deploy Test, and Promote Production are active for normal autonomous delivery. Any future main release still requires fresh exact-main CI/test evidence and the complete production promotion gates.
- Production repair issues #294 and #308-#310 remain resolved. Rollback remains separately authorized rather than part of the automatic forward-delivery chain.

## Review-permission successor is accepted in test

- PR #286 exhausted its two autonomous-review repairs and is closed as superseded by PR #287.
- PR #287 exact-head CI, Policy Check, and CodeQL passed. The provenance and paid-boundary findings were repaired, but final review run `30687126474` rejected the optional service-identity verifier's incomplete whole-identity validation.
- The operator removed repository-side service-identity setup/audit from scope. PR #289 repaired the predecessor review findings and GitHub claim integration. Reviews then exposed omitted executable helpers, insufficient output allowance for the complete diff, omitted classified security/ADR documentation in mixed capsules, and a second output exhaustion once that context was included. The accepted repair includes every non-documentation path and every high-risk document under the unchanged 200 KB and `$0.31` gates, reserves final-JSON capacity, and uses a 3,500-token static output allowance.

Update: PR #289 merged as `7907708d3db92a698bbfb549cb8ccfa91a1e86c8`; PR #290 merged the fail-closed monthly budget rollover repair as `5d9e3cc87ed0f8e18e70544b6b1587ae2ddcf56c`. Deploy Test `30695340416` accepted the successor after Bicep, runtime, authenticated smokes, telemetry, ledger, provenance, and independent live bundled-MCP verification all passed.

## One orphaned GitHub Actions run cannot currently be deleted

- Deploy Test run `30663819848` was dispatched while repository Actions was disabled. GitHub retained it as `queued` with zero jobs or check runs and no concurrency-group membership.
- Autonomous-review run `30693764586` is a second zero-job orphan created when its workflow was disabled before scheduling. Replacement run `30693881648` acquired the only durable paid-call claim; the orphan cannot make an OpenAI request for that consumed head.
- Normal and force-cancel APIs returned HTTP 500, and the deletion API returned HTTP 403. Restoring the normal controllers for accepted deliveries did not materialize or execute either orphan. The paid-review head is permanently consumed and both records remain obsolete zero-job platform artifacts.
- The operator explicitly authorized historical-run cleanup, but GitHub has not exposed a successful removal path. Keep the identifiers documented and retain accepted deployment/security-review evidence; their continued presence is not a reason to disable normal delivery.

## Remaining private/session storage migration requires review

- The required WLH reference blob was copied to the split private test storage with no overwrite and an independently verified digest before the final test deployment.
- Bring private/session state may still reside in the previous storage layout. Bring is disabled in test; any future migration requires a reviewed inventory, backup, copy, digest comparison, access test, and rollback plan.

## Test reads the configured Bring account

- This is an accepted decision, not accidental credential sharing: test is structurally read-only and cannot call mutation operations.
- Test may still see allowlisted real list metadata/items. The read-only canary must stay disabled until its dedicated `bring.read` identity and target list are verified.
- Undocumented provider write compatibility is covered by sanitized fixtures and guarded production rollout, not by a live mutation canary.

## Remaining live acceptance criteria

- An intentionally failing or pending-check PR must be shown unable to merge.
- High-risk exact-head deterministic governance and no-bypass branch rules must be verified on GitHub.
- First-attempt CI/test pinning, immutable Function activation, activation-last frontend convergence, fail-closed auth, authenticated REST, MCP origin/REC behavior, telemetry correlation, and accepted test provenance are proven by run `30695340416`, its artifacts, and independent live probes.
- A live authenticated MCP provider call was not separately executed outside the authenticated workflow smoke. Local API/MCP tests and live unauthenticated MCP REC behavior pass; add a token-safe authenticated MCP smoke to a future workflow change if this must become an explicit deployment gate.
- Bring remains disabled in test, so live Bring read-only behavior and private/session migration remain intentionally unaccepted.

## Angular production bundle warning

- The latest local production build completed with a non-fatal initial-bundle warning: approximately 542.77 kB versus the configured 500 kB warning threshold.
- This is not a correctness failure, but bundle reduction remains worthwhile before the project grows substantially.

## Reddit upstream limitations

- Reddit may block or omit redirects for some `/s/` share URLs. The resolver uses bounded redirects and HTML canonical fallback, but upstream blocking can still prevent resolution.
- Very large threads return documented partial data with continuation handles. Expansion defaults to zero and is bounded per call by 10 provider requests, 20 seconds, a provider quota reserve, and one active request per principal in each Function worker.
- The concurrency gate is not distributed across Azure scale-out. A shared quota store is future work only if telemetry shows the hard per-call limits are insufficient; a Blob-backed asynchronous export remains the preferred design if complete huge-thread exports become necessary.
