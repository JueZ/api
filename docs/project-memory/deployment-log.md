# Deployment log

## 2026-08-08 — Versioned agent-learning artifacts accepted through production

- Source: PR #349 exact head `7188188cc0b3fd1a58a5ee14ae5335158294135c` passed exact-head CI `31279530179`, Policy Check `31279530178`, CodeQL `31279530171`, and autonomous review/merge `31279529529`, then squash-merged as `9310c94f97541e57f83b186af2cacf989d6f5330`.
- Main delivery: controller `31279667347`, exact-main CI `31279682790`, Deploy Test `31279752243`, and Promote Production `31279913572` all succeeded for the exact merge.
- Acceptance: test and production passed immutable-source validation, public runtime smoke, authenticated hello and Reddit smoke, telemetry correlation, release-ledger publication, and final generation checks. Fresh `ops:runtime-truth` checks matched live `/health`, exact workflow metadata, and exact ledger identity to the merge in both environments with no blockers.
- Governance state: three curated historical learning artifacts are verified, zero are waived, trusted exact-Git and GitHub provenance scorers run inside the existing CI aggregate, and no paid general task evaluation or historical learning-issue backfill ran. Live branch protection remains the same four strict GitHub Actions aggregate contexts.

## 2026-08-08 — Stable branch-protection aggregation accepted through production

- Source: PR #345 exact head `06a68d42e205ec38ec8c0fb906e59dd9fc8ce415` passed exact-head CI `31276396714`, Policy Check `31276396688`, CodeQL `31276396684`, and autonomous review/merge `31276396717`, then squash-merged as `da8459aec5756f684b27d692dd838b0135c7fe9f`.
- Main delivery: controller `31276530181`, exact-main CI `31276543255`, Deploy Test `31276618522`, and Promote Production `31276791354` all succeeded for the exact merge.
- Acceptance: both deployment workflows passed immutable-source validation, public runtime smoke, authenticated hello and Reddit smoke, telemetry correlation, and release-ledger publication. Fresh `ops:runtime-truth` checks verified live `/health` plus exact ledger identity in both environments.
- Live repository state: classic `main` protection is strict and requires only the four stable aggregate contexts. All other inspected protection settings were preserved. Canary PR #346 independently proved an internal lint failure fails `CI complete`, prevents paid review, and remains unmergeable.

## 2026-08-02 — Always-on autonomous-delivery canary accepted

- Source: PR #318 exact head `de88f6eacddf6f795ce51484f54058e54622f2b3`, squash-merged as `e8e1070b4a4f2e67b9d60b97a3586bf16b3bfeea` after CI `30743179098`, Policy `30743179152`, CodeQL `30743179115`, and autonomous review/merge `30744502912` passed.
- Main delivery: controller `30744545928` automatically dispatched exact-main CI `30744552173`, Deploy Test `30744611475`, and Promote Production `30744732911` without a human merge or deployment dispatch.
- Acceptance: test and production passed exact-generation validation, public runtime smoke, authenticated protected-endpoint smoke, telemetry correlation, and release-ledger publication for the exact merge.
- Operational state: Codex Auto-Merge, Codex Main Delivery, Deploy Test, and Promote Production remain active as the steady state. Production rollback remains a separately requested action.

## 2026-08-01 — Exact test-proven release accepted in production

- Main CI `30710606677` and Deploy Test `30710685029` passed at first attempt for exact commit `3810259823ce0694623a306eb5b390c2781d4b68`; bounded private-storage preparation `30710816387` had already completed.
- After the operator repaired the existing production smoke federation record in place and verified only the existing `catalogue.read`/`reddit.read` application roles plus the production SPA redirect, first-attempt Promote Production run `30715766542` completed successfully with correlation `prod-entra-fix-3810259-20260801t1953z`. No secret, new identity, new federated credential, alternate trust route, rotation, revocation, or new RBAC grant was introduced.
- The run passed immutable bundle and provenance verification, Azure OIDC, Bicep, complete runtime settings, private-data validation, Function/frontend deployment, pre/post generation checks, public smoke, GitHub-OIDC service-token minting, authenticated hello and Reddit smokes, telemetry correlation, release-ledger publication, and accepted rollback-bundle preservation.
- Independent verification found live `/health` status `ok` on the exact SHA and deployment run, unauthenticated `/api/hello` at `401`, the new production frontend at `200`, and rendered frontend configuration using the current redirect and `catalogue.read` scope.
- Result: production accepted at run `30715766542`. The bounded workflow was disabled after completion. Repair issues #294 and #308-#310 were closed with evidence; historical failed runs were retained for auditability.

