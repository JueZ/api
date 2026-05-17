# Current state

## 2026-05-17 Production authenticated smoke 403 follow-up

- After the user added the service OAuth variables, `Deploy Test` run `25995539881` passed for main commit `2c2584e2f89b5d80404b589d058dfa4ad88276e7`, but `Promote Production` run `25995591995` failed in `ops:smoke:auth` because authenticated `GET /api/hello` returned `403`.
- Evidence from the failed run showed the production service auth variables were present and a short-lived production smoke token was minted through GitHub OIDC; the runtime health check reported the expected deployed commit before the authenticated API call failed.
- Follow-up code treats Microsoft Entra roles-only app tokens as service tokens when they lack the optional `idtyp: app` marker but include a client-credential auth-method marker (`azpacr` or `appidacr`) and still match the explicit service-client allowlists. Delegated tokens with `scp` remain on the user allowlist path.
- Production promotion remains blocked until this fix merges and the staged delivery workflow re-runs successfully.

## 2026-05-17 Main delivery duplicate-run selection hardening

- After PR #164, `Codex Main Delivery` run `25995336424` observed the intended `Deploy Test` workflow_dispatch run `25995380284` succeed for main commit `9f231ce`, but then selected a later duplicate cancelled deploy-test run `25995395316` for the same commit and failed the delivery chain.
- Follow-up hardening changes the main-delivery run selector to prefer any completed successful run for the requested workflow/commit/event before treating a later failed or cancelled duplicate as terminal.

## 2026-05-17 Deploy Test reusable-workflow permission repair

- PR #160 removed PR-level repair issue creation and merged, but post-merge `Codex Main Delivery` run `25995173110` failed when the dispatched `Deploy Test` run `25995214818` ended in `startup_failure`.
- Root cause: `deploy-test.yml` calls the reusable `deploy-environment.yml`, whose declared permissions include `issues: write` for the shared production-failure issue step. Even though the test path does not create production issues, the caller must still grant the reusable workflow's requested permission set at startup.
- Follow-up repair restores `issues: write` on `Deploy Test`; production issue creation remains limited by the `inputs.environmentName == 'prod'` condition in the reusable workflow.


## 2026-05-17 PR repair issue creation removed

- Routine PR `CI` and `Policy Check` failures now stay in the active Codex delivery loop instead of creating `codex-repair` GitHub issues.
- The former `.github/workflows/codex-autofix.yml` workflow only opened/commented repair tickets and did not actually invoke Codex or push fixes, which created stale issues after PRs recovered, merged, or closed.
- Production deployment and production smoke-test failures still create visible repair issues because post-merge failures may not have an active PR to hold failure context.
- The operational guardrail scanner now ignores negated safety guidance such as "do not disable policy checks" while still blocking actual added instructions to disable CI or policy checks; the Policy Check workflow now relies on the tested `ops:policy-guardrails` script instead of a second ad hoc grep pass.


## 2026-05-17 Reddit Repairable Error Contract public diagnostics hardening

- The Reddit thread Repairable Error Contract now uses `urn:diagnostic:<diagnostic_id>` as the public Problem Details `instance`, so callers can correlate a concrete diagnostic occurrence without treating the endpoint path as the instance.
- Public Reddit REC fallback responses no longer expose deep Reddit fetch diagnostics such as request/final URLs, redirect chains, or response previews; diagnostic capsules keep sanitized shape-only data and mask sensitive request field names.
- The REC validator accepts JSON Pointer and JSONPath-style top-level request paths for diagnostic fields, keeps JSON Patch paths pointer-only, and classifies unknown internal service exceptions as `service_bug_likely` while preserving safe public detail.


## 2026-05-17 Reddit post input normalization hardening

- The Reddit thread ingestion path now normalizes raw post IDs, `t3_` fullnames, canonical comments URLs, comment permalinks, `redd.it` links, and Reddit `/r/<subreddit>/s/<token>` share URLs before constructing OAuth comments API requests.
- Share URLs are treated as opaque redirect URLs and are never fetched by appending `.json` directly; unresolved or non-canonical share redirects remain structured caller-contract errors.
- Reddit upstream JSON parsing failures now use structured `RedditFetchError` diagnostics with request/final URL, status, content type, redacted response preview, redirect chain, and retryability metadata for API problem responses.


