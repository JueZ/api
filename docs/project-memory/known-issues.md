# Known issues and unresolved risks

## Model-free governance migration has a protected bootstrap dependency

- The repository owner directed removal of the API-backed high-risk reviewer and restricted OpenAI API use to runtime repairable-error classification.
- The replacement is complete locally at `c5791b8c3148906ee58e467e9a0f1166f6398ea9` on `codex/remove-independent-model-review`: `Autonomous review complete` remains the stable required context but becomes deterministic exact-head governance with the protected program-evidence verifier and complete-rollup merge defense intact.
- Live protected main still contains the old provider-backed controller. Pushing this high-risk migration would cause that old controller to request the now-forbidden review, while changing protection or bypassing it would weaken the live gate. No passing migration evidence exists yet.

## Phase 2 evidence verification is not yet part of the required aggregate

- PR #376 exact head `d6f207117e770aabc7b7baa4414c35f4d318072a` passed all free aggregates, but autonomous review run `31319465352` rejected the acceptance design because `Autonomous review complete` was published before the protected program-evidence verifier ran in the later merge job.
- Branch protection intentionally requires exactly four stable aggregates and does not separately require `merge exact PR head`. PR #375's bounded bootstrap merge proved that ordinary protected merge can remain available after the later verifier fails. The verifier therefore must participate in the existing review aggregate rather than relying only on autonomous-controller merge behavior or adding a fifth context.
- Issue #377 requires executable prevention. The current successor runs the existing verifier inside the protected-main review job after independent review, makes that combined job result control `Autonomous review complete`, removes duplicate later verification, and retains complete-rollup enforcement. PR #376 closed unmerged with zero repair pushes; Phase 2 remains `in_progress` with no evidence-retry merge or runtime claim.

## Identical-compare compatibility is delivered; durable learning remains

- PR #372 proved that the protected evidence verifier runs after independent review and before merge, but job `93255754296` rejected an exact controller/protected-main comparison because GitHub omitted `head_commit` for `status: identical`.
- Compatibility PR #375 merged the bounded fix as `f7ec8cbb4d9bc44fecd9a833c3d7cc483f6974f2` and completed exact-main CI, test/production delivery, smoke, telemetry, release-ledger, and fresh runtime verification. Omitted `head_commit` is accepted only for the fully bound identical case; non-identical comparisons retain exact head binding and fail closed.
- Issue #374 remains open because operational recovery is not a versioned learning artifact. It still requires the recurrence fingerprint, executable regression reference, and exact broken/fixed counterfactual proof through an ordinary protected PR.

## Phase 2 acceptance still lacks exercised required evidence

- PR #349 implemented and delivered the versioned-learning system, but its acceptance evidence has not yet exercised the trusted verifier at the required aggregate boundary.
- PR #350 closed after its second repair because environment identity was not independently bound. PR #352 final head `54d76353d72d5342f4b7f3944b58d384a95b7075` passed all free gates, but autonomous review `31301156652` rejected the design because it exported an authenticated Actions/deployment token to scripts from the PR checkout. The same review found that generic HTTPS origins plus default redirects permit SSRF/redirect escape.
- PR #354 moved authenticated verification into protected-main controller code and repaired the runtime-host, redirect, byte-bound, digest, and candidate/controller identity boundaries. Its final head `0fef86e2de488545970507f362e2abbc974681ca` passed CI `31305790271`, Policy Check `31305790288`, and CodeQL `31305790267`, but autonomous review `31305789487` found that generic authenticated evidence was not pinned to designated Phase 2 implementation PR #349. It closed unmerged after both repairs.
- PR #358 and library-only successor #362 also closed unmerged after their two-repair limits. PR #362 final exact head `1f53529064742eb7d224eb3362b88aa6e3f52aa7` passed CI `31310187492`, Policy Check `31310187489`, and CodeQL `31310187546`, but autonomous review `31310186793` rejected an ambiguous implementation-commit/final-head claim and controller code checked only against a caller-provided SHA.
- Library PR #364 closed after both repairs. Final head `c44278942e5c9252e529959487ad20c9e355c1a1` passed same-head CI retry `31312184558`, Policy Check `31312184559`, and CodeQL `31312184545`, but controller `31312367284` stopped before model generation when the exact-input estimate exceeded the unchanged cost ceiling by `$0.002460`. No review approval, merge, or runtime evidence exists.
- PRs #367, #369, #371, and #375 delivered the trusted primitives, orchestration, controller invocation, and identical-compare compatibility with terminal evidence. After issue #377's aggregate-boundary correction is delivered, the public-safe evidence PR must exercise the complete verifier while Phase 2 remains `in_progress`; only a later protected ledger PR can mark acceptance after the evidence PR's post-merge proof exists. Keep ordinary PR CI tokenless and retain every artifact, identity, history, workflow, and runtime boundary. Open learning issues still require versioned dispositions; no waiver substitutes for proof.

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
- High-risk exact-head independent review and no-bypass branch rules must be verified on GitHub.
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
