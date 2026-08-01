# Incident log

## 2026-08-01 — Bundled MCP OAuth authorization rejected missing delegated scopes

- Impact: ChatGPT could reach the production Microsoft Entra authorization flow for the one bundled MCP server, but authorization returned `AADSTS650053` because requested granular delegated scopes such as `bring.write` and `catalogue.read` were not exposed by the API registration.
- Root cause: The API registration retained only the legacy `api.access` delegated scope while `catalogue.read` and `reddit.read` already existed as service-only application-role values. Microsoft Graph rejected adding same-valued delegated scopes with `DuplicateValue`. The bundled MCP client manifest also contained the legacy `api.access` scope ID twice. Earlier repair scripts incorrectly attempted scope creation and preauthorization in one PATCH and did not account for the cross-permission value collision.
- Containment: Failed Graph PATCH requests were atomic; no partial scope or preauthorization state was accepted. Runtime JWT validation, allowlists, the one bundled `/mcp` route, and existing production service-role assignments remained unchanged.
- Repair: The API first accepted service-only aliases after app-only classification and allowlisting. Entra then preserved the existing application-role IDs while renaming their values, added seven unique canonical delegated scopes, pre-authorized the bundled MCP client for those exact IDs, and replaced its duplicate legacy requests with the exact granular permission set.
- Resolution: PR #312 merged as `2183222c3122e79b7d8d2cf7a20c7b9890998f7c`. Pre-migration test run `30720449914`, post-migration test run `30720746830`, and production run `30720874197` all passed their applicable gates. The final test and production evidence reports public smoke, authenticated protected-endpoint smoke, and telemetry as passed; live health and OAuth discovery agree with the exact deployed SHA and seven canonical scopes. Interactive ChatGPT reconnection remains the user-session confirmation.

## 2026-08-01 — Production startup and authenticated-smoke blockers resolved

- Evidence: Promotion `30711503917` deployed infrastructure/packages but public smoke found `/health` unavailable because the production `OIDC_REQUIRED_SCOPES` setting still used legacy `api.access,api.service`; fail-closed runtime safety therefore registered no Function routes. After the canonical granular catalogue restored live health, recovery `30712220640` remained rejected because it had captured the unavailable pre-dispatch health state. Acceptance attempt `30712337225` then passed public deployment gates but Microsoft Entra returned `401 invalid_client` while exchanging the GitHub OIDC assertion for the existing production smoke application.
- Root causes: Production non-secret authorization configuration had not converged with the test-proven granular permission catalogue, and the external smoke application's existing federated credential still did not match GitHub's exact repository/environment/reusable-workflow subject. The production SPA redirect and browser scope also still targeted the legacy static-site generation and `api.access`.
- Repair: Apply the canonical runtime scope catalogue, update the one existing smoke federated identity record in place, verify/assign only `catalogue.read` and `reddit.read`, preserve prior SPA redirects while adding the exact new production redirect, and configure the frontend to request `catalogue.read`. No secret, identity, credential record, alternate trust route, rotation, revocation, or RBAC grant was created.
- Resolution: First-attempt Promote Production `30715766542` passed Azure OIDC, deployment, public and authenticated smokes, telemetry correlation, accepted ledger, and rollback-bundle preservation for exact SHA `3810259823ce0694623a306eb5b390c2781d4b68`. Independent live health/frontend/auth-gate checks agree. Issues #294 and #308-#310 are closed with the evidence; failed runs remain retained.

## 2026-08-01 — Monthly rollover made Bicep attempt an immutable budget-date update

