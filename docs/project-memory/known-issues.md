# Known issues and unresolved risks

## Test runtime is healthy; authenticated service-role acceptance remains blocked

- PR #283 and test run `30652787906` resolved the preceding startup/auth-setting chain. Exact-SHA health, unauthenticated `401`, and CORS now pass.
- Authenticated `/api/hello` returns `403` for the dedicated GitHub-OIDC-backed smoke identity. Effective tenant/client/issuer/audience/allowlist wiring correlates, leaving Entra app-role assignment as the unverified boundary.
- The current Codex Azure service principal lacks Microsoft Graph directory permission and cannot inspect or assign the required `catalogue.read,reddit.read` application roles. Use `scripts/configure-entra-service-oauth.sh` from a trusted checkout under a privileged Entra operator.
- The new preflight will confirm exact version-specific identity and role-set mismatches without logging claims. Test telemetry/provenance and production promotion remain blocked until a new first-attempt run passes every gate.

## Local plaintext credentials require external rotation

- An untracked local Codex environment file was contained with owner-only permissions and is now covered by repository ignore/hygiene policy; it was not found in Git history.
- Ignoring and permission-hardening do not revoke credentials. Rotate every affected GitHub, Azure, and provider credential externally, then replace the local values through the supported environment setup without committing them.
- Repository delivery and Azure data migration are intentionally held by exact no-input static blocks and `.github/security-deployment-hold.json`. Production enablement is false. Repository Actions and native auto-merge are disabled; seven OIDC/mutation workflows remain manually disabled; both deployment environments accept protected branches only; and the custom GitHub OIDC subject intentionally invalidates the old Azure federation.
- GitHub required status checks do not bind a workflow/event. All Actions workflows use App ID `15368`, and this user-owned repository rejected a required-workflow ruleset, so a same-repository workflow could otherwise access repository secrets and spoof check names. Do not re-enable Actions until the exposed GitHub credential is revoked and an independent trusted workflow/App/security approver boundary is available.
- The hold cannot be cleared by repository-local data: GitHub is affected, and the only collaborator is the implicated owner identity. Evidence may be recorded while `active=true`; `active=false` is invalid until an independent out-of-band trust root is bootstrapped after GitHub credential revocation. Security-control paths cannot auto-merge. A privileged operator must then replace Azure FICs with exact repository/context/workflow-bound subjects, preserve a separate Reader-only diagnostic identity, enable test only, and require a fresh passing first-attempt test run before production is reconsidered.

## Explicit Log Analytics workspace migration is deferred

- Application Insights currently uses Azure-managed workspaces. A repository-owned workspace improves predictable retention/capping but relinking does not move historical telemetry.
- Deliver the workspace, cap alert, read-back validation, and cost note in a dedicated test-first PR. Preserve old managed resource groups for at least 90 days before reviewed cleanup.

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
- The fresh workflow repair must prove in test that the Function runtime points at the exact SHA-256-verified immutable blob version, and that the active static container contains exactly the approved frontend names and downloaded bytes after activation-last replacement and stale-blob removal. A mutable package URL, overwrite-only upload, or deleting the active site's stale files before replacement verification is not accepted as exact-release evidence.
- Test runtime SHA is proven, but fail-closed auth, authenticated REST/MCP behavior, MCP origin, Bring read-only behavior, telemetry correlation, accepted provenance, storage/RBAC boundaries, and production promotion gates still require test/live evidence.

## Angular production bundle warning

- The latest local production build completed with a non-fatal initial-bundle warning: approximately 542.77 kB versus the configured 500 kB warning threshold.
- This is not a correctness failure, but bundle reduction remains worthwhile before the project grows substantially.

## Reddit upstream limitations

- Reddit may block or omit redirects for some `/s/` share URLs. The resolver uses bounded redirects and HTML canonical fallback, but upstream blocking can still prevent resolution.
- Very large threads remain bounded by synchronous comment/expansion/time limits and may return documented partial data. A Blob-backed asynchronous export is future work only if complete huge-thread exports become necessary.
