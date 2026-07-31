# Incident log

## 2026-07-31 — Autonomous review crashed on empty structured output

- Symptom: PR #272 exact-head run `30632059074` reached the OpenAI Responses API with the configured repository secret, but the high-risk review returned no aggregated `output_text`; the controller attempted `JSON.parse('')`, so the review job failed without its required evidence artifact.
- Classification: this was not a missing-key, authentication, or quota failure. The request completed without a surfaced API error, but the response did not contain a usable structured decision.
- Fix: retry an empty or invalid structured response once with a larger output-token allowance, then fail closed with a sanitized rejection artifact if neither bounded attempt yields a valid exact-head decision. Raw model output and error messages are never persisted.
- Review repair: the first bootstrap review correctly identified that parseable output from an incomplete response, or a structurally invalid decision, could end the retry early. Acceptance now additionally requires a completed API response and a valid exact-head decision whose blocking findings agree with its decision.
- Status: bounded fail-closed repair prepared in the bootstrap pull request; live validation still requires an exact-head review artifact and trusted-controller merge.

## 2026-07-31 — Trusted merge controller rejected its own in-progress check state

- Symptom: PR #270 passed every policy-required exact-head CI, Policy Check, CodeQL, and autonomous review check, but controller run `30630495729` rejected the PR because GitHub reported it as `unstable` while the controller's own merge job was in progress.
- Root cause: the controller required REST `mergeable_state` to equal `clean`. GitHub uses `unstable` for a mergeable pull request with a non-passing commit status, creating a self-gating cycle even after the controller had independently verified all configured required checks.
- Fix: accept only `clean` or mergeable `unstable` at the final state gate after exact-head required-check and autonomous-review validation. Continue rejecting behind, dirty, blocked, unknown, forked, stale-head, or otherwise non-mergeable pull requests, and rely on GitHub branch protection as the final merge API gate.
- Status: resolved in PR #270. Exact head `83fdd6314b91be3588debc8fc191089a8ac79431` passed all required checks and an independent high-risk model review, then was squash-merged through a SHA-pinned bootstrap as `5026003ca62ce49c16e76d1dbc57a36a0d56e04c`. Main CI, Policy Check, and CodeQL passed. This follow-up project-memory update is the first end-to-end canary for the fixed controller.

## 2026-07-31 — Test AI-native release failed open to the local-development auth principal

- Symptom: `Deploy Test` run `30629930683` deployed exact main commit `4d82ed8491a32440ec5495049ba39e8f73c6bbac`; `/health` returned that SHA, but unauthenticated `GET /api/hello` returned `200` with subject `local-dev-placeholder` instead of the required `401`.
- Impact: the test release is not accepted. Authenticated smoke, telemetry correlation, and accepted test provenance did not run. Production was not dispatched and remains unchanged.
- Evidence: Bicep deployment succeeded with `authEnabled=true`, while runtime behavior followed the disabled-auth development path. The deployment principal cannot read effective Function app settings. Separately, the Functions package entry point is `dist/functions/*.js`, which bypasses `dist/index.js` and its fail-closed `assertRuntimeSafety()` bootstrap.
- Preceding repairs: the first retry supplied missing safe test configuration. The second retry followed a bounded, no-overwrite migration of the required WLH reference blob into private test storage with independent SHA-256 verification. Both deployment repair attempts are exhausted for this loop.
- Required fix: route Azure Functions startup through the fail-closed bootstrap, make app-settings deployment explicit and verifiable, add regressions, then start a fresh test deployment cycle. A privileged operator must also verify granular Entra scopes/roles and the new test SPA redirect URI.
- Status: unresolved; production promotion blocked.

## 2026-07-25 — Bring batch writes used the wrong private payload and rejected valid empty success responses

- Symptom: production Bring list reads succeeded, while `bring_add_items` reproducibly returned the generic MCP error `upstream_unavailable` and created no item.
- Evidence: the deployed client sent `{ items, operation }` to the correct private batch endpoint. Current community protocol tests use `{ changes, sender }`, per-item `itemId`/`spec` fields, location placeholders, and operation values `TO_PURCHASE`, `TO_RECENTLY`, or `REMOVE`. Live verification also confirmed that successful mutations return an empty body and the current list response nests `purchase`/`recently` under `items`.
- Root cause: the initial integration selected the correct endpoint but invented an incompatible batch request shape, used legacy web client identity headers that current writes reject, and required JSON on every successful response. MCP error mapping then collapsed the upstream rejection into a generic error, and the MCP path did not emit the available upstream diagnostic metadata.
- Fix: encode the established private batch shape and client identity headers, accept empty successful mutation responses, normalize the current nested list response, retain a bounded redacted non-auth response excerpt in server-only diagnostics, emit safe structured telemetry, and return specific MCP Bring classifications with an optional numeric upstream status.
- Status: fix and staged production verification pending.