- Evidence: Deploy Test `30694406216` for exact main `7907708d3db92a698bbfb549cb8ccfa91a1e86c8` failed in `Deploy Bicep infrastructure` with Azure `400`: `Start date of budgets cannot be updated`. Read-only Azure inspection confirmed the retained test budget starts at `2026-07-01T00:00:00Z`; Bicep's `utcNow('yyyy-MM-01T00:00:00Z')` default had advanced to August.
- Impact: The workflow stopped before Function/frontend package mutation, runtime acceptance, or evidence publication. The prior accepted test release stayed online. Production was not dispatched and `DEPLOY_PRODUCTION_ENABLED=false`.
- Repair: Before Bicep, query the exact environment budget resource through ARM. Reuse its start date when present, otherwise use the current UTC month for a new budget. Strictly accept only an exact first-of-month UTC timestamp and pass it explicitly to Bicep. Do not delete or recreate the budget.
- Review follow-up: PR #290 review `30694704403` correctly rejected the initial shell implementation because it treated every Azure lookup failure as absence. The review used 1,729 input and 784 output tokens with a `$0.032165` estimated upper-bound cost.
- Second review follow-up: Review `30694951631` rejected dependence on the Azure error body's semantic code because valid HTTP 404 responses may use codes such as `ResourceNotFound`. It used 3,575 input and 1,126 output tokens with a `$0.051655` estimated upper-bound cost.
- Final repair: The resolver obtains the short-lived ARM token from the already authenticated Azure CLI, retains it only in process memory, calls ARM without shell interpolation, and branches on the actual HTTP status. Only HTTP 404 permits the new-budget default; 200 requires a validated existing start date, and every other status, network/auth failure, or malformed response stops before Bicep without logging tokens or response bodies.
- Resolution: PR #290 final head `00285974178e402c8104ea7097dabc04d506a1b2` passed all exact-head gates and independent review, merged as `5d9e3cc87ed0f8e18e70544b6b1587ae2ddcf56c`, and Deploy Test `30695340416` passed Bicep plus every deployment/runtime/evidence gate. The existing budget was preserved; production was not dispatched.

## 2026-08-01 — Complete high-risk-document review exhausted 3,000 output tokens

- Evidence: Exact-head CI `30693681909`, Policy `30693681916`, and CodeQL `30693681915` passed for `cbe2dc71f7815b282cb1e485ff7ec5ad27074ce9`. Review `30693881648` included every one of the eight classifier-matched high-risk paths, counted exactly 34,178 input tokens, and made one generation. The response ended `incomplete` after all 3,000 output tokens, including 2,974 hidden reasoning tokens, with an estimated upper-bound cost of `$0.26089`; no retry occurred.
- Root cause: Adding the required security and ADR context increased the medium-reasoning workload enough that the static 3,000-token allowance left no capacity for the structured decision.
- Repair: Preserve the consumed head. On the final scoped availability repair, explicitly reserve at least 512 output tokens for final JSON and raise only the static cap to 3,500. Keep the complete capsule, medium reasoning, exact token count, one generation, zero SDK retries, and `$0.31` ceiling unchanged. At the observed input, the new conservative maximum is `$0.27589`.
- Status: Repair in progress. A failure of the same area on the next exact head exhausts the repair limit. No merge or deployment occurred; production remained disabled.

## 2026-08-01 — Review found high-risk documentation omitted from mixed capsules

- Evidence: Exact-head CI `30693294597`, Policy `30693294596`, and CodeQL `30693294603` passed for `670fa5c62d25e79db7cbf10f9684c3b8e9dd82ec`. Review `30693386513` returned a valid rejection because mixed capsules omitted classified high-risk files including `docs/security/autonomous-guardrails.md` and `docs/adr/0001-autonomous-high-risk-review.md`. It used 32,389 input and 1,848 output tokens, with 1,655 reasoning tokens and an estimated upper-bound cost of `$0.217385`.
- Root cause: The complete-diff repair selected every non-documentation path but treated the entire `docs/` subtree as optional whenever executable files were present. File metadata did not provide the policy content required for independent review.
- Repair: Preserve the consumed head. Include every non-documentation path plus every classifier-matched high-risk document, retain all documentation for documentation-only high-risk PRs, and omit only ordinary mixed documentation. Keep the 200 KB, 3,000-token, and exact `$0.31` gates unchanged.
- Status: First scoped repair for this finding is in progress. No merge or deployment occurred; production remained disabled.

## 2026-08-01 — Complete-diff medium review exhausted the initial output cap

