# Autonomous delivery

This repository is configured for routine changes to move from Codex-created pull request to production without human approval when every required automated check passes.

## Delivery flow

1. Codex implements a change on a feature branch and opens a pull request.
2. `Codex Auto-Merge` enables GitHub-native squash auto-merge for Codex branches (`codex/` or `codex-`) or pull requests labeled `codex-automerge`.
3. `CI` and `Policy Check` run on the pull request.
4. GitHub branch protection blocks merge until every required status check passes.
5. GitHub-native auto-merge squash-merges the pull request after required checks pass.
6. A merge to `main` triggers CI on `main`; after that CI run succeeds, `Deploy Test` deploys to `rg-api-test` and runs smoke tests.
7. `Promote Production` runs only after `Deploy Test` succeeds for the same `main` commit, and the GitHub `production` environment may pause it for required-reviewer approval before Azure changes are made.
8. If deployment or smoke tests fail, the workflow fails closed. Production is not promoted unless test smoke tests have passed.

Codex can use the repo-scoped `github-cli-devops` and `azure-cli-devops` skills for safe GitHub CLI and Azure CLI diagnostics during this flow. Direct CLI diagnostics do not override CI, Policy Check, branch protection, environment approvals, deployment staging, or secret-handling rules.

## Required branch protection and repository settings

Configure these settings in GitHub before relying on autonomous delivery:

- Disable direct pushes to `main` by requiring pull requests before merging.
- Disable force pushes and deletions on `main`.
- Enable auto-merge for the repository so `Codex Auto-Merge` can call GitHub-native auto-merge.
- Require a linear history or squash merges for pull requests.
- Require status checks to pass before merging.
- Require branches to be up to date before merging when practical.
- Do not require routine human approvals for low-risk changes when all required automated checks pass.
- Require review or a higher-trust policy for high-risk paths listed in `AGENTS.md` if your organization needs additional controls.

Required status checks:

- `install`
- `lint`
- `type-check`
- `unit tests`
- `API tests`
- `Angular build`
- `Azure Functions build`
- `OpenAPI validation`
- `Bicep validation`
- `security scan`
- `secret scan`
- `dependency audit`
- `cost-policy check`
- `guardrail policy check`
- `CI complete`
- `Policy complete`
- `enable auto-merge` should pass for Codex PRs, but branch protection must still rely on CI and policy checks as the merge gate.

## Repository variables

Staged deployment uses repository or environment variables, not long-lived Azure client secrets:

- `AZURE_CLIENT_ID` - Entra application or managed identity client ID configured for federated GitHub credentials.
- `AZURE_TENANT_ID` - Azure tenant ID.
- `AZURE_SUBSCRIPTION_ID` - Azure subscription ID.
- `AZURE_FUNCTIONAPP_NAME` - Optional override for the production Azure Functions app name. If unset, production deployment uses the `functionAppResourceName` Bicep output.
- `AZURE_STATIC_WEB_STORAGE_ACCOUNT` - Optional override for the production Azure Storage static website account. If unset, production deployment uses the `storageAccountResourceName` Bicep output.
- `PRODUCTION_BASE_URL` - Optional production public base URL override used by smoke tests. If unset, production deployment discovers the Function App `defaultHostName` and uses `https://<defaultHostName>`.

Resource groups are fixed in workflow code for clarity: `rg-api-test` for test and `rg-api-prod` for production.

## Build and deployment assumptions

The workflows are intentionally scaffold-safe for this repository's current state:

- If there is no root `package.json`, install, lint, type-check, unit test, API test, Angular build, Azure Functions build, and dependency audit jobs report that the check is not applicable instead of inventing a second application layout.
- When a root `package.json` is added, prefer standard scripts: `lint`, `type-check`, `test`, `test:api`, `build`, `build:api`, and `build:functions`. The CI jobs use those scripts when present.
- Angular CI builds use a root `angular.json` first and then the first nested `angular.json` found outside `node_modules`. If the Angular project is nested, keep its dependency installation compatible with the root workspace or update the workflow in the same PR that introduces the app.
- Azure Functions CI builds use `build:api` or `build:functions` when present and otherwise detect `host.json` outside `node_modules`.
- Bicep validation compiles every `*.bicep` file with `az bicep build`; it does not deploy infrastructure during CI. Production deployment only targets `infra/main.bicep` after `DEPLOY_PRODUCTION_ENABLED=true`.
- In the staged model, production deployment is reached through `Promote Production`, and test and production both target `infra/main.bicep` with different `environmentName` values.
- The Linux Consumption Function App runs on the supported Node.js 22 stack and uses its system-assigned managed identity to read the run-from-package blob from the deployment storage account. `infra/main.bicep` grants only `Storage Blob Data Reader` on that storage account so the package URL does not require a persisted SAS token.
- No Azure SQL, Cosmos DB, API Management, Front Door, or other additional paid Azure services are introduced by this setup. New paid services require a cost note under `docs/cost/`.