## 2026-08-01 — Reusable deployment checkout security repair merged without deployment

- PR #298 exact head `59b17b6bcb9cc4bceb099554029635078334f7f0` passed CI `30707131034`, Policy Check `30707131051`, CodeQL `30707131086`, and independent review/merge `30707224277`, then squash-merged as `0fcaf64c6270fc1b7d00b1af2ee76f97f7564601`.
- The independent review approved with no findings and recorded an estimated upper-bound cost of `$0.060725`. Exact-main CI `30707340491` passed for the merge.
- The PR used `[skip autodeploy]`; Main Delivery, Deploy Test, Promote Production, and the other bounded controllers remained disabled. No test or production application deployment ran, and both runtime environments remained unchanged.

## 2026-08-01 — Exact-main test revalidation passed before storage preparation

- Exact first-attempt main CI run `30700328426` passed for `5f033da73e4fd24de2f5f41c1abba97159f4b56b` and produced the immutable release bundle.
- First-attempt Deploy Test run `30704470979` accepted that exact SHA and CI correlation. Azure OIDC, immutable release verification, Bicep, complete runtime settings, private WLH data, immutable Function activation, activation-last frontend deployment, current-generation checks, runtime smoke, authenticated `GET /api/hello` and `POST /api/reddit/thread`, telemetry correlation, release ledger, and test provenance all passed.
- Independent live `/health` verification reported test environment, the exact SHA, and deployment run `30704470979`. The ledger and promotion provenance artifacts validated locally. The deployment workflow was disabled immediately after dispatch.
- Production remained healthy and unchanged at commit `9d99dfc041893070eeb817e24ad0baeadaee11e1`, run `30168788236`. No production application deployment was dispatched.

## 2026-08-01 — Budget rollover repair and security controls accepted in test

- PR #290 final head `00285974178e402c8104ea7097dabc04d506a1b2` passed CI `30695135412`, Policy Check `30695135427`, CodeQL `30695135428`, and independent review/merge `30695207692`, then squash-merged as `5d9e3cc87ed0f8e18e70544b6b1587ae2ddcf56c`. Exact first-attempt main CI `30695268947` passed.
- First-attempt Deploy Test run `30695340416` accepted that exact SHA and CI evidence. Bicep reused the existing immutable budget start date and passed without deleting or recreating the €10 budget. Function and frontend packages then deployed successfully.
- Runtime smoke, authenticated hello and Reddit smokes, telemetry correlation, final generation checks, release-ledger publication, and test-provenance publication all passed. The ledger records five correlated smoke evidence rows and zero exceptions, HTTP 5xx responses, or failed requests.
- Independent live verification confirmed exact `/health` SHA/run metadata, deterministic unauthenticated REST REC, the single `/mcp` server, all 14 schema-bearing MCP tools, and deterministic protected-tool REC.
- Result: test accepted at `5d9e3cc87ed0f8e18e70544b6b1587ae2ddcf56c`. Deployment/controller workflows were disabled again, `DEPLOY_PRODUCTION_ENABLED=false`, and production was not dispatched or changed.

## 2026-08-01 — Review controls merged; first test rollout stopped before package mutation

- PR #289 passed exact-head CI `30694157626`, Policy `30694157876`, CodeQL `30694157622`, and bounded independent review/merge `30694244308`, then squash-merged as `7907708d3db92a698bbfb549cb8ccfa91a1e86c8`. The approved review used 34,447 input and 1,844 output tokens with a `$0.227555` estimated upper-bound cost.
- Exact first-attempt main CI `30694325712` passed and produced the immutable release bundle for `7907708d3db92a698bbfb549cb8ccfa91a1e86c8`.
- Test-only run `30694406216` validated the source/controller generation, Azure OIDC identity, and immutable bundle, then failed during Bicep before either application package was deployed. The existing test budget starts at `2026-07-01`; the dynamic Bicep default attempted to change it to `2026-08-01`, which Azure rejects.
- Result: test remains on accepted run `30666921988` and commit `6cadc861954af706cd752c022b194c742c0aa6fd`. Production was not dispatched or changed. The repair preserves the existing immutable budget date and retains the €10 alert.

## 2026-07-31 — AI-native release accepted in test; production unchanged