## 2026-05-17 Repairable Error LLM diagnostics configuration wiring

- GitHub repository secret `OPENAI_API_KEY` and variables `REPAIRABLE_ERRORS_LLM_ENABLED=true` / `REPAIRABLE_ERRORS_LLM_MODEL=gpt-5.5` were configured for deployment automation; secret values are not stored in project memory.
- Direct Azure Function app-setting mutation from the Codex Azure CLI identity was blocked by missing `Microsoft.Web/sites/config/list/action`, so PR #152 wired the deployment workflow to pass the GitHub secret/variables into Bicep-managed Function App settings for both test and production deployments.
- PR #152 merged at `c9e5751`; PR CI and Policy Check passed, `Deploy Test` runs `25986717911` and `25986766513` passed smoke tests, and `Promote Production` run `25986757289` passed production smoke tests.


## 2026-05-16 Reddit thread input hardening follow-up deployed

- Follow-up analysis found that resolving Reddit `/s/` share URLs by unauthenticated web redirects can still fail when Reddit returns a web 403 instead of a redirect, and a raw ID such as `1tav2fa` may be a comment ID rather than a post ID.
- PR #144 resolved share URLs through Reddit OAuth `api/info?url=...` before falling back to bounded Reddit-only redirects; if an initial raw-ID thread fetch returns not found, the endpoint looks up `t1_<id>` with `api/info` and fetches the parent `t3_<post_id>` thread when available.
- PR #144 also tolerates documented URL alias fields as input fallbacks while still preserving `post` as the canonical request field. Main commit `659b674` completed CI run `25972576401`, Deploy Test run `25972596333`, and Promote Production run `25972641970`; workflow smoke tests passed and Codex host checks confirmed production `/health` returns `200`, unauthenticated Reddit thread POST returns `401`, and the frontend root returns `200`.

## 2026-05-16 Codex auto-merge deployment dispatch follow-up live

- Root cause found after PR #134: GitHub-native auto-merge executed by the Actions `GITHUB_TOKEN` can merge to `main` without triggering the normal `push`-based `CI` workflow, so the subsequent `Deploy Test` and `Promote Production` chain may not run.
- PR #135 added `Codex Main Delivery` and validation for main commit `8cf55a7` showed the normal CI -> Deploy Test -> Promote Production path succeeds when CI is manually dispatched. PR #136 then showed that a GitHub-token `workflow_dispatch` of `main` CI did not trigger the downstream `workflow_run` deployment chain for commit `248ade2`.
- PR #137 changed `Codex Main Delivery` to orchestrate the full post-merge chain explicitly: wait for `main` CI, dispatch and wait for `Deploy Test`, then dispatch and wait for `Promote Production`, while still honoring explicit deployment skip markers. Commit `06d05f3` was manually deployed through `Deploy Test` run `25968770752` and `Promote Production` run `25968813057`; production smoke tests passed.



## 2026-05-16 Reddit Repairable Error Contract deployed after package-manifest repair

- PR #140 merged and passed PR CI/policy checks, but `Deploy Test` run `25972007955` failed smoke readiness with `/health` and `/api/hello` returning `404`.
- Root cause evidence indicated the deployed Functions package used `apps/api/package.json`, which did not include the newly imported OpenAI SDK. PR #142 added `openai` to the Functions package manifest and lockfile so function indexing can load the LLM analyzer module.
- PR #142 passed PR CI/policy checks, merged, and completed main delivery: `CI` run `25972157195`, `Deploy Test` run `25972181952`, and `Promote Production` run `25972223775` all succeeded; production smoke tests passed.

## 2026-05-16 Reddit Repairable Error Contract implementation