- Evidence: Exact-head CI `30692962446`, Policy `30692962452`, and CodeQL `30692962458` passed for `c1a4efacaa5dfce6b3dabc68487e4cda3d993329`. Review `30693113238` created one durable claim, counted exactly 32,304 input tokens, made one generation, and returned `empty_output` after all 1,500 output tokens were hidden reasoning. The estimated upper-bound cost was `$0.20652`; no retry occurred.
- Root cause: Complete contextual coverage increased the review from roughly 12,000 to 32,000 input tokens. Medium reasoning required more than the initial 1,500-token allowance before it could emit the structured decision.
- Repair: Preserve the consumed head and unchanged complete input. Raise the static output cap to 3,000 while retaining medium reasoning, zero SDK retries, one generation, and the exact `$0.31` gate. At the observed input size, the conservative maximum becomes `$0.251521`.
- Status: This is the final scoped availability repair. If the new head again produces no decision, stop rather than widening the cap or retrying. No merge or deployment occurred; production remained disabled.

## 2026-08-01 — Medium review found incomplete executable coverage

- Evidence: PR #289 review `30692285462` ran only after exact-head CI `30692211088`, Policy `30692211086`, and CodeQL `30692211107` passed at `faa21750223eb20f72232f4dbb2e5d83f48ea4f1`. It rejected because `buildReviewDiffCapsule` selected only `risk.highRiskPaths`, omitting executable changes such as `scripts/lib/autonomous-policy.mjs`; the capsule covered 39,357 of 162,829 source-diff bytes. Sanitized usage recorded 12,083 input tokens and 1,048 output tokens, with an estimated upper-bound cost of `$0.091855`.
- Root cause: Complete changed-file metadata did not compensate for absent code. The byte-as-token budget estimate also forced aggressive zero-context selection even though observed tokenization was substantially smaller than serialized byte length.
- Repair: Preserve the consumed head. On a new commit, include every changed non-documentation diff section with normal context, cross-check completeness against GitHub's authoritative file list, reject capsules above 200 KB, obtain an exact input-token count after durable claim acquisition, and permit at most one generation only under the unchanged `$0.31` ceiling. Local tests mock both OpenAI requests.
- Status: First scoped repair in progress. No rejected head merged or deployed; production remained disabled.

## 2026-08-01 — High-effort bounded review returned no structured output

- Evidence: PR #289 review run `30691998861` created exact-head claim `91348292399`, made one Responses API call, and returned `empty_output`. Sanitized usage recorded 12,066 input tokens and 1,500 output/reasoning tokens, with an estimated upper-bound cost of `$0.10533`.
- Root cause: The required high reasoning effort consumed the complete fixed 1,500-token output allowance before emitting structured text.
- Repair: Preserve the consumed head, keep the same model and exact capsule, and use medium reasoning under the unchanged one-call, no-retry, 1,500-token, and `$0.31` controls. No production or deployment workflow ran.
- Status: Repair pending exact-head free gates and one final bounded review; the failed head will not be retried.

## 2026-08-01 — PR #289 review rejected a separable claim path and incomplete credential audit

- Evidence: Exact-head CI run `30689701559`, Policy Check run `30689701551`, and CodeQL run `30689701547` passed for `c069be9b9f3203d0625248eb6b9fd1d6fab83040`. Final bounded review run `30689779148` rejected because paid review remained callable separately from durable claim acquisition and the credential audit could be bypassed with alternate secret expression forms or an insufficiently bound marker identity.
- Root cause: Claim acquisition and review were separate CLI/workflow steps, the claim external identity did not bind the exact controller workflow run, and the repository audit focused on known GitHub-token names instead of denying every non-allowlisted/dynamic workflow secret access path.
- Repair: Remove the standalone claim command. The review command now creates, re-reads, and owns the only canonical marker; binds it to repository, PR, exact head, controller workflow, and run; revalidates its ID, App identity, external identity, details URL, status, and conclusion immediately before the API boundary; and requires the live path to run inside the exact trusted GitHub Actions workflow. The workflow audit now exact-name allowlists secrets and rejects bracket/dynamic access, `secrets: inherit`, alternate action/shell token minting, non-built-in GitHub-auth values, and raw check-run access outside the controller.
- Safety/cost: The PR was returned to draft after rejection. One earlier controller was canceled shortly after review startup and is conservatively treated as a possible paid attempt; run `30689779148` is the one completed decision. The repair is batched and locally fake-backed before one final review. No rejected head merged or deployed, and production stayed disabled.