- PR #284 merged safe API-verified authorization diagnostics as `6cadc861954af706cd752c022b194c742c0aa6fd`; exact first-attempt main CI run `30654113519` passed.
- A privileged Entra operator assigned the existing least-privilege `catalogue.read` and `reddit.read` roles to the existing smoke principal. The repository OIDC subject was already workflow-bound, while both test federated credentials still used the former environment-only subject. Both existing test records were updated in place to the exact deployment-workflow identity. The federation repair created no key, secret, identity, permission, RBAC grant, or production federation change.
- First-attempt Deploy Test run `30666921988` passed Azure OIDC, immutable artifact verification, Bicep, runtime safety settings, private reference-data validation, immutable Function and activation-last frontend deployment, current-generation checks, runtime smoke, authenticated hello and Reddit smokes, telemetry, release ledger, and test provenance.
- Live health and frontend metadata report exact commit `6cadc861954af706cd752c022b194c742c0aa6fd`, environment `test`, and deployment run `30666921988`. The bundled MCP server responds on the single `/mcp` route and returns deterministic structured REC for an unauthenticated protected tool call.
- Result: test accepted. Repository Actions and Deploy Test were disabled again. Main Delivery, production promotion, rollback, and `DEPLOY_PRODUCTION_ENABLED` remain disabled; production was not dispatched or changed.

## 2026-07-31 — Lowercase settings passed; Entra GUID startup check failed closed

- PR #282 exact head `7c637f8b29caddc81eef1946f6208d90751f0b24` passed CI run `30651446037`, Policy Check `30651446063`, CodeQL `30651446510`, and first-attempt independent review/merge run `30651447011`, then squash-merged as `a1d2249c9b8b997229158220b3ac38751f1da668`.
- Main-delivery run `30651610027` accepted exact main CI `30651633388` and honored `[skip autodeploy]`.
- Manual test-only run `30651802409` passed Bicep and the complete runtime-settings policy, proving the lowercase boolean repair and exact Key Vault references. It deployed the immutable Function and activation-last frontend packages, then the Function entry point failed closed because runtime startup incorrectly required every Entra object ID to have RFC UUID version/variant marker bits.
- The workflow did not accept runtime smoke, telemetry, or provenance. Production was not dispatched.
- Repair: validate Entra object/tenant identifiers as GUID-shaped strings while keeping strict UUID validation for Bring list identifiers.

## 2026-07-31 — Nested settings deployment passed; boolean policy check failed closed

- PR #281 exact head `73b88f1d6f2cebf5a66dc4d34e9d7f5cd707e1d3` passed exact-head CI, Policy Check, CodeQL, and independent review, then squash-merged as `48591c487b319fe1a4fffe274750cb79c9828341`.
- Main-delivery run `30650853708` accepted exact main CI run `30650872623` and honored `[skip autodeploy]`; no automatic environment deployment ran.
- Manual test-only run `30651053281` passed the repaired nested Bicep deployment, resolving the preceding ARM cycle. It then failed the complete runtime-settings gate because the seven Bicep boolean conversions were persisted as title-cased strings rather than the exact lowercase strings required by application policy.
- No Function or frontend package was activated after the failed gate. The OpenAI credential was present through its exact versioned Key Vault reference; its value was never read or emitted. Production was not dispatched.
- Repair: normalize every boolean app setting with `toLower(string(value))` and enforce the mapping in architecture tests before a fresh exact-main test-only deployment.

## 2026-07-31 — First repaired test deployment stopped at an ARM settings cycle

- PR #280 exact head `14a91c960a634b4a9a60796a393eabf1cfa2aeb1` passed CI run `30649467367`, Policy Check `30649467617`, CodeQL `30649470184`, and independent review/merge run `30649464758`, then squash-merged as `8d6c69c34fb411021c3c9a7b61a72421a482e007`.
- Main-delivery run `30649984641` dispatched and accepted exact first-attempt main CI `30650008794`, then honored `[skip autodeploy]`; no automatic test or production deployment ran.
- Manual test-only run `30650254586` validated the exact main/CI/correlation and immutable release bundle, then ARM rejected Bicep with `InvalidTemplate` because the parent template both listed and directly wrote the Function `appsettings` child resource. No Function or frontend package mutation ran; production was not dispatched.
- Repair: retain the parent read of release-owned settings but reconcile the complete settings object through a secure nested Bicep module, removing the same-template resource cycle while keeping secret-bearing module parameters out of deployment history.

## 2026-07-31 — Corrected controller canary merged; post-merge handoff missing