- The protected `POST /api/reddit/thread` endpoint now returns Repairable Error Contract problem responses for invalid JSON and mapped Reddit service failures, using `application/problem+json` with diagnostic IDs and sanitized caller repair guidance.
- LLM-assisted analysis is isolated behind `REPAIRABLE_ERRORS_LLM_ENABLED` and `OPENAI_API_KEY`; it sends only a sanitized diagnostic capsule to OpenAI, validates/policy-gates the model output, and falls back deterministically if disabled, unavailable, timed out, invalid, or unsafe.
- Deterministic fallback remains the availability and safety baseline for JSON parse failures, unresolved Reddit `/s/` share URLs, 403/404/429 upstream responses, and 5xx dependency failures.

## 2026-05-16 Reddit share URL normalization in progress

- Reddit thread requests using Reddit short share URLs like `/r/<subreddit>/s/<token>` are being updated to follow Reddit's redirect to the canonical `/comments/<post_id>/...` URL before extracting the article ID.
- If a Reddit share URL cannot be resolved to a canonical comments URL, the endpoint now returns a structured `UNRESOLVED_REDDIT_SHARE_URL` input error rather than proceeding with an empty or ambiguous response path.

## 2026-05-16 GPT Actions OAuth documentation placement follow-up

- GPT Actions delegated OAuth setup is now documented in both the operational authentication setup guide and the OAuth security guide. The setup guide lists the dedicated GPT Action app registration, repository variable, helper script flow, GPT Builder values, and troubleshooting. The security guide now clarifies that GPT Actions are delegated-user clients controlled by `OIDC_ALLOWED_DELEGATED_CLIENT_IDS`, while app-only service clients remain controlled by `OIDC_ALLOWED_APP_OBJECT_IDS` / `OIDC_ALLOWED_CLIENT_IDS`.
- README now points readers to the setup guide for GPT Actions OAuth and to the security guide for allowlist semantics.

## 2026-05-15 production deployment gap resolved for security-finding main head

- Codex reviewed open PRs #81, #112, #118, #120, and #121. None were merged: #118 and #81 were empty/no-op against current `main`; #112 contained useful duplicate regression-test intent but stale project-memory text; #120 and #121 conflicted with current `main` and would need rebase before reconsideration.
- Current `main` commit `91be4e72dae0a10bad79488125714899bd543f61`, which includes the service-token security fix from PR #119 (`fa1faef`), completed manually dispatched `CI` run `25917321823`, CI-triggered `Deploy Test` run `25917361131`, and `Promote Production` run `25917450342`.
- Production smoke tests passed in the workflow and from the Codex host: `/health` returned `200`, unauthenticated `/api/hello` returned `401`, production-origin CORS preflight returned `204`, and the frontend root returned `200`.
- Production remains available at <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/> for the Angular frontend and <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net> for the Function API.


## 2026-05-15 production verification after security-finding merges

- Production is reachable at <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/> for the Angular frontend and <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net> for the Function API.
- Manual smoke checks on 2026-05-15 confirmed production `/health` returns `200`, unauthenticated `/api/hello` returns `401`, the browser origin CORS preflight for `/api/hello` returns `204`, and the frontend root returns `200`.
- Important deployment gap: security-finding commit `fa1faef` from PR #119 had successful PR CI/policy checks and was merged, but the latest successful production promotion remained run `25890832782`, which deployed commit `e40533b`. No successful CI-triggered Deploy Test/Promote Production run for a `main` head that includes `fa1faef` was present during this verification.
- Runtime state checked through Azure CLI: production Function App `func-api-catalogue-prod-bfjstshehpbfk` is `Running`, uses `NODE|22`, has HTTPS-only enabled, and exposes `health`, `hello`, and `redditThread` functions.


Last updated: 2026-05-16

## 2026-05-14 Codex host git remote repair in progress

- Current Codex checkout had GitHub CLI authentication for `JueZ/api` but no configured git remote, which can make final PR URL reporting fail even after the local commit and PR metadata are recorded.
- Fix in progress: Codex setup and maintenance scripts now add a missing git `origin` remote for `JueZ/api` (or `CODEX_GITHUB_REPOSITORY` when explicitly set) without printing secrets or deploying code.