## 2026-05-17 — Production authenticated smoke rejected service token after variables were added

- Symptom: `Promote Production` run `25995591995` deployed main commit `2c2584e2f89b5d80404b589d058dfa4ad88276e7`, runtime `/health` passed, and GitHub OIDC minted a production service smoke token, but authenticated `GET /api/hello` returned `403`.
- Impact: Production promotion failed closed after deployment verification; unauthenticated runtime smoke and test deployment were healthy, but the production authenticated smoke gate remained blocked.
- Root cause: The API only classified app-only service tokens as service auth when the token carried `idtyp: app`. Microsoft Entra app-only tokens can instead be roles-only tokens with client-credential auth-method claims, so they were routed through the user allowlist path and rejected.
- Fix: Classify roles-only Microsoft Entra tokens with `azpacr` or `appidacr` as service auth only when they also match the explicit service-client allowlists; delegated tokens with `scp` still require the user and delegated-client allowlists.
- Status: Code fix proposed; staged CI, Deploy Test, Promote Production, and production authenticated smoke are pending.

## 2026-05-16 — Test deployment smoke failed after Reddit repairable error contract merge

- Symptom: After PR #140 merged, `Deploy Test` run `25972007955` deployed commit `2898d1a` but smoke tests saw `/health` and `/api/hello` return `404` for all 18 readiness attempts.
- Evidence: The failed run showed the Functions package was built from `apps/api/package.json`; the new LLM analyzer imports the official OpenAI SDK, but only the root `package.json` included `openai`. The deployed Functions package therefore lacked a runtime dependency needed during function indexing.
- Fix: PR #142 added `openai` to `apps/api/package.json` and `apps/api/package-lock.json` so the Azure Functions run-from-package artifact installs the SDK in production/test packages.
- Status: Resolved. PR #142 passed PR CI/policy checks, `Deploy Test` run `25972181952` passed smoke tests, and `Promote Production` run `25972223775` passed production smoke tests.

## 2026-05-14 — Production browser auth verified after trailing-slash issuer fix

- Symptom resolved: Production browser calls to protected `GET /api/hello` no longer return `401 Invalid bearer token` for the signed-in `mkos_postat@outlook.com` account.
- Verification: Manual browser test returned `authenticated: true`, `message: Hello, Martin`, and populated subject, object ID, and tenant ID fields.
- Resolution: PR #86 added the exact trailing-slash Microsoft Entra v1 issuer alias; production promotion run `25858636629` deployed it successfully.
- Status: Resolved; continue treating `/api/hello` as protected when `AUTH_ENABLED=true`.


## 2026-05-14 — Microsoft Entra v1 issuer alias missed trailing slash

- Symptom: Authenticated production browser calls to `GET /api/hello` continued returning `401 Invalid bearer token` after PR #83.
- Evidence: Application Insights request telemetry showed recent `hello` requests returning `401`, traces showed `Authentication failed: invalid_token`, exceptions were empty, and safe app-setting comparisons showed audience, required scope, tenant entry, and user object entry matched the browser token claims.
- Root cause: PR #83 derived `https://sts.windows.net/<tenant>` but Microsoft Entra v1 access tokens emit the exact issuer as `https://sts.windows.net/<tenant>/`. Exact issuer matching rejected the token before authorization reached scope or user checks.
- Fix: Add the trailing-slash v1 issuer alias while retaining exact audience, scope or role, tenant, and user checks.
- Status: Code fix proposed; deployment and manual browser retest pending.
- Update: PR #86 deployed the fix via production promotion run `25858636629`; manual browser retest remains pending.


## 2026-05-14 — Microsoft Entra v1 access token rejected by v2 issuer-only config

- Symptom: Production Angular sign-in succeeded, but authenticated `GET /api/hello` returned `401 Invalid bearer token`.
- Impact: Manual end-to-end browser verification for the protected API remained blocked.
- Root cause: The SPA received a Microsoft Entra v1 access token whose issuer used the tenant-specific `sts.windows.net` form, while production backend configuration included the tenant-specific Microsoft Entra v2 issuer and did not include the v1 issuer alias. Signature verification therefore failed before allowlist checks, even though safe comparisons showed the token tenant, object ID, and scope matched configured policy.
- Fix: Derive Microsoft Entra v1 issuer aliases from configured tenant-specific v2 issuers and verify each issuer with its own discovered JWKS.
- Status: Code fix merged in PR #83 and deployed by production promotion run `25857793354`; manual browser retest is pending.