## 2026-08-01 — PR #288 final review rejected incomplete effective-permission handling

- Evidence: Exact-head CI run `30688624142`, Policy Check `30688624984`, and CodeQL `30688625872` passed for `9129ea7416df291ced7598b3c2b792d9b349aa13`. Final bounded review run `30688708482` rejected because the controller audit treated omitted workflow permissions as harmless and did not compute effective job inheritance, while GitHub repository defaults can be changed independently.
- Root cause: The static/runtime audit searched only literal `checks: write` or `write-all` blocks. It did not require every workflow to have an explicit top-level permission map and did not reject alternate GitHub token sources.
- Repair: A fresh successor requires explicit top-level maps, evaluates job overrides with inheritance, permits checks write only in `resolve`, `autonomous-review`, and `publish-review-check`, rejects alternate GitHub App/PAT minting and non-built-in GitHub-auth tokens, and regression-tests omitted/default and inherited-write cases. The live repository default was independently verified as read-only with Actions PR approval disabled; the controller no longer relies on that default.
- Safety/cost: PR #288 was returned to draft after its second permitted review and will be closed as superseded. No rejected head was merged or deployed, no third paid call ran, and production remained disabled.

## 2026-08-01 — PR #288 review rejected mutable paid-call claims and approval reuse

- Evidence: After exact-head CI run `30687904523`, Policy Check `30687905396`, and CodeQL `30687906106` passed, the only paid review run `30687989661` rejected head `274e56fa3945bbed80e314ba668628dce6eee2de`. The sanitized findings showed that mutable check-run fields could hide a prior claim and that reusable approval was not independently bound to an immutable controller revision.
- Repair: Remove approval reuse and all historical-run/artifact provenance logic. Create a separate completed neutral PR/head marker immediately before the call, never patch or release it, treat any existing marker as permanently consumed regardless of mutable fields, pin checkout to `github.workflow_sha`, and require `checks: write` to be exclusive to the controller through policy, tests, and a runtime audit.
- Cost handling: Free gates ran first. PR #288 has used one paid review head; the repair is batched locally before one final exact-head review. Ordinary validation remains fake-backed and makes no live OpenAI call.
- Safety: The optional service-identity helper remains deleted. Runtime OAuth/JWT enforcement is unchanged. No production or Azure mutation ran.

## 2026-08-01 — PR #287 review rejected optional service-identity verification

- Evidence: Exact-head CI, Policy Check, and CodeQL passed, then autonomous review run `30686104064` rejected head `8b43ae26d6416979f036b98aaa85467915560f71` with three high findings and one medium finding. The sanitized artifact identified forgeable reuse provenance, identity/role/FIC mutations before a fully pinned boundary, and missing free-check revalidation at the paid-call boundary.
- Cost handling: The diagnosis used the one bootstrap workflow only; no rerun was requested. Ordinary tests remained fake-backed. The next head is the first and only scoped repair attempt for PR #287.
- Repair: Reusable evidence was bound to the pinned GitHub Actions App, controller workflow identity, successful first run attempt, exact repository/head, and unique artifact digest; free-gate validation was repeated at claim and API boundaries. Final review run `30687126474` then rejected the optional read-only verifier because it did not reject every additional credential, FIC, or API-resource role assignment.
- Resolution: The operator confirmed that repository-side service-identity setup/audit was not wanted. The verifier, its dedicated test, and setup references are removed from the reduced successor instead of expanding identity inspection or creating a new trust-management route.
- Safety: No production workflow ran. No Azure identity, FIC, credential, role, assignment, app setting, or GitHub environment variable was changed.
- CI follow-up: Repair head `4e443239b5dbbdb3012d49b16b00fd106f3f3534` passed remote Actionlint/ShellCheck, policy, and CodeQL, but secret scan rejected a duplicated public API client GUID under the generic-key heuristic. Controller run `30686876997` was canceled before evidence publication to limit spend. The repair commit is amended to derive the identifier from the canonical contract, removing the duplicate from branch history instead of allowlisting or weakening Gitleaks.