## 2026-05-14 production deployment source hardening in progress

- Aardvark reported that production rollback/promote could deploy operator-supplied branches or tags and run checked-out npm lifecycle/build scripts after Azure OIDC login, while setup docs also allowed no production reviewers and standing production RBAC-admin access.
- PR #107 remediated the related Aardvark finding that the reusable deployment workflow exposed `REDDIT_CLIENT_SECRET` at job scope while building an operator-selected deployment ref. Deployment callers now pass only the Reddit secret explicitly, the reusable workflow no longer exports that secret to checkout/install/build steps, and the secret remains scoped to the Bicep infrastructure step.
- Fix in progress: deployment workflows validate refs before Azure login and only allow immutable commits that are ancestors of `main`; branch and tag inputs are rejected. This follow-up additionally requires every deployment to have a successful `CI` workflow run for the exact commit. Production deployments require a successful CI-triggered `Deploy Test` workflow run for that commit and a matching provenance artifact proving test deployed the same commit with both Functions and frontend deployment enabled before any production Azure login, build, infrastructure, or secret-bearing step runs.
- Setup docs now require an independent production reviewer, prevent self-review, and document `Role Based Access Control Administrator` only as a temporary bootstrap exception that must be revoked.
- Production promotion run `25890276402` passed for PR #107, including deployment and smoke tests for the production Function App and static web storage account.

## 2026-05-14 service-token detection hardening in progress

- Aardvark reported that a roles-only token with an allowlisted `azp`/`appid` but without an unambiguous app-only marker could be classified as a service token and bypass the delegated user allowlist.
- Fix in progress: service-token classification now requires `idtyp=app`; roles-only tokens without that marker remain on the delegated user allowlist path even when they include an allowlisted client ID.

## 2026-05-14 app-only OAuth service-client auth implementation

- Backend authorization now supports Microsoft Entra app-only OAuth client-credentials tokens alongside delegated user tokens. User tokens remain gated by `OIDC_ALLOWED_OBJECT_IDS`/`OIDC_ALLOWED_SUBJECTS`; app-only tokens are gated separately by `OIDC_ALLOWED_APP_OBJECT_IDS` and/or `OIDC_ALLOWED_CLIENT_IDS` after issuer, audience, tenant, and required scope/role validation.
- Deployment wiring now passes the service-client allowlist variables into Azure Function App settings. The recommended test-zone setup is an Entra API app role such as `api.test`, a dedicated service-client app registration, and a GitHub Actions OIDC federated credential instead of a client secret.
- Codex attempted to inspect Entra app registrations with the current Azure CLI identity, but Microsoft Graph returned insufficient privileges. The repo now includes `scripts/configure-entra-service-oauth.sh` so an identity with app-registration permissions can complete the Azure/GitHub configuration from Cloud Shell.

## 2026-05-14 GitHub Actions Node 24 and production variable warning follow-up

- Workflow maintenance moved first-party actions to Node 24-compatible major versions and replaced `gitleaks/gitleaks-action@v2` with the Gitleaks CLI to avoid the remaining Node.js 20 action runtime warning.
- The production deployment reusable workflow no longer tries to mutate repository variables with `GITHUB_TOKEN` after smoke tests, because the workflow token cannot write repository variables. Instead, it records the resolved production URL, Function App, and storage account in the run summary after smoke tests pass.
- Production runtime resolution now prefers fresh Bicep deployment outputs and treats repository variables as fallbacks, reducing reliance on stale repository variable values.

## 2026-05-14 Reddit default expansion budget increased

- Follow-up after testing a Reddit thread that returned `stats.truncated=true` at `moreChildrenRequests=50`: the default omitted-comment expansion budget was raised so normal requests continue well past the old 50-request cutoff and can retrieve all nested comments unless the larger safety limits, Reddit rate limits, or timeout budget are reached.
- Current synchronous defaults: `maxComments=10000`, `maxMoreChildrenRequests=1000`, and a longer internal timeout budget. Reddit content is still fetched on demand and not persisted.