- PR #271 was automatically squash-merged by corrected controller run `30631182158` after all exact-head required checks and low-risk autonomous review passed. Merge commit `d49833bb119001d930e00cd5400ba7d1badb7550` is the first end-to-end proof that the `unstable` self-gating fix works.
- No main CI or main-delivery run followed because GitHub-token merges do not emit push workflows and `Codex Main Delivery` was subscribed only to `CI` completion. No test or production deployment ran.
- A focused workflow repair now subscribes the single main-delivery controller to successful `Codex Auto-Merge` completion and requires exact merge-SHA main CI before any deployment decision.

## 2026-07-31 — Merge-controller self-gating fix reached main without deployment

- PR #270 fixed the trusted controller's treatment of GitHub's mergeable `unstable` state while retaining exact-head required-check, review, conflict, freshness, fork, and branch-protection gates.
- Exact head `83fdd6314b91be3588debc8fc191089a8ac79431` passed PR CI, Policy Check, CodeQL, and an independent high-risk model review. Because the old controller on `main` could not execute its own fix, the reviewed SHA was squash-merged through the same pinned bootstrap procedure used for the original controller; merge commit `5026003ca62ce49c16e76d1dbc57a36a0d56e04c` resulted.
- Main CI run `30630948880`, Policy Check run `30630948846`, and CodeQL run `30630948886` passed. Main delivery run `30631074332` honored `[skip autodeploy]`; neither test nor production deployment was dispatched.
- This follow-up project-memory update is the first low-risk end-to-end auto-merge canary using the corrected controller.

## 2026-07-31 — AI-native remediation merged; test deployment rejected by auth smoke

- PR #264 merged as `4d82ed8491a32440ec5495049ba39e8f73c6bbac` after exact-head CI, Policy Check, and CodeQL passed. Main CI run `30629053731`, Policy Check run `30629053800`, and CodeQL run `30629053791` passed.
- Main delivery run `30629217969` honored `[skip autodeploy]`; no automatic test or production deployment ran. Production was never dispatched for this rollout.
- Initial manual test run `30629256593` failed closed on missing non-secret deployment configuration. Retry `30629682712` passed Azure OIDC, artifact, and Bicep checks but stopped because the required WLH reference blob was absent from the new private storage.
- Bounded migration run `30629886744` copied that single blob from the previous test storage without overwrite and verified its independently computed digest.
- Final permitted retry `30629930683` applied infrastructure and deployed the immutable Function and web artifacts. `/health` proved the exact merge SHA, but the unauthenticated `/api/hello` smoke returned `200` with the local-development principal instead of `401`; authenticated smoke, telemetry, and accepted test provenance were therefore not produced.
- Result: test infrastructure and code are physically deployed but the release is not accepted. The deployment repair limit is exhausted pending a focused bootstrap/app-settings fix. Production remains unchanged.

## 2026-06-09 — Identity-based Azure Functions host storage deployed

- Event: PR #246 migrated `AzureWebJobsStorage` from an account-key connection string to identity-based host storage for merge commit `677b1adfbe551c48525ef8b11a0722f5515d9989`.
- Validation: Post-merge `main` CI passed. `Deploy Test` run `27229870948` and `Promote Production` run `27229866903` both passed, including Bicep deployment, Function package deployment, runtime smoke, authenticated smoke, telemetry gate, and release-ledger upload.
- Follow-up: Keep storage shared-key disablement as a separate future hardening step and revisit role requirements if non-HTTP triggers or Durable Functions are added.

## 2026-05-17 Repairable Error LLM diagnostics config deployed

- PR #152 (`Wire repairable OpenAI diagnostics deployment config`) merged at main commit `c9e57514468c312b6a694eacf8040111677da71b` after PR CI and Policy Check passed.
- GitHub repository secret `OPENAI_API_KEY` and variables `REPAIRABLE_ERRORS_LLM_ENABLED=true` / `REPAIRABLE_ERRORS_LLM_MODEL=gpt-5.5` are now consumed by the deployment workflow and applied as Bicep-managed Function App settings; secret values are not recorded.
- Main delivery completed successfully: `CI` run `25986696951`, `Deploy Test` run `25986717911`, and `Promote Production` run `25986757289`. A duplicate manual `Deploy Test` run `25986766513` also passed.
- Production workflow smoke tests passed for Function App `func-api-catalogue-prod-bfjstshehpbfk` and storage account `stapicatalogueprodbfjsts`.


## 2026-05-16 Reddit thread input hardening deployed to production

