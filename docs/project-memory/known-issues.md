# Known issues and unresolved risks

## Phase 2 acceptance still lacks a merged trusted verifier

- PR #349 implemented and delivered the versioned-learning system, but Phase 2 acceptance evidence is not yet protected by a merged trusted verifier.
- PR #350 closed after its second repair because environment identity was not independently bound. PR #352 final head `54d76353d72d5342f4b7f3944b58d384a95b7075` passed all free gates, but autonomous review `31301156652` rejected the design because it exported an authenticated Actions/deployment token to scripts from the PR checkout. The same review found that generic HTTPS origins plus default redirects permit SSRF/redirect escape.
- PR #354 moved authenticated verification into protected-main controller code and repaired the runtime-host, redirect, byte-bound, digest, and candidate/controller identity boundaries. Its final head `0fef86e2de488545970507f362e2abbc974681ca` passed CI `31305790271`, Policy Check `31305790288`, and CodeQL `31305790267`, but autonomous review `31305789487` found that generic authenticated evidence was not pinned to designated Phase 2 implementation PR #349. It closed unmerged after both repairs.
- Keep ordinary PR CI tokenless. The successor must retain every #354 boundary and bind Phase 2 to exact PR #349, baseline `eab88f735d3644181d2a043156970f0df02e3ff8`, branch `codex/agent-learning-phase-2-artifacts`, head `7188188cc0b3fd1a58a5ee14ae5335158294135c`, and merge `9310c94f97541e57f83b186af2cacf989d6f5330`, with negative tests for every mismatch. Issues #351, #355, and #356 remain open; no waiver or passing proof exists.

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