## 2026-05-14 Reddit thread endpoint in progress

- A protected `POST /api/reddit/thread` endpoint is being added for authenticated Microsoft Entra callers. It uses app-only Reddit OAuth, fixed Reddit OAuth API endpoints, in-memory token caching, nested comment normalization, sequential `morechildren` expansion, and safety limits for huge threads.
- Required runtime setting names are `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT`; values must remain in GitHub/Azure configuration only and must not be committed or documented.
- Reddit content is fetched on demand and is not persisted by the API.
- v1 limitation: very large Reddit threads above safety limits may return partial data with `stats.truncated=true`; an async Blob-backed job model can be considered later if full huge-thread exports are needed.

## 2026-05-14 production browser auth verified end-to-end

- Manual production browser verification succeeded after the trailing-slash Microsoft Entra v1 issuer fix. The signed-in account `mkos_postat@outlook.com` called protected `GET /api/hello` successfully and received the authenticated response for Martin with subject, object ID, and tenant ID populated.
- This confirms production browser MSAL sign-in, token acquisition, Function App CORS, JWT issuer/JWKS/audience/scope validation, tenant gating, and server-side user gating are working together for the configured user.
- Current production endpoint truth: `/health` remains public; unauthenticated `/api/hello` returns `401`; authenticated `/api/hello` returns the v0 authenticated hello payload for the configured user.



## 2026-05-14 Microsoft Entra v1 issuer trailing-slash follow-up

- A browser retry after PR #83 still returned `401 Invalid bearer token`; Application Insights showed repeated `Authentication failed: invalid_token` traces for `hello`, with no `403` authorization failures and no exception records.
- Safe production configuration checks showed the configured audience, required scope, tenant allow entry, and user object entry matched the browser token claims; this points to token validation, not the server-side user gate.
- Root cause: Microsoft Entra v1 access tokens use an exact issuer with a trailing slash (`sts.windows.net/<tenant>/`), while PR #83 derived the `sts.windows.net` issuer alias without that trailing slash. The verifier uses exact issuer matching, so signature/claim validation failed before the user gate.
- Fix in progress: derive both slash and no-slash same-host v1 aliases and the trailing-slash `sts.windows.net` alias for tenant-specific Microsoft Entra v2 issuers.
- Update: PR #86 was merged and deployed by production promotion run `25858636629`; production smoke tests passed. The remaining step is an interactive browser retry with a fresh token.

## 2026-05-14 Microsoft Entra v1 access token issuer follow-up

- Manual browser retry of protected `GET /api/hello` still returned `401 Invalid bearer token` after issuer-specific JWKS support.
- Safe production app-setting comparisons showed auth enabled, the token tenant and object ID present in the allowlists, the required scope configured, and the tenant-specific Microsoft Entra v2 issuer configured, but not the Microsoft Entra v1 `sts.windows.net` issuer emitted by the browser access token.
- The code fix now derives the Microsoft Entra v1 issuer alias for configured tenant-specific v2 issuers so the API can validate v1 access tokens for the same tenant while still enforcing exact audience, required scope/role, allowed tenant IDs, and allowed object IDs/subjects.
- Update: PR #83 was merged and deployed by production promotion run `25857793354`; production smoke tests passed after deployment.
- Remaining manual step: retry **Call hello with access token** in the browser because automation does not have an interactive user token.


## 2026-05-14 production CORS follow-up

- Manual browser sign-in now reaches the signed-in Angular state for `mkos_postat@outlook.com`, but calling protected `GET /api/hello` from the production static website failed in the browser because the Azure Functions CORS preflight response did not include `Access-Control-Allow-Origin` for the production static website origin.
- The follow-up fix configured Function App platform CORS from the deployed frontend redirect URI and added deployment smoke checks for authenticated-browser preflight behavior.

## 2026-05-14 production CORS resolution