- PR #144 (`Harden Reddit thread input resolution`) merged at main commit `659b674daa8b26f801aec0672696d20f1b178985` after PR CI and Policy Check passed.
- Main delivery completed successfully: `CI` run `25972576401`, `Deploy Test` run `25972596333`, and `Promote Production` run `25972641970`.
- Production workflow smoke tests passed. Codex host post-deployment checks confirmed production `/health` returned `200`, unauthenticated `POST /api/reddit/thread` returned `401`, and the frontend root returned `200`.
- Result: production now includes Reddit OAuth `api/info` share URL resolution, raw comment-ID-to-parent-thread fallback, and documented URL alias input tolerance.

## 2026-05-16 full Codex delivery orchestrator deployed

- PR #137 updated `Codex Main Delivery` to explicitly dispatch and wait for `CI`, `Deploy Test`, and `Promote Production` after Codex auto-merge because a GitHub-token `workflow_dispatch` CI run did not trigger downstream `workflow_run` deployment workflows.
- Validation commit: `06d05f3` on `main`. Manual `Deploy Test` run `25968770752` and `Promote Production` run `25968813057` succeeded after PR #137 merged; production smoke tests passed.
- The next Codex auto-merge should exercise the full orchestrator directly from `Codex Main Delivery`.

## 2026-05-16 Codex auto-merge deployment chain validation succeeded

- PR #135 added the `Codex Main Delivery` workflow to bridge GitHub-token Codex auto-merges into explicit `main` CI dispatches.
- Validation commit: `8cf55a7` on `main`. Manual `CI` dispatch run `25968500874` passed, automatically triggered `Deploy Test` run `25968521526`, and that successful CI-triggered test deployment automatically triggered `Promote Production` run `25968560857`.
- Production smoke tests passed for Function App `func-api-catalogue-prod-bfjstshehpbfk` and static website storage account `stapicatalogueprodbfjsts`.

## 2026-05-15 production promotion for security-finding main head

- Open PR review before deployment: #81 and #118 were already no-op/empty versus current `main`; #112 was not merged because its memory text was stale despite useful duplicate test intent; #120 and #121 were not merged because they conflicted with current `main` and need rebase/refresh before reconsideration.
- Manually dispatched `CI` run `25917321823` for `main` commit `91be4e72dae0a10bad79488125714899bd543f61`; it completed successfully across install, lint, type-check, unit/API tests, Angular build, Azure Functions build, OpenAPI/Bicep validation, security scan, secret scan, and dependency audit.
- CI-triggered `Deploy Test` run `25917361131` deployed the same commit to test, passed smoke tests, and uploaded Deploy Test provenance.
- `Promote Production` run `25917450342` deployed the same commit to production and reported smoke tests passed for Function App `func-api-catalogue-prod-bfjstshehpbfk` and storage account `stapicatalogueprodbfjsts`.
- Post-deployment Codex smoke checks confirmed production `/health` returned `200`, unauthenticated `/api/hello` returned `401`, CORS preflight from `https://stapicatalogueprodbfjsts.z6.web.core.windows.net` returned `204`, and the frontend root returned `200`.


## 2026-05-15 production verification after PR #119 merge

- Verified GitHub PR #119 (`Require explicit app-only token marker for service tokens`) was merged at 2026-05-15T07:00:03Z as `fa1faef`; its PR CI and Policy Check runs passed and GitHub-native auto-merge was enabled before merge.
- Latest successful production promotion inspected: GitHub Actions run `25890832782`, `Promote Production`, completed successfully at 2026-05-14T23:10:00Z and deployed `e40533b`.
- Manual production checks from Codex host on 2026-05-15: `/health` returned `200`; unauthenticated `/api/hello` returned `401`; CORS preflight from `https://stapicatalogueprodbfjsts.z6.web.core.windows.net` returned `204`; frontend root returned `200`.
- Compatibility note: local `npm ci` succeeded with 0 vulnerabilities, `npm test` passed 36 tests, and `npm run build` completed successfully with the existing Angular initial bundle budget warning.
- Remaining deployment action: trigger/observe CI on the current `main` head that includes `fa1faef`, then Deploy Test and Promote Production, before claiming the security-finding fixes are live in production.


## 2026-05-14 OpenAPI generated artifacts removed from version control

- PR #103 (`Stop committing generated OpenAPI web artifacts`) merged via GitHub-native auto-merge at merge commit `21b4dcc81d055ecce728494ef7e5c14de411f8f3` after PR CI and Policy Check passed.
- A main-branch `CI` workflow run `25890171719` was manually dispatched for the merge commit and passed all required checks.
- `Deploy Test` workflow run `25890206895` deployed the merge commit to the `test` environment and passed smoke tests.
- `Promote Production` workflow run `25890276402` completed successfully and passed production smoke tests after the same main-branch delivery sequence.
- Result: `contracts/openapi.yaml` is the only committed OpenAPI YAML contract; Angular copies it as a build asset and parses it at runtime for the interactive catalogue.

