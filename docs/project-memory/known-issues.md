# Known issues and unresolved risks

## Local hardening is not operational

- The working tree is intentionally uncommitted and has no PR, remote CI, or exact-head review evidence.
- Live branch/ruleset enforcement, high-risk review configuration, GitHub variables/environments, Entra scopes/roles/federation, Azure RBAC, Key Vault references, resource migration, and deployment behavior remain unverified.
- Until those controls are configured and proven, the repository must not be treated as safe for unattended merge or production promotion.

## Storage migration is required before infrastructure cutover

- Existing WLH reference data and Bring private/session state may reside in the current storage layout.
- A reviewed inventory, backup, copy, digest comparison, access test, and rollback plan are required before switching to split storage. The local Bicep change alone does not migrate data.

## Test reads the configured Bring account

- This is an accepted decision, not accidental credential sharing: test is structurally read-only and cannot call mutation operations.
- Test may still see allowlisted real list metadata/items. The read-only canary must stay disabled until its dedicated `bring.read` identity and target list are verified.
- Undocumented provider write compatibility is covered by sanitized fixtures and guarded production rollout, not by a live mutation canary.

## Live acceptance criteria still require external proof

- An intentionally failing or pending-check PR must be shown unable to merge.
- High-risk exact-head independent review and no-bypass branch rules must be verified on GitHub.
- Exactly one CI/test/production chain and identical test/production artifact digests must be observed.
- Test auth, MCP origin, Bring read-only behavior, telemetry correlation, release ledger, runtime SHA, storage/RBAC boundaries, and production promotion gates require test/live evidence.

## Angular production bundle warning

- The latest local production build completed with a non-fatal initial-bundle warning: approximately 542.77 kB versus the configured 500 kB warning threshold.
- This is not a correctness failure, but bundle reduction remains worthwhile before the project grows substantially.

## Reddit upstream limitations

- Reddit may block or omit redirects for some `/s/` share URLs. The resolver uses bounded redirects and HTML canonical fallback, but upstream blocking can still prevent resolution.
- Very large threads remain bounded by synchronous comment/expansion/time limits and may return documented partial data. A Blob-backed asynchronous export is future work only if complete huge-thread exports become necessary.