- Production browser sign-in reached signed-in state, and the follow-up platform CORS fix has now been deployed successfully.
- Current production verification after run `25855907807`: `GET /health` returns `200`, unauthenticated `GET /api/hello` returns `401`, and browser preflight from the production Angular origin is allowed.
- Remaining manual step: retry **Call hello with access token** in the browser to verify the allowlisted authenticated response end-to-end.

## 2026-05-14 personal Microsoft account token issuer follow-up

- Manual browser retry after the CORS fix reached the API, but production returned `401` with `Invalid bearer token`. The signed-in account was `mkos_postat@outlook.com`, whose MSAL home account tenant segment is the Microsoft account tenant `9188040d-6c67-4c5b-b112-36a304b66dad`.
- PR #77 added comma-separated `OIDC_ISSUER` support so the backend can validate both the existing organization issuer and the explicit personal Microsoft account issuer while still enforcing exact audience, required scope, allowed tenant IDs, and allowed object IDs. It was deployed by production promotion run `25856534002`.

## 2026-05-14 issuer-specific JWKS follow-up

- Manual browser retry still returned `401 Invalid bearer token` after multi-issuer deployment because PR #77 accepted multiple issuer strings but still used only the first issuer's JWKS discovery URI for signature verification.
- PR #80 fixed multi-issuer verification so, when `OIDC_JWKS_URI` is not explicitly set, each configured issuer is verified with its own discovered JWKS endpoint. It was deployed by production promotion run `25857092220`.

- Project name: JueZ API Catalogue.
- Repository: `JueZ/api`.
- Goal: personal API catalogue platform.
- Frontend: Angular app in `apps/web`.
- Backend: Azure Functions TypeScript app in `apps/api`.
- API contract: `contracts/openapi.yaml`.
- Frontend API catalogue: Angular renders endpoint documentation, request payload fields, response schemas, examples, and browser try-it controls by loading the `contracts/openapi.yaml` build asset at runtime; generated web OpenAPI copies are intentionally not committed.
- Infrastructure: `infra/main.bicep`.
- Azure resource groups: `rg-api-test` for test and `rg-api-prod` for production.
- Azure region: `westeurope`.
- Test API base URL: <https://func-api-catalogue-test-iwt54bovfzvrc.azurewebsites.net>.
- Test Angular static website URL: <https://stapicataloguetestiwt54b.z6.web.core.windows.net/>.
- Test Function App: `func-api-catalogue-test-iwt54bovfzvrc`.
- Test static website storage account: `stapicataloguetestiwt54b`.
- Production API base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular static website URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Production Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Production static website storage account: `stapicatalogueprodbfjsts`.
- Azure Functions runtime: Node 22.
- Current code on `main` includes OAuth/OIDC JWT validation, a server-side user allowlist, protected `GET /api/hello` behavior when `AUTH_ENABLED=true`, Angular MSAL sign-in/token acquisition, OpenAPI bearer security, and Bicep auth app settings.
- Current deployment endpoint truth, reverified on 2026-05-14: in both test and production, `GET /health` is public and unauthenticated `GET /api/hello` returns `401` when `AUTH_ENABLED=true`.
- GitHub auth-related repository variables are present, including `AUTH_ENABLED=true`, OIDC variables, and web auth variables. Variable values are non-secret configuration, but project memory intentionally records only presence/status, not full auth configuration.
- `DEPLOY_PRODUCTION_ENABLED=true` was intentionally enabled during the readiness sprint so guarded production promotion can run after test deployment succeeds. The reusable deployment workflow still fails closed for `prod` unless this variable is explicitly `true`. The current staged promotion workflows are `deploy-test.yml`, `promote-production.yml`, `rollback-production.yml`, and reusable `deploy-environment.yml`.
- Deployment packaging uses storage-backed `WEBSITE_RUN_FROM_PACKAGE` with managed-identity package access (`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`), not SAS-backed package URLs.
- Staged deployment bootstrap status verified on 2026-05-14:
  - GitHub environments `test` and `production` exist.
  - Azure resource groups `rg-api-test` and `rg-api-prod` exist.
  - Test and production Function Apps, App Insights instances, plans, and storage accounts exist.
  - `Deploy Test` and `Promote Production` have succeeded after auth enablement; the final readiness verification recorded run `25852557000` for test and run `25852638254` for production.
  - Codex could not verify Microsoft Entra app registrations or federated credentials because the current Azure principal lacked sufficient Microsoft Graph privileges.
  - Codex could not verify deployment-principal RBAC assignments from the available app/client ID because Graph lookup was insufficient and no object ID was available in project memory.