## 2026-05-14 — Production protected API call blocked by CORS preflight

- Symptom: Production Angular sign-in completed for the user, but the protected `/api/hello` call failed with a browser CORS error because the preflight response lacked `Access-Control-Allow-Origin`.
- Impact: Authenticated browser verification of `/api/hello` is blocked even though API smoke tests for unauthenticated `401` continue to pass.
- Fix: Configure Function App platform CORS for the deployed Angular origin and add preflight validation to deployment smoke tests.
- Status: Resolved by PRs #66, #67, #70, #73, and #75 plus successful production promotion run `25855907807`.

## 2026-05-14 — Deploy Test failed after first CORS fix because test redirect URI is unset

- Run `25854845137` failed during deployment configuration validation because the first CORS fix made `TEST_WEB_AUTH_REDIRECT_URI` required whenever the test frontend deploys, but the repository currently leaves that variable unset.
- Follow-up: keep test CORS validation conditional on a configured test redirect URI; production still uses `WEB_AUTH_REDIRECT_URI` for the production Angular origin.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Production CORS smoke needed propagation retry

- Promote Production run `25855047988` applied the Function App platform CORS configuration, but the immediate smoke preflight check ran before CORS headers were visible at the production endpoint and failed closed.
- Direct verification shortly after the failed run showed the production preflight returned `Access-Control-Allow-Origin: https://stapicatalogueprodbfjsts.z6.web.core.windows.net`, so the configuration was correct but needed bounded retry in smoke tests.
- Follow-up: add bounded retry around CORS preflight validation after deployment.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Production CORS smoke header parser split URL value

- Promote Production run `25855376487` failed because the smoke parser split `Access-Control-Allow-Origin: https://...` on colon characters and compared only `https` to the expected origin.
- Direct endpoint behavior remained correct; the failure was in smoke-test parsing, not in the deployed CORS configuration.
- Follow-up: parse the CORS header by removing only the header-name prefix and preserving the full URL value.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Production health route needed explicit restart/readiness retry

- Promote Production run `25855574430` failed because `/health` returned `404` immediately after package deployment even though function metadata existed. A direct Azure Resource Manager restart with a non-empty body restored `/health` to `200`.
- Follow-up: use an explicit ARM restart call that includes a request body and add bounded readiness retry for `/health` and unauthenticated `/api/hello` before CORS preflight smoke validation.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Personal Microsoft account token rejected by single issuer config

- Symptom: after CORS was fixed, the production Angular call to protected `/api/hello` reached the API but returned `401` with `Invalid bearer token`.
- Root cause: the configured backend issuer accepted only the organization tenant issuer, while the signed-in `mkos_postat@outlook.com` browser session uses the Microsoft account tenant issuer.
- Fix: allow comma-separated accepted issuer URLs in `OIDC_ISSUER`; deployment configuration must add the explicit Microsoft account issuer, tenant ID, and stable home-account object ID while retaining the existing allowlist.
- Status: Code/config fix deployed by PR #77 and production promotion run `25856534002`; manual browser retry is pending to confirm the authenticated response.

## 2026-05-14 — Multi-issuer auth still used first issuer JWKS

- Symptom: production continued returning `401 Invalid bearer token` for the signed-in personal Microsoft account after PR #77 and production promotion run `25856534002`.
- Root cause: the backend accepted multiple exact issuer strings but, without an explicit `OIDC_JWKS_URI`, discovered JWKS only from the first configured issuer. A token from the personal Microsoft account issuer can have a valid issuer but fail signature validation against the organization issuer JWKS.
- Fix: verify tokens by trying each configured exact issuer with that issuer's own discovered JWKS endpoint, without logging token material.
- Status: Code fix deployed by PR #80 and production promotion run `25857092220`; manual browser retry is pending to confirm the authenticated response.


Entries are reverse chronological.

## 2026-05-17 — Protected browser calls still time out before reaching API

- Symptom: after PR #147 deployed, browser calls to protected endpoints still reported MSAL `timed_out`, while `/health` remained healthy.
- Evidence: production `/health` returned `200`, unauthenticated `/api/hello` returned the expected `401`, Function App state was `Running`, and Application Insights had only low-latency health/unauthenticated hello requests with no recent auth exceptions or timeout traces. This indicates the failing browser flow times out during MSAL token acquisition before calling the API.
- Root cause update: PR #147 only skipped bootstrapping after an embedded iframe already had an MSAL auth response. The SPA can still bootstrap inside the initial silent-renew iframe load at the redirect URI before Entra returns, which keeps Angular/MSAL running in a child frame during the silent flow.
- Follow-up fix: make every embedded iframe inert so only the top-level window initializes MSAL and Angular.
- Status: Resolved. Follow-up PR #149 deployed to production by Promote Production run `25985918836`; smoke tests passed, and manual browser verification on 2026-05-17 confirmed that sign-out/sign-in cleared stale MSAL session state and protected calls worked again.


