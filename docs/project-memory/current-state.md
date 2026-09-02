<!-- project-memory-asOf: 2026-08-31 -->
# Current state

## Repository delivery

- Codex environment setup and maintenance remove inherited `apt.llvm.org` entries before APT refreshes because the repository does not require LLVM or Clang; Ubuntu plus the explicitly configured Microsoft and GitHub repositories remain signature-verified.
- Protected `main` requires exactly `PR Gate` and `Security Gate` from GitHub Actions, with strict/up-to-date PRs, admin enforcement, linear history, conversation resolution, force-push denial, and deletion denial.
- Repository-native exact-head squash auto-merge is enabled. No custom merge controller, check-run writer, arbitrary status rollup, or required model review exists.
- `PR Gate` and `Security Gate` use one fail-closed path classifier. Pull requests run proportional validation and never build release artifacts.
- The root/build and standalone `apps/api` Function manifests are independent dependency projects. Both receive pair-local lock policy, audit, Dependabot, CodeQL, and Trivy coverage; the release CycloneDX SBOM describes the exact installed production Function stage.
- `Delivery v2` is the sole normal controller. A push to protected `main` classifies runtime impact, builds one immutable release when applicable, verifies test, promotes the same application digests to production, and verifies production without per-task deployment approval. Runtime-affecting work remains incomplete until its applicable runtime evidence passes.
- `DELIVERY_V2_ENABLED=true` and `DEPLOY_PRODUCTION_ENABLED=true`. Production and one-shot package rollback share `production-deployment` concurrency.
- The repair queue creates or updates one sanitized issue per exact run/failure fingerprint. It cannot invoke Codex or rewrite repository files. Two ineffective attempts retire one repair strategy rather than the task; a bounded generation that ends first leaves an active continuation for later applicable unblocked repository work. A protected workflow-dispatch path records schema-sanitized advisory progress against an exact source run, and an exact expected candidate SHA links protected-main repair generations without carrying state into unrelated candidates.

## Runtime and security

- Test and production use Azure OIDC, managed identity/Key Vault boundaries, exact release SHA/digests, public and authenticated smoke, telemetry correlation, provenance, and compact release ledgers.
- Test and production retain Application Insights, delivery telemetry verification, smoke checks, budget notifications, and action groups, but intentionally have no scheduled-query alerts; Delivery v2 removes the retired Function 5xx, OAuth spike, and Bring protocol rules after infrastructure deployment.
- Authentication requires an explicit `local`, `test`, or `prod` runtime identity. Non-local tenant allowlists are enforced again at the request boundary; delegated `scp` and app-role service permissions are classified separately; and discovered JWKS metadata is issuer-bound, redirect-free, and same-origin while an explicit JWKS URI remains an operator-managed pin.
- Authenticated Reddit/WLH JSON bodies are streamed through a shared 64 KiB boundary after authorization; declared and streamed overages fail with 413 before provider work. Reddit provider payloads cannot become public error details, telemetry omits raw caller input and uses route-normalized allowlisted URLs, and deployed MCP binds single-value proxy headers plus request authority to a non-localhost, non-IP canonical HTTPS origin.
- Exhaustive Reddit comment retrieval is an explicit resumable operation shared by REST `POST /api/reddit/thread/comments` and MCP `reddit_get_thread_page`. It stores append-only normalized comments and a deduplicated Reddit traversal frontier in a private Blob snapshot, resumes through signed opaque cursors without refetching the initial listing, and distinguishes frontier exhaustion from submission coverage. Its deterministic discovery plan includes every supported Reddit sort (with `qa` last); consuming the final network-request budget unit also finalizes a drained final frontier locally without an empty resume call. It reports complete only after all views converge without an unexplained arithmetic gap against the highest `num_comments` observed; inaccessible branch estimates remain separate diagnostics rather than evidence that the gap was reconciled. Ordinary overview and thread tools remain bounded and cheap.
- Bring mutation integrity v2 binds replay identity and confirmation tokens to the action, list, payload, client, token type, and tenant-tagged object-ID-or-subject principal. Durable results require the exact consumed-token HMAC, encrypted payloads use record-bound AAD, and legacy v1 records/tokens are retained but never replayed or decrypted.
- Authentication, authorization, operation permissions, audit, idempotency, destructive confirmation, allowlists, and provider-data minimization remain fail closed.
- Optional OpenAI use is restricted to bounded sanitized runtime repairable-error analysis. Pull-request governance, repair callbacks, and required checks use no provider key.

## Learning and memory

- Significant and recurring failures use executable prevention plus concise schema-v2 learning artifacts. Hard invariants remain mechanically protected; reusable architectural guidance is advisory and may be bounded by scoped counterevidence. Learning validation runs only when learning files or their validator change.
- Completed phase ledgers, historical acceptance evidence, required model-review gates, workflow hashes, and chronological project-memory logs have been removed. The lean local historical Codex task harness remains advisory and outside merge or delivery eligibility. GitHub and Git history are the execution record.
- Query live GitHub/Azure/runtime state for the current deployed SHA and workflow outcome; do not copy routine run narration into this file.