- `deploy-production.yml` is retained as a manual legacy wrapper; normal flow should use `Deploy Test` followed by `Promote Production`.
- Next milestone: keep routine changes flowing through the PR -> CI/Policy Check -> Deploy Test -> Promote Production path; use rollback workflow for known-good commit redeploys if a later production smoke test fails.

## 2026-05-14 readiness sprint update

- Auth-enabled test deployment was verified at run `25851944897`: test `GET /health` returned `200`, and unauthenticated test `GET /api/hello` returned `401`.
- Auth-enabled production deployment was promoted at run `25852035606`: production `GET /health` returned `200`, and unauthenticated production `GET /api/hello` returned `401`.
- `Promote Production` run `25852035606` still concluded `failure` because the post-smoke repository-variable metadata update could not write variables with `GITHUB_TOKEN`; the deployment and smoke tests themselves passed.
- `DEPLOY_PRODUCTION_ENABLED=true` was intentionally set during this readiness sprint so guarded production promotion can run after test deployment succeeds.
- Production Function App system-assigned managed identity was verified after the production promotion.
- Rollback remains workflow-based through `.github/workflows/rollback-production.yml`, using the same reusable deployment path for a requested known-good commit.

## 2026-05-14 final readiness verification update

- PR #60 was merged by auto-merge after CI and Policy Check passed.
- `Deploy Test` was manually re-run from `main` after PR #60 at run `25852557000` and succeeded.
- `Promote Production` was manually re-run from `main` after PR #60 at run `25852638254` and succeeded end-to-end.
- Production smoke remained healthy after the final promotion: `GET /health` returned `200`, and unauthenticated `GET /api/hello` returned `401`.
- The post-smoke repository-variable metadata updates now produce warnings if `GITHUB_TOKEN` cannot write repository variables, but they no longer fail a healthy deployment.

## 2026-05-15 GPT Actions OAuth preparation

- Added an optional `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` setting for protected API routes. When empty, delegated/user-token behavior remains backward compatible. When populated, delegated/user tokens must have an `azp` or `appid` client claim matching the allowlist, in addition to the existing tenant, scope/role, and user object ID / subject allowlists. App-only service tokens still use `OIDC_ALLOWED_APP_OBJECT_IDS` and `OIDC_ALLOWED_CLIENT_IDS`.
- Added `contracts/openapi.gpt.yaml`, a minimal GPT Actions OpenAPI 3.1 schema for production with public `GET /health` and OAuth-protected `GET /api/hello` and `POST /api/reddit/thread`.
- Added `scripts/configure-entra-gpt-action-oauth.sh` for Azure Cloud Shell. It creates or reuses a dedicated Microsoft Entra confidential web app registration for the ChatGPT Action, adds the GPT Builder redirect URI, verifies the existing API delegated scope, adds delegated API permission, optionally creates a client secret, and can optionally set non-secret GitHub variables and Function App app settings.
- Current non-secret repository variables include the API audience, API scope ending in `/api.access`, primary tenant, and Angular SPA client ID. Exact values remain in GitHub variables and the OpenAPI contract rather than this memory note.
- Codex Azure/Graph inspection on 2026-05-15 could list account/resource groups and Function App resources through ARM, but `az ad app show/list` failed with `Insufficient privileges to complete the operation`, and `az functionapp config appsettings list` failed with `Length Required`. The Cloud Shell helper is therefore the source for final Entra/GPT Action configuration under an appropriately privileged signed-in user.


## 2026-05-15 GPT Actions helper follow-up

