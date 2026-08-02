# Known issues and unresolved risks

## Codex Security Linux sandbox compatibility remains upstream-sensitive

- PR #315's two paid scans ran on GitHub Ubuntu 24.04, authenticated, accrued cost, and then produced no draft artifacts. The seal error was downstream: without scan-agent shell/write capability, `scan-manifest.json`, `findings.json`, and `coverage.json` never existed.
- The workflow pins its isolated advisory job to supported Ubuntu 22.04 and adds a credential-free sandbox write probe before the credential boundary. This avoids weakening AppArmor or disabling the Codex sandbox, but it depends on GitHub continuing to offer that runner and on the bundled Codex runtime retaining compatible sandbox behavior.
- Do not treat a passed probe as scan evidence. A usable scan still requires a sealed manifest, complete coverage, valid findings, and successful SARIF export. Re-evaluate the runner pin when OpenAI publishes a documented compatible CLI/runtime; require both the probe and a sealed canary before removing it.

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
- Very large threads remain bounded by synchronous comment/expansion/time limits and may return documented partial data. A Blob-backed asynchronous export is future work only if complete huge-thread exports become necessary.