## 2026-05-14 — Production promotion falsely failed after smoke success

- Symptom: `Promote Production` run `25852035606` concluded `failure` even though production deployment and smoke tests passed.
- Root cause: The reusable deployment workflow attempted to update repository variables after smoke tests using `GITHUB_TOKEN`, and GitHub returned `HTTP 403: Resource not accessible by integration` for the variables API.
- Fix: Make the post-smoke repository-variable update idempotent/best-effort so metadata rewrite failures do not create a false production deployment failure.
- Prevention / lesson: Keep deployment and smoke failures fail-closed, but avoid coupling successful production health to non-critical repository metadata rewrites unless a token with documented permissions is intentionally used.
- Links: Workflow run `25852035606`; readiness follow-up PR.

## 2026-05-14 — HTTP 503 after deployment

- Symptom: Production Function App returned HTTP 503 after deployment.
- Root cause: Function App was configured with Node 24, while Azure Functions Node v4 programming model support for this app was validated with Node 22/20/18.
- Fix: Change the Function App runtime to Node 22.
- Prevention / lesson: Keep Azure Functions runtime versions aligned across docs, infrastructure, CI, and production. Validate new Node versions before adopting them.
- Links: PR #34 fixed Node runtime to 22.

## 2026-05-14 — Storage upload/RBAC failure

- Symptom: GitHub Actions deployment could not upload blob/package artifacts.
- Root cause: GitHub OIDC principal had resource `Contributor` but lacked `Storage Blob Data Contributor` for Azure Storage data-plane operations.
- Fix: Grant the deployment identity the required storage data-plane role at the appropriate scope.
- Prevention / lesson: Azure resource-plane roles do not automatically grant blob data-plane upload permissions.
- Links: Related production-failure issue set included issue #28.

## 2026-05-14 — SAS expiry failure

- Symptom: Deployment failed when creating a user delegation SAS with a 30-day expiry.
- Root cause: User delegation SAS expiry cannot exceed 7 days.
- Fix: Use a SAS expiry within the allowed 7-day window.
- Prevention / lesson: Keep SAS lifetimes short. Later workflow updates replaced SAS-backed `WEBSITE_RUN_FROM_PACKAGE` with managed-identity package access.
- Links: Related production-failure issue set included issue #28.

## 2026-05-14 — Static website upload failure

- Symptom: Angular static site upload failed because the `$web` container was unavailable.
- Root cause: Static website hosting had not been enabled, so the `$web` container did not exist.
- Fix: Enable static website hosting before uploading frontend files.
- Prevention / lesson: Confirm hosting feature prerequisites before artifact upload steps.
- Links: Related production-failure issue set included issue #28.

## 2026-07-25 — Codex main delivery skipped when workflow-run PR association was empty

- **Symptom:** Bring! PRs #257–#259 merged, but each `Codex Main Delivery` run skipped `run main delivery after Codex auto-merge`; no test or production deployment started from those runs.
- **Root cause:** The completed `Codex Auto-Merge` `workflow_run` payload contained no `pull_requests[0]`, and `codex-main-delivery.yml` treated the missing PR number as inapplicable instead of resolving the PR from the immutable head SHA.
- **Recovery:** Dispatched guarded `main` CI for merge `2f888aea0ff622629d723557731ad06ef716d970`; the normal `workflow_run` chain then started Deploy Test and Promote Production. A duplicate manually dispatched Deploy Test run was cancelled after the automatic test run started.
- **Prevention:** Main delivery now queries GitHub's commit-associated-pulls endpoint when the workflow-run payload omits its PR array, while preserving the existing merged-PR, ancestry, CI, test, production, smoke, telemetry, and runtime-truth gates.

## 2026-07-25 — Bring GET/add route conflict in production

- **Symptom:** Production `/health` remained reachable, but Application Insights repeatedly reported `bringGetItems` in error and Bring item access was unavailable or unreliable.
- **Root cause:** `bringGetItems` and `bringAddItems` were registered as separate Azure Functions with the identical `api/bring/lists/{listUuid}/items` route. The Node Functions host rejected the duplicate route even though the registrations used different HTTP methods.
- **Fix:** Register one `bringItems` Function for `GET`, `POST`, and `OPTIONS`, and dispatch GET versus add semantics inside the protected handler. Complete and remove routes remain separate because their paths are unique.
- **Prevention:** API tests assert method dispatch through `bringItems` and statically assert that the shared item route is registered only once.