- Fixed `scripts/configure-entra-gpt-action-oauth.sh` after Cloud Shell reported `ERROR: Couldn't find 'web' in 'web'` for an existing ChatGPT Action app registration. The helper now uses Azure CLI's web arguments instead of a generic nested `--set web...` update, and it registers both standard GPT Actions callback host variants (`chat.openai.com` and `chatgpt.com`) when one is provided.


## 2026-05-16 GPT Action client secret rotation guidance

- Added `DELETE_EXISTING_CLIENT_SECRETS` and `DELETE_CLIENT_SECRET_DISPLAY_NAME` to `scripts/configure-entra-gpt-action-oauth.sh` so a leaked or misplaced GPT Action client secret created by the helper can be rotated without printing existing secrets. The helper deletes matching credential metadata by key ID and can then create one replacement secret for GPT Builder.
- Documentation now explicitly says to treat any GPT Action client secret copied into chat, logs, shell history, or non-GPT Builder locations as exposed and to rotate it.

## 2026-05-17 runtime truth and autonomous operations hardening

- `/health` now includes safe runtime provenance fields: environment name, deployed commit SHA, deployed source ref, deployment workflow run ID, deployed timestamp, and build timestamp. Missing local metadata falls back to `local`/`unknown` values and does not expose secrets.
- Reusable deployment now writes immutable runtime app settings (`DEPLOYED_COMMIT_SHA`, `DEPLOYED_SOURCE_REF`, `DEPLOYMENT_RUN_ID`, `DEPLOYED_ENVIRONMENT_NAME`, `DEPLOYED_AT_UTC`) and publishes frontend `assets/build-info.json` plus matching config metadata.
- Runtime smoke verification is script-based through `npm run ops:smoke` and fails closed when `/health` does not report the expected deployed SHA. `npm run ops:runtime-truth` reads the latest live runtime truth for a supplied `API_BASE_URL`.
- Authenticated protected API smoke verification is available through `npm run ops:smoke:auth` for `GET /api/hello` and `POST /api/reddit/thread`. Deployment now mints a short-lived `AUTH_ACCESS_TOKEN` at runtime through GitHub Actions OIDC and environment-scoped `TEST_SERVICE_AUTH_*` / `PROD_SERVICE_AUTH_*` variables instead of storing a static token secret; production fails closed if token minting or authenticated smokes fail.
- Smoke scripts generate or accept `SMOKE_RUN_ID`, send it as `X-Smoke-Run-Id`, and API handlers log only the sanitized correlation value as evidence, never as instructions.
- Deployment workflows upload release ledger artifacts validated by `ops/release-ledger/schema.json`. Ledgers connect source ref, runtime SHA, URLs, smoke results, authenticated smoke status, telemetry status, and verification time; generated ledgers are not committed to `main`.
- `npm run ops:check-telemetry` queries Application Insights/Azure Monitor for recent unhandled exceptions, HTTP 5xx responses, and failed requests after smoke tests. If Application Insights identifiers or permissions are missing, the result is `blocked_telemetry`; production is intended to fail closed once telemetry configuration is available.
- `npm run ops:triage-repair-issues` supports dry-run repair issue lifecycle triage for open `codex-repair` issues and `.github/workflows/repair-triage.yml` can run it manually or on a daily dry-run schedule.
- Policy guardrails now summarize high-risk operational path changes and fail closed on diffs that remove runtime SHA verification, telemetry checks, smoke/auth smoke coverage, release ledger generation, JWT validation, production fail-closed behavior, or safe OIDC deployment posture.

## 2026-05-17 production smoke service OAuth follow-up

- The production service-smoke Microsoft Entra app was configured from Azure Cloud Shell with app role `api.service`, a GitHub Actions federated credential for `repo:JueZ/api:environment:production`, and production environment variables `PROD_SERVICE_AUTH_CLIENT_ID`, `PROD_SERVICE_AUTH_TENANT_ID`, and `PROD_SERVICE_AUTH_SCOPE`.
- Deployment workflows now mint the authenticated smoke bearer token just-in-time from GitHub OIDC and do not require or store an `AUTH_ACCESS_TOKEN` secret.