## 2026-08-01 — PR #286 review exposed cross-run cost and federation gaps

- Symptom: PR #286's final permitted review rejected an otherwise locally and remotely green head because one-call enforcement was scoped only to a controller invocation, caller-selected repository/environment values could rebind the existing FIC, and label transitions no longer triggered immediate evaluation.
- Evidence: Exact-head review run `30670820873` returned three sanitized findings: no durable repository/PR/head claim, a workflow ref derived from caller-controlled repository/environment values, and removed `labeled`/`unlabeled` triggers. The PR was returned to draft and repository Actions were disabled; no third paid attempt ran.
- Root cause: SDK retries and a single `responses.create` call do not deduplicate separate workflow runs. The helper validated self-consistency rather than an immutable complete test tuple. Removing label triggers treated duplicate-cost symptoms rather than making review idempotent.
- Repair: The initial successor serialized controller runs and attempted durable claims plus trusted artifact reuse. Later reviews proved mutable claim/reuse evidence insufficient, so PR #288 removes reuse and uses an unpatched permanent paid-call marker instead. The optional service helper is deleted from current scope.
- Status: Local validation in progress; successor PR, merge, and test-only deployment acceptance remain pending. Production is unchanged.

## 2026-07-31 — Repeated high-cost autonomous review exhausted OpenAI credits

- Symptom: The operator observed approximately $9 of OpenAI API spend during delivery testing and the final PR review failed with `credit_balance_exhausted` despite ordinary repository tests passing.
- Evidence: 23 same-day `Codex Auto-Merge` artifacts report `modelInvoked=true` with `gpt-5.6-sol`; two final artifacts explicitly report two request attempts, establishing at least 25 paid Responses API requests. The trusted controller allowed two attempts with 6,000 then 12,000 output tokens, high reasoning, and up to 1.5 MB of diff. Local/API tests use mocks and made no live OpenAI request.
- Root cause: Each pushed high-risk exact head started paid review immediately, including heads that had not yet passed deterministic checks, and model-output/API failures automatically doubled the request. The model and token/diff bounds were unsuitable for frequent delivery checks.
- Repair: Gate paid review behind free exact-head checks; retain the required Sol/high-assurance analysis while allowing one call with SDK retries disabled, 40 KB diff, 1,500 output tokens, and a conservative $0.31 pre-call ceiling; record sanitized usage; require explicit live enablement. Runtime REC remains Luna/low, caps sanitized input at 24 KB and output at 700 tokens, disables SDK retries, and preserves deterministic-first fallback including serialization failures.
- Status: PR #286 exhausted its two repairs; the remaining cross-run idempotency and federation findings are tracked in the 2026-08-01 successor incident above.

## 2026-07-31 — Disabled Actions and legacy FIC subjects blocked test recovery

- Symptom: run `30663819848` remained queued with zero jobs after a test dispatch while repository Actions was disabled. After Actions was restored, the replacement run instantiated but Azure login failed with `AADSTS700213` because GitHub emitted the strengthened workflow-bound subject and the Azure test credentials still trusted the former environment-only subject.
- Root cause: enabling an individual workflow did not override the repository-wide Actions gate, and changing the repository OIDC claim template intentionally changed the assertion subject without rebinding the two existing test federated credentials.
- Repair: re-enabled the repository gate only for the bounded test run, rebound the existing test deployment and smoke FICs in place to the exact repository/environment/workflow subject, and dispatched a new first-attempt run. No broad/default subject, long-lived secret, new trust root, production identity, or production workflow was enabled.
- Verification: run `30666921988` passed every deployment, runtime, authenticated-smoke, telemetry, ledger, and provenance gate. Actions and Deploy Test were disabled again afterward. The original zero-job run still returns HTTP 500 to both cancel APIs and remains contained while Actions is disabled.
- Status: test runtime incident resolved; orphaned GitHub run remains an operational cleanup item.