## 2026-05-14 OpenAPI-driven API catalogue deployed to test and production

- PR #99 (`OpenAPI-driven interactive API catalogue UI and sync script`) merged via GitHub-native auto-merge at merge commit `30f948b70d9d71f4eb39cacfa5d28838d1035e8b` after PR CI and Policy Check passed.
- A main-branch `CI` workflow run `25889283198` was manually dispatched for the merge commit because the auto-merge was performed by GitHub automation; it passed all required checks.
- `Deploy Test` workflow run `25889311885` deployed the merge commit to the `test` environment and passed smoke tests.
- `Promote Production` workflow run `25889385460` then deployed the same merge commit to production and passed smoke tests.
- Result: the Angular API catalogue now renders OpenAPI-driven endpoint documentation and browser try-it controls from the synced contract assets in both test and production.

## 2026-05-14 Reddit thread endpoint test deployment succeeded

- PR #90 was merged at commit `62f5a0b44c109cf80749c3556d2f77b3f074cd86`.
- Manual `Deploy Test` workflow run `25879066023` deployed that commit to the `test` environment and passed smoke tests.
- Production promotion run `25879156975` was skipped because the test deployment was manually dispatched; production was not promoted for this task.
- Reddit setting names are wired into the Function App deployment; secret values remain only in GitHub/Azure secret stores and are not documented.

## 2026-05-14 Reddit configuration prepared for staged deployment

- GitHub environment variables for Reddit client ID and User-Agent were configured for `test` and `production`; the Reddit client secret was configured as an environment secret. Secret values were not logged or documented.
- Deployment wiring is being updated so `infra/main.bicep` applies the Reddit setting names to the Azure Function App in both environments.
- No production promotion was triggered as part of this change.

## 2026-05-14 — Microsoft Entra v1 issuer alias fix deployed to production

- Event: PR #83 was merged after passing CI and Policy Check, then `Deploy Test` run `25857723653` and `Promote Production` run `25857793354` completed successfully.
- Result: Production deployment and smoke tests succeeded.
- Verification: Workflow smoke tests passed for public `/health`, unauthenticated protected `/api/hello`, and configured browser preflight checks. Interactive authenticated browser verification still requires a manual retry.
- Follow-up: Retry **Call hello with access token** in the production browser session.


Entries are reverse chronological. Do not include secrets or SAS URLs.
## 2026-05-14 — Production browser auth manually verified

- Event: Manual production browser verification succeeded after PR #86 and production promotion run `25858636629`.
- Result: The Angular app signed in `mkos_postat@outlook.com`, acquired an API access token, and called protected `GET /api/hello` successfully.
- Verification: The response was authenticated and returned the expected v0 hello payload for Martin with subject, object ID, and tenant ID fields.
- Follow-up: Auth milestone is browser-verified; future feature work can build on the protected API foundation.


## 2026-05-14 — Deployment secret scoping hardening deployed

- Event: PR #107 was squash-merged after CI and Policy Check passed, then `Promote Production` run `25890276402` deployed commit `3e4149265f8f3c8feb365a5a4933ff16b68edc83`.
- Result: Production deployment succeeded. The reusable deployment workflow now validates deployment refs as full SHAs in `main`, uses explicit Reddit secret passing from callers, and scopes `REDDIT_CLIENT_SECRET` only to the Bicep infrastructure step.
- Verification: Production workflow smoke tests passed for `https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net`; no production repair issue was created.

## 2026-05-14 — Trailing-slash Microsoft Entra v1 issuer fix deployed to production

- Event: PR #86 was merged after passing CI and Policy Check, then `Deploy Test` run `25858558165` and `Promote Production` run `25858636629` completed successfully.
- Result: Production deployment and smoke tests succeeded.
- Verification: Workflow smoke tests passed for public `/health`, unauthenticated protected `/api/hello`, and configured browser preflight checks. Interactive authenticated browser verification still requires a manual retry with a fresh token.
- Follow-up: Retry **Call hello with access token** in the production browser session.

## 2026-05-14 — Production CORS/auth browser-call fix deployed

- Production promotion run `25855907807` succeeded after PR #75.
- Verification: production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`; `OPTIONS /api/hello` from origin `https://stapicatalogueprodbfjsts.z6.web.core.windows.net` returned `204` with `Access-Control-Allow-Origin` set to that origin.
- Production-failure issues #68, #72, and #74 were closed after the successful promotion and endpoint verification.
## 2026-05-14 — Issuer-specific JWKS auth fix deployed

