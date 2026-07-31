# Known issues and unresolved risks

## Test deployment is not yet accepted after protected auth failed open

- PR #264 and main CI/policy passed, and test run `30629930683` deployed exact commit `4d82ed8491a32440ec5495049ba39e8f73c6bbac`, but the runtime gate failed: unauthenticated `GET /api/hello` returned `200` as `local-dev-placeholder` instead of `401`.
- The Azure deployment received `authEnabled=true`, while the effective Function worker behaved as if `AUTH_ENABLED` was false or missing. The focused repair makes app settings an explicit resource and validates the complete Bicep-managed key set plus every approved non-secret value after normal deployment and read-only before rollback; the streamed Azure response is never persisted and secret values are neither emitted nor compared.
- The focused repair loads `dist/index.js`, executes `assertRuntimeSafety()` before registration, and independently rejects disabled authentication outside local development. Local regression coverage passes; live test deployment still must prove the behavior.
- Test environment origin placeholders were corrected to the exact Function origin without reading or changing secrets. Infrastructure and workflow validation now reject `https://null` and the test frontend derives its API base from the deployed Function output.
- Authenticated smoke, telemetry correlation, and accepted test provenance remain pending until the focused repair merges and deploys. Production must not be promoted from this release.

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

## Remaining live acceptance criteria require external proof

- An intentionally failing or pending-check PR must be shown unable to merge.
- High-risk exact-head independent review and no-bypass branch rules must be verified on GitHub.
- Exactly one first-attempt CI/test chain must be observed. The exact CI run ID/correlation must remain pinned through test provenance and any later promotion. Function, SBOM, and frontend-source digests must match promotion evidence; each environment-rendered frontend digest must match its manifest, deployment settings, ledger, and preserved production bundle.
- Test runtime SHA is proven, but fail-closed auth, authenticated REST/MCP behavior, MCP origin, Bring read-only behavior, telemetry correlation, accepted provenance, storage/RBAC boundaries, and production promotion gates still require test/live evidence.

## Angular production bundle warning

- The latest local production build completed with a non-fatal initial-bundle warning: approximately 542.77 kB versus the configured 500 kB warning threshold.
- This is not a correctness failure, but bundle reduction remains worthwhile before the project grows substantially.

## Reddit upstream limitations

- Reddit may block or omit redirects for some `/s/` share URLs. The resolver uses bounded redirects and HTML canonical fallback, but upstream blocking can still prevent resolution.
- Very large threads remain bounded by synchronous comment/expansion/time limits and may return documented partial data. A Blob-backed asynchronous export is future work only if complete huge-thread exports become necessary.