## 2026-07-31 — Entra GUID was rejected as a non-versioned UUID at Function startup

- Symptom: test-only run `30651802409` passed infrastructure, complete settings reconciliation, immutable Function activation, and frontend activation, but every Function route returned `404`. Application Insights recorded the fail-closed entry-point error `OIDC_ALLOWED_OBJECT_IDS must contain at least one valid user object ID in test`.
- Root cause: runtime safety reused an RFC-versioned UUID regex for both Bring list UUIDs and Microsoft Entra object/tenant GUIDs. One valid configured Entra object GUID does not encode an RFC version marker, so the worker rejected the full configuration before registering routes.
- Safety impact: the host served no application route; smoke, authenticated checks, telemetry acceptance, and provenance did not pass. No secret value was read. Production was not dispatched.
- Repair: add a GUID-only shape for Entra `oid`/`tid` allowlists, retain strict UUID validation for Bring list IDs, and cover a syntactically valid non-versioned GUID.
- Status: local repair pending PR gates and a fresh test-only deployment.

## 2026-07-31 — ARM boolean string casing blocked runtime-policy acceptance

- Symptom: test-only run `30651053281` passed the nested Bicep deployment but the complete runtime-settings validator rejected `AUTH_ENABLED`, `AUTH_DEBUG`, the four Bring boolean flags, and `REPAIRABLE_ERRORS_LLM_ENABLED`.
- Root cause: Bicep used `string(bool)` for those seven Function App settings. ARM materialized title-cased `True`/`False`, but Node configuration and the fail-closed validator require exact lowercase `true`/`false` strings.
- Safety impact: the mismatch was detected before Function/frontend package activation, runtime smoke, telemetry acceptance, or provenance publication. Exact secret-reference identities—including `OPENAI_API_KEY`—matched without reading secret values. Production was not dispatched.
- Repair: use `toLower(string(bool))` for all seven settings and statically reject any regression to the unnormalized form.
- Status: local repair pending PR gates and a fresh test-only deployment.

## 2026-07-31 — Test auth failure exposed bootstrap, settings, placeholder, and deployment-generation gaps