- Production promotion run `25857092220` succeeded after PR #80.
- Verification: production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`; CORS preflight from the production Angular origin returned `204` with the expected `Access-Control-Allow-Origin`.
- Follow-up: manual browser retry of **Call hello with access token** is still needed because Codex cannot complete interactive Entra/MSA login.


## 2026-05-14 — Multi-issuer Microsoft account auth fix deployed

- Production promotion run `25856534002` succeeded after PR #77.
- Non-secret auth variables were updated to include both the organization tenant issuer/tenant/object allowlist and the explicit Microsoft account issuer/tenant/home-account object ID for `mkos_postat@outlook.com`.
- Verification: production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`; CORS preflight from the production Angular origin returned `204` with the expected `Access-Control-Allow-Origin`.
- Follow-up: manual browser retry of **Call hello with access token** is still needed because Codex cannot complete interactive Entra/MSA login.


## 2026-05-14 — MSAL redirect-flow fix deployed to production

- Event: PR #64 changed the Angular frontend to use MSAL redirect APIs for sign-in and interactive token fallback after production browser auth returned with an auth-code hash but did not complete UI sign-in.
- Result: `Deploy Test` run `25854175773` passed and `Promote Production` run `25854251983` passed. Production smoke tests remained healthy.
- Follow-up: Manually retest browser sign-in at the production Angular URL and confirm the page leaves the `#code` callback state and shows the signed-in account.

## 2026-05-14 — Final readiness production promotion succeeded

- Event: After PR #60 merged, `Deploy Test` run `25852557000` and `Promote Production` run `25852638254` were manually dispatched from `main`.
- Result: Both workflows succeeded. Production deployment, Angular deployment, smoke tests, and warning-only repository-variable metadata updates completed without failing the workflow.
- Verification: Production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`.
- Follow-up: Manual browser/MSAL sign-in verification and Entra app-registration visibility remain the only setup-readiness items requiring a human/delegated directory context.

## 2026-05-14 — Consolidation verification found production still pre-auth

- Event: Consolidation sprint inspected repo, GitHub Actions, GitHub variables, Azure resources, and public production endpoints without deploying production.
- Result: Code on `main` contains auth, but production still serves the old public `/api/hello` placeholder. `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `200` with `authenticated:false`.
- Production API URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Follow-up: Verify Entra/OIDC/RBAC prerequisites, run `Deploy Test`, and promote production only through guarded workflows after `DEPLOY_PRODUCTION_ENABLED=true` is intentionally set.

## 2026-05-14 — Staged deployment bootstrap partially verified

- Event: Safe GitHub/Azure inspection checked repository environments, resource groups, resource inventory, Function App runtime, recent workflow runs, and repository variable names.
- Result: GitHub environments `test` and `production` exist. Azure resource groups `rg-api-test` and `rg-api-prod` exist. Production Function App runtime is `Node|22`. `Deploy Test` run `25849812564` succeeded on `main`; subsequent `Promote Production` workflow runs skipped.
- Unknowns: Microsoft Entra app registrations, federated credentials, and deployment-principal RBAC could not be fully verified because the current Azure principal lacked sufficient Microsoft Graph privileges and project memory does not contain the deployment service principal object ID.
- Follow-up: Complete verification with a delegated identity or object ID that can inspect app registrations/federated credentials and role assignments.

## 2026-05-14 — Managed-identity package access replaced SAS-backed run-from-package

- Event: Reusable deployment workflow stores the Function App package in blob storage and configures `WEBSITE_RUN_FROM_PACKAGE` with `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`.
- Result: Current workflow no longer writes expiring SAS package URLs.
- Follow-up: Keep verifying storage/RBAC prerequisites during staged deployment.

## 2026-05-14 — Auth production promotion blocked by deployment RBAC

- Event: PR #40 was squash-merged and main CI, Policy Check, and Deploy Test passed. Production promotion was triggered manually after auth GitHub variables were configured.
- Result: Failed closed during the Bicep infrastructure step before package/frontend deployment and smoke tests.
- Root cause: The GitHub Actions Azure deployment identity lacks permission to create/update `Microsoft.Authorization/roleAssignments` in `rg-api-prod`; `infra/main.bicep` manages a storage role assignment for the Function App identity.
- Follow-up: Grant the deployment identity `Role Based Access Control Administrator` at `rg-api-prod` scope, or pre-provision/remove the Bicep-managed role assignment in a safe PR. `DEPLOY_PRODUCTION_ENABLED=false` was restored after the failed promotion.
- Links: Production-failure issues #50 and #51 were created for commit `a025c76`.

