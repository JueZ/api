# Known issues and unresolved risks

## Test is accepted; production remains intentionally unpromoted

- Deploy Test run `30666921988` accepted exact main commit `6cadc861954af706cd752c022b194c742c0aa6fd` after every infrastructure, package, runtime, authenticated-smoke, telemetry, ledger, and provenance gate passed.
- The previous fail-open auth, ARM settings cycle, boolean casing, Entra GUID, missing service-role, and legacy federated-subject failures are resolved for test.
- Production was not dispatched and remains disabled. A later production request must revalidate current-main ancestry, exact accepted test evidence, production identity/configuration, full authenticated smokes, telemetry, ledger, and rollback bundle before promotion.

## One orphaned GitHub Actions run cannot be cancelled

- Deploy Test run `30663819848` was dispatched while repository Actions was disabled. GitHub retained it as `queued` with zero jobs or check runs and no concurrency-group membership.
- Both normal and force-cancel APIs returned HTTP 500. It did not block the successful replacement run and cannot execute while repository Actions remains disabled.
- Preserve the run as evidence. Retry cancellation through GitHub or support rather than deleting it unless deletion is explicitly approved.

## Granular Entra configuration and new test SPA redirect need privileged verification

- The current operator identity lacks Microsoft Graph permissions needed to inspect or update the API application's delegated scopes/application roles and SPA redirect registrations.
- The split-storage deployment created a new test web origin. A privileged Entra operator must verify the granular scope/role catalogue and register the exact current test redirect URI before browser authentication can be accepted.

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
- First-attempt CI/test pinning, immutable Function activation, activation-last frontend convergence, fail-closed auth, authenticated REST, MCP origin/REC behavior, telemetry correlation, and accepted test provenance are proven by run `30666921988` and its artifacts.
- A live authenticated MCP provider call was not separately executed outside the authenticated workflow smoke. Local API/MCP tests and live unauthenticated MCP REC behavior pass; add a token-safe authenticated MCP smoke to a future workflow change if this must become an explicit deployment gate.
- Bring remains disabled in test, so live Bring read-only behavior and private/session migration remain intentionally unaccepted.

## Angular production bundle warning

- The latest local production build completed with a non-fatal initial-bundle warning: approximately 542.77 kB versus the configured 500 kB warning threshold.
- This is not a correctness failure, but bundle reduction remains worthwhile before the project grows substantially.

## Reddit upstream limitations

- Reddit may block or omit redirects for some `/s/` share URLs. The resolver uses bounded redirects and HTML canonical fallback, but upstream blocking can still prevent resolution.
- Very large threads remain bounded by synchronous comment/expansion/time limits and may return documented partial data. A Blob-backed asynchronous export is future work only if complete huge-thread exports become necessary.