- Symptom: test run `30629930683` deployed exact commit `4d82ed8491a32440ec5495049ba39e8f73c6bbac`, but protected `GET /api/hello` returned the local-development principal. Follow-up inspection also found `https://null` in two non-secret test environment variables and a deployment-generation race between the controller's main-head check and downstream Azure mutations.
- Root causes: Azure Functions loaded `dist/functions/*.js` directly and bypassed the safety composition root; disabled auth unconditionally produced a local principal; app settings were not independently reconciled and verified; placeholder HTTPS origins passed syntactic validation; and downstream writes did not revalidate that their source was still current `main`.
- Repair: load `dist/index.js`, fail closed on disabled auth outside local, manage Function settings as an explicit child resource, compare only approved non-secret safety fields after deployment, reject the placeholder origin, derive the test web API base from the deployed Function, and recheck current `main` immediately before every Azure mutation and runtime acceptance.
- Review follow-up: the exact-head independent review identified that full app-settings PUT could delete release-owned package keys, the rollback exception was not independently bound at every mutation guard, and downstream dispatch polling could substitute another matching successful run. The repair now preserves only release-owned package/provenance keys, binds rollback to the exact trusted caller plus ancestry/CI/test evidence, and uses opaque dispatch correlations with one pinned run ID and matching provenance or ledger proof.
- Second review follow-up: PR #275 review run `30637690935` correctly rejected the remaining mutation-wide rollback exception, optional ledger correlation, and operation-policy override of local runtime identity. The repair removes the rollback exception from every mutation guard, runs current-main Bicep/security configuration even during rollback, binds historical artifacts to one exact accepted production run/ledger/digest set, requires and compares correlations at production/test/ledger consumers, and derives the local auth bypass only from `DEPLOYED_ENVIRONMENT_NAME`.
- Third review follow-up: PR #275 review run `30639533695` correctly required rollback to download the exact release bundle preserved by the accepted production run, production promotion to receive and validate the pinned Deploy Test run ID rather than scan interchangeable runs, and runtime-truth to validate the supplied run's Actions metadata plus embedded ledger identity. PR #275 exhausted its two review attempts; its successor carries these repairs without bypassing the gate.
- Successor review follow-up: PR #276 review run `30640461388` identified that a workflow dispatched from main generation A could execute A's frozen YAML while a floating checkout resolved a later main generation B. The deployment caller now passes both its immutable run head and workflow SHA, the reusable workflow requires them to equal each other and the Actions run API head, checks out that exact commit, and fails if it is no longer authoritative main. The historical rollback package SHA remains a separate input.
- Final PR #276 review follow-up: review run `30641312336` correctly found that rollback still executed current-main Bicep/security mutations, GitHub reruns reused the same run ID without attempt-bound evidence, and the preserved frontend artifact was the raw CI archive rather than the bytes rendered and uploaded by deployment. PR #276 exhausted its second review attempt and was not amended further.
- Fresh-successor repair: rollback now skips Bicep and safety-setting reconciliation, resolves existing resources read-only, refuses to create a missing release blob, and uploads the accepted rendered frontend unchanged. All deployment evidence rejects attempts other than 1 and includes correlation in artifact identity. Normal deployments render, hash, re-manifest, and verify the frontend before either Function or static deployment, while test provenance records both source and rendered digests.
- PR #277 first-review follow-up: run `30642907335` correctly identified that rollback still wrote the safety-classified `DEPLOYED_ENVIRONMENT_NAME` provenance setting and that caller-controlled partial production deployments could preserve a raw/undeployed frontend as accepted rollback evidence. The one scoped repair validates existing safety settings read-only, excludes the environment safety setting from rollback app-setting writes, requires both packages for every production promotion/rollback, and validates the complete accepted rendered frontend before the first rollback mutation.
- PR #277 final-review follow-up: run `30643716052` correctly identified that the rollback comparison still omitted security-critical app settings, an auto-merge rerun could authorize another delivery chain, and Deploy Test could select a different latest successful CI run for the same SHA. PR #277 exhausted its second review attempt and was closed without bypass.
- Fresh-successor repair: normal and rollback paths stream one Azure response into a validator that checks the complete Bicep-managed app-setting key set and all then-enumerated non-secret values without persisting or emitting secret values; auto-merge/controller reruns are rejected and duplicate events for the same exact trigger are no-ops; and one exact first-attempt main CI run ID/correlation is validated and carried through test provenance and production. PR #279 later tightened the remaining reference-only fields as recorded below.
- PR #278 first-review follow-up: run `30645550478` required compatibility with both static workflow names and correlation-bearing run names in Actions API metadata, plus a final current-main check after smoke/telemetry and before accepted evidence publication. Live Actions API observations showed correlation-bearing `name` values while the reviewer expected static names, so the repair accepts only those two exact representations while retaining exact run ID, repository, workflow path, event, source SHA, display title, conclusion, branch, and first-attempt checks. A final generation check now gates release/test evidence, and the main controller rechecks after production before accepting its ledger.
- PR #278 final-review follow-up: run `30646203397` correctly identified that Azure `upload-batch --overwrite` replaces expected paths but does not remove paths absent from the approved archive. PR #278 exhausted its second review attempt and was closed without bypass; no deployment ran.
- Fresh-successor repair: create a deterministic inventory of every approved frontend name, size, and SHA-256; reject unsafe names, links, and non-regular entries; list the live `$web` container; delete only validated stale names with a current-main check before each mutation; upload the archive; then require exact name equality, download every deployed blob, compare content inventory, and recheck exact names before runtime acceptance.
- PR #279 first-review follow-up: run `30647458606` correctly identified that rollback validated several Bicep-managed secret references and Application Insights configuration only by setting-name presence. The scoped repair resolves the unique deployed observability component and tagged Key Vault, reads only management-plane connection/reference metadata, constructs the exact versioned Key Vault references for every managed secret, and compares every managed setting before normal or rollback package mutation without reading, persisting, or emitting secret values.
- PR #279 final-review follow-up: run `30648408513` correctly identified that a digest-named Function blob was content-checked but the runtime pointer still targeted its mutable current URL, and that frontend convergence deleted stale live blobs before replacement upload succeeded. PR #279 exhausted its second review attempt and was closed without bypass. The fresh successor resolves and verifies one immutable Function blob version and pins its encoded version ID in `WEBSITE_RUN_FROM_PACKAGE`; frontend deployment uploads and verifies non-entrypoint dependencies first, activates `index.html` last, verifies the complete expected release, and only then removes stale blobs and proves exact final names/content.
- Live deployment follow-up: PR #280 merged as `8d6c69c34fb411021c3c9a7b61a72421a482e007` after every exact-head and main gate passed. Test-only run `30650254586` stopped before package mutation because ARM detected a circular dependency where the main template used `list()` on the Function `appsettings` child and also declared that child directly. The repair moves only the settings write into a secure nested Bicep module; the parent still reads and allowlists release-owned settings after the Function App exists, but ARM no longer models the read and write as one resource cycle.
- Validation status: refreshed complete local and exact-head remote gates plus live test acceptance remain required. Production remains unchanged.