## 2026-05-14 — Auth deployment preparation blocked by Entra permissions

- Action: Set GitHub repository variable `DEPLOY_PRODUCTION_ENABLED=false` as a fail-safe before configuring authentication.
- PR: Historical status only; PR #40 was later merged with OAuth/OIDC/JWT implementation and frontend MSAL wiring.
- Production state: unchanged pre-auth deployment; `/health` is public and `/api/hello` is still the public placeholder.
- Blocker: Codex Azure identity could not list app registrations by display name due to insufficient Microsoft Entra directory privileges.
- Missing values: API app client ID, SPA app client ID, API App ID URI, `api.access` scope ID, and `OIDC_ALLOWED_OBJECT_IDS`.
- Next step: A sufficiently privileged delegated user must create/reuse the Entra app registrations and provide the allowed user object ID before merge/deploy.
## 2026-05-14 — Staged deployment setup commands and rollback skill documented

- Event: Added a repo-scoped production rollback skill and setup commands for GitHub environments, Azure resource groups, OIDC federated credentials, RBAC, test deployment, production promotion, and rollback.
- Result: Documentation-only operational follow-up; no Azure resources were changed by this PR.
- Evidence / command summary: `docs/setup/staged-deployment.md` contains the CLI command sequence; `.agents/skills/production-rollback/SKILL.md` contains the standard rollback workflow command.
- Follow-up: Run the setup commands with an Azure principal that can create `rg-api-test` and assign scoped roles, then verify `Deploy Test` and `Promote Production`.

## 2026-05-14 — Staged deployment flow prepared in PR

- Event: Added workflows and documentation for test-first deployment and production promotion.
- Result: Pending merge and workflow execution.
- Evidence / command summary: `deploy-test.yml` will deploy `main` to `rg-api-test` and smoke `/health` plus `/api/hello`; `promote-production.yml` will promote the same commit to `rg-api-prod` after the test workflow succeeds.
- Follow-up: After merge, verify the first test deployment and production promotion workflow runs; configure GitHub `production` required reviewers if manual approval is desired.

## 2026-05-14 — v0 production deployment succeeded

- Event: Production deployment completed after the Function App runtime was changed to Node 22.
- Result: Success.
- Evidence / command summary: Production base URL responded successfully for `GET /health` and `GET /api/hello` at <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Follow-up: Historical note superseded by PR #40 for code-level auth and by later managed-identity package access; production still needs auth-enabled deployment verification.

## 2026-05-14 — Production failure issues closed after successful deployment

- Event: Production-failure issues created during failed deploy attempts were closed after the successful v0 deployment.
- Result: Resolved.
- Evidence / command summary: Related issue set included issue #28 and other production-failure issues from failed deployment attempts.
- Follow-up: Keep incident root causes recorded in `incident-log.md`.

## 2026-05-14 — Function App returned HTTP 503 until Node runtime changed

- Event: Deployed Function App returned HTTP 503/runtime startup failures.
- Result: Failed until runtime was corrected.
- Evidence / command summary: Production smoke checks failed against the Function App until Node was changed from 24 to 22.
- Follow-up: Keep Azure Functions runtime aligned with validated Node versions.

## 2026-05-14 — Angular `$web` upload failed until static website hosting was enabled

- Event: Static web upload to the `$web` container failed.
- Result: Failed until static website hosting created/enabled the container.
- Evidence / command summary: Blob upload targeting `$web` could not succeed before static website hosting was enabled.
- Follow-up: Ensure static website hosting exists before uploading frontend artifacts.

## 2026-05-14 — SAS expiry of 30 days was rejected

- Event: Deployment attempted to create a user delegation SAS with a 30-day expiry.
- Result: Failed because user delegation SAS expiry must be within 7 days.
- Evidence / command summary: Azure Storage rejected the SAS expiry window.
- Follow-up: Historical note superseded by later managed-identity package access; do not reintroduce persisted SAS package URLs.

## 2026-05-14 — Storage upload failed because RBAC was incomplete

- Event: GitHub Actions deployment could not upload package/blob content.
- Result: Failed until data-plane permissions were added.
- Evidence / command summary: The GitHub OIDC principal had resource `Contributor` but lacked `Storage Blob Data Contributor` for blob data-plane operations.
- Follow-up: Keep deployment identity permissions least-privileged but sufficient for required data-plane uploads.
