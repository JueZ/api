# Current state

Last updated: 2026-05-14

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
- Infrastructure: `infra/main.bicep`.
- Azure resource groups: `rg-api-test` for test and `rg-api-prod` for production.
- Azure region: `westeurope`.
- Production API base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular static website URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Production Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Production static website storage account: `stapicatalogueprodbfjsts`.
- Azure Functions runtime: Node 22.
- Current code on `main` includes OAuth/OIDC JWT validation, a server-side user allowlist, protected `GET /api/hello` behavior when `AUTH_ENABLED=true`, Angular MSAL sign-in/token acquisition, OpenAPI bearer security, and Bicep auth app settings.
- Current production deployment does **not** yet match the auth-enabled code on `main`: direct verification on 2026-05-14 showed `GET /health` returns `200` and unauthenticated `GET /api/hello` still returns the pre-auth public placeholder response with `authenticated:false`.
- Current v0 endpoint truth:
  - Code: `GET /health` is public; `GET /api/hello` is protected by application-level JWT validation when `AUTH_ENABLED=true`.
  - Production as verified on 2026-05-14: `GET /health` is public; `GET /api/hello` is still public/pre-auth until a successful auth-enabled deployment reaches production.
- GitHub auth-related repository variables are present, including `AUTH_ENABLED=true`, OIDC variables, and web auth variables. Variable values are non-secret configuration, but project memory intentionally records only presence/status, not full auth configuration.
- `DEPLOY_PRODUCTION_ENABLED=false` remains set as a fail-safe variable. The reusable deployment workflow now fails closed for `prod` unless this variable is explicitly `true`. The current staged promotion workflows are `deploy-test.yml`, `promote-production.yml`, `rollback-production.yml`, and reusable `deploy-environment.yml`; production was not deployed during the consolidation sprint.
- Deployment packaging uses storage-backed `WEBSITE_RUN_FROM_PACKAGE` with managed-identity package access (`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`), not SAS-backed package URLs.
- Staged deployment bootstrap status verified on 2026-05-14:
  - GitHub environments `test` and `production` exist.
  - Azure resource groups `rg-api-test` and `rg-api-prod` exist.
  - Test and production Function Apps, App Insights instances, plans, and storage accounts exist.
  - `Deploy Test` most recently succeeded on `main` at run `25849812564`.
  - `Promote Production` most recently skipped after test; production auth deployment remains unverified.
  - Codex could not verify Microsoft Entra app registrations or federated credentials because the current Azure principal lacked sufficient Microsoft Graph privileges.
  - Codex could not verify deployment-principal RBAC assignments from the available app/client ID because Graph lookup was insufficient and no object ID was available in project memory.
- `deploy-production.yml` is retained as a manual legacy wrapper; normal flow should use `Deploy Test` followed by `Promote Production`.
- Next milestone: finish verifying staged deployment prerequisites that require directory/RBAC visibility, then run an auth-enabled test deployment and promote to production only through guarded workflows after test smoke tests pass.

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