## Codex host environment

Codex hosts can be prepared with `scripts/setup-codex-env.sh` and refreshed with `scripts/maintain-codex-env.sh`. Setup installs `az` and `gh`, logs into Azure with Codex-specific Azure service principal environment variables, selects `AZURE_SUBSCRIPTION_ID`, and logs into GitHub CLI with `CODEX_GH_TOKEN` after clearing `GH_TOKEN` and `GITHUB_TOKEN` so `gh` persists credentials. Maintenance reinstalls/verifies the tools and checks cached authentication only; it must not print secrets or deploy anything. See `docs/setup/codex-environment.md`.

## Manual bootstrap checklist

Complete these steps before relying on automatic staged deployment:

1. In GitHub repository settings, enable auto-merge and require squash merge or linear history.
2. Protect `main`: require pull requests, disable direct pushes, disable force pushes, disable branch deletion, and require status checks before merge.
3. Add required status checks for `install`, `lint`, `type-check`, `unit tests`, `API tests`, `Angular build`, `Azure Functions build`, `OpenAPI validation`, `Bicep validation`, `security scan`, `secret scan`, `dependency audit`, `cost-policy check`, `guardrail policy check`, `CI complete`, and `Policy complete`.
4. Create labels used by automation if they do not already exist: `codex-automerge`, `codex-repair`, and `production-failure`.
5. Create the GitHub `production` environment if you want environment-scoped variables or environment-level deployment history. Do not add a required human approval gate if routine autonomous production deploys are desired after all checks pass.
6. Create an Entra application or user-assigned managed identity and configure GitHub OIDC federated credentials for this repository.
7. Grant the Azure identity only the minimum RBAC required at the production resource-group scope. Avoid subscription-wide Owner permissions. The deployed Function App receives its own system-assigned identity and a storage-account-scoped `Storage Blob Data Reader` role assignment only for package retrieval.
8. Add repository or environment variables for `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`. Add `PRODUCTION_BASE_URL`, `AZURE_FUNCTIONAPP_NAME`, or `AZURE_STATIC_WEB_STORAGE_ACCOUNT` only when overriding the values discovered from production deployment outputs.
9. Ensure the GitHub Actions Azure identity has least-privilege deployment access to both `rg-api-test` and `rg-api-prod`, plus only the role-assignment permissions needed by `infra/main.bicep`.
10. Run CI and policy checks on a pull request and confirm branch protection blocks merge when any required check fails.
11. Confirm test and production smoke endpoints respond at `/health` and `/api/hello` after the first staged deployment.

## Azure OIDC bootstrap

Create an Entra application or user-assigned managed identity for GitHub Actions and add federated credentials for this repository.

Recommended federated credential subjects:

- `repo:OWNER/REPO:ref:refs/heads/main` for production deployment from `main`.
- `repo:OWNER/REPO:environment:production` if the production environment is used as the trust boundary.

Grant only the minimum Azure RBAC permissions needed for deployment. Prefer resource-group-scoped roles over subscription-wide roles. Do not grant broad Owner permissions unless there is a documented temporary bootstrap reason. Because `infra/main.bicep` assigns the Function App system identity `Storage Blob Data Reader` on the deployment storage account, the deployment identity also needs resource-group-scoped permission to create role assignments, such as `Role Based Access Control Administrator`, in addition to deployment rights.

Example Azure CLI outline:

```bash
az ad app create --display-name github-OWNER-REPO-prod
az ad app federated-credential create --id <app-id> --parameters credential.json
az role assignment create --assignee <client-id> --role Contributor --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>
az role assignment create --assignee <client-id> --role "Role Based Access Control Administrator" --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>
```

`credential.json` should use issuer `https://token.actions.githubusercontent.com`, the exact GitHub subject, and audience `api://AzureADTokenExchange`.

## Long-lived secret fallback