## 2026-07-31 — Autonomous review crashed on empty structured output

- Symptom: PR #272 exact-head run `30632059074` reached the OpenAI Responses API with the configured repository secret, but the high-risk review returned no aggregated `output_text`; the controller attempted `JSON.parse('')`, so the review job failed without its required evidence artifact.
- Classification: this was not a missing-key, authentication, or quota failure. The request completed without a surfaced API error, but the response did not contain a usable structured decision.
- Fix: retry an empty or invalid structured response once with a larger output-token allowance, then fail closed with a sanitized rejection artifact if neither bounded attempt yields a valid exact-head decision. Raw model output and error messages are never persisted.
- Review repair: the first bootstrap review correctly identified that parseable output from an incomplete response, or a structurally invalid decision, could end the retry early. Acceptance now additionally requires a completed API response and a valid exact-head decision whose blocking findings agree with its decision.
- Status: repaired through PR #274, whose exact-head independent review, CI, policy, CodeQL, and trusted auto-merge all passed.

## 2026-07-31 — Corrected auto-merge had no post-merge main CI handoff

- Symptom: the corrected trusted controller automatically merged canary PR #271 as `d49833bb119001d930e00cd5400ba7d1badb7550`, but no main CI or `Codex Main Delivery` run started.
- Root cause: GitHub-token merges do not create ordinary push-triggered workflow runs. The redesigned `Codex Main Delivery` subscribed only to completed `CI` runs and the trusted auto-merge workflow no longer had the required post-merge handoff, so there was no event capable of starting main CI.
- Fix: subscribe the sole main-delivery controller to successful `Codex Auto-Merge` completions as well as successful push CI. Read the approved reviewed-head SHA from the exact trusted auto-merge run's artifact, bind it to the merged PR and merge SHA, require that SHA to be current `main`, explicitly dispatch and wait for CI with that exact `headSha`, and only then evaluate deployment skip or dispatch the staged test/production workflows.
- Safety: auto-merge review/check gates remain unchanged; ambiguous or advanced main heads fail closed; current main is revalidated after CI and again after test before production; workflow-dispatched CI cannot recursively deliver because the CI-triggered path accepts only `push` events.
- Status: repair included in the PR containing this entry; successful delivery requires the post-merge job named `run main delivery after Codex auto-merge` to pass on the exact merge SHA.

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