Long-lived Azure client secrets are not part of the normal autonomous path. If OIDC is impossible, document the reason, expiration date, rotation owner, and blast radius before introducing any `AZURE_CLIENT_SECRET` fallback. Never commit client secrets to the repository.

## Smoke tests

`Deploy Environment` resolves `EFFECTIVE_BASE_URL` at runtime. For production it uses `PRODUCTION_BASE_URL` when set; otherwise it reads the deployed Function App name from the `functionAppResourceName` Bicep output and discovers the Function App `defaultHostName`, using `https://<defaultHostName>`. Test always discovers the URL from the test Function App. Both environments check `/health` and `/api/hello`. Failed smoke tests fail the workflow and prevent automatic production promotion.

After these workflow updates are merged, inspect the staged deployment with:

```bash
gh run list --repo JueZ/api --workflow deploy-test.yml --branch main --limit 1
gh run list --repo JueZ/api --workflow promote-production.yml --branch main --limit 1
```

Manual deployment and rollback commands are listed in the staged deployment section below. The full Azure CLI and GitHub CLI setup guide is in [`docs/setup/staged-deployment.md`](setup/staged-deployment.md).

## Lightweight staged deployment

The deployment model is now intentionally staged but still small-project friendly:

1. `CI` and `Policy Check` remain the required pull-request gates.
2. `Deploy Test` runs after successful `main` CI or by `workflow_dispatch`. It uses the GitHub `test` environment, Azure OIDC, `rg-api-test`, and `environmentName=test`. It deploys infrastructure from `infra/main.bicep`, deploys the Function App package, uploads Angular static files when present, discovers the test base URL, and smokes `GET /health` and `GET /api/hello`.
3. `Promote Production` runs automatically only after `Deploy Test` completes successfully for `main`, or manually by `workflow_dispatch`. It uses the GitHub `production` environment, Azure OIDC, `rg-api-prod`, and `environmentName=prod`. It deploys the same commit reported by the successful test run, runs production smoke tests, and updates non-secret production repository variables only after smoke tests pass.
4. `Deploy Environment` is a reusable workflow shared by test, production promotion, legacy manual production deploy, and rollback so test/prod drift stays low.

Production approval is controlled by GitHub Environments: `Settings -> Environments -> production -> Required reviewers`. If required reviewers are configured, GitHub pauses the production job before Azure deployment. For a solo project, do not enable "prevent self-review" unless another reviewer exists. The `test` environment should normally have no required reviewers so it can validate every merged commit automatically.

The previous direct production-on-push workflow has been replaced by staged promotion. The compatibility `Deploy Production Legacy` workflow is manual-only and still uses the reusable deployment path; normal production changes should flow through `Deploy Test` and then `Promote Production`.

### Manual commands

Deploy a specific commit to test:

```bash
gh workflow run deploy-test.yml --ref main --repo JueZ/api -f commit_sha=<commit-sha>
```

Promote a specific commit to production:

```bash
gh workflow run promote-production.yml --ref main --repo JueZ/api -f commit_sha=<commit-sha>
```

Rollback production by redeploying a previous known-good commit:

```bash
gh workflow run rollback-production.yml --ref main --repo JueZ/api -f commit_sha=<previous-good-commit-sha>
```

Rollback is not a slot swap; it is a bounded redeploy through the same smoke-tested path. Azure Functions deployment slots could be introduced later if the project needs faster rollback or near-zero-downtime swaps, but that would require revisiting hosting-plan cost and is unnecessary for the v0 personal project.

### Cost and guardrails

The staged model adds a second resource group, `rg-api-test`, using the same serverless Bicep resources and `westeurope` region as production. It does not add Azure SQL, Cosmos DB, API Management, Front Door, Cognitive Services, Kubernetes, or other expensive services. It does not add authentication or weaken any existing CI, policy, secret-scan, security-scan, branch-protection, or auto-merge guardrails.

## Project memory

Meaningful deployment incidents, root causes, operational decisions, and follow-up risks should be recorded in `docs/project-memory/` so future Codex sessions can preserve context without relying on hidden model memory. Keep entries concise and never include secrets, tokens, SAS URLs, connection strings, or full environment dumps.

## Bounded repair

`Codex Autofix` is bounded to two attempts per pull request. It creates a repair task instead of weakening checks. If the same failure repeats after two attempts, automation stops and the failure must be summarized.
