# Autonomous delivery

This repository is configured for routine changes to move from Codex-created pull request to production without human approval when every required automated check passes.

## Delivery flow

1. Codex implements a change on a feature branch and opens a pull request.
2. `Codex Auto-Merge` enables GitHub-native squash auto-merge for Codex branches (`codex/` or `codex-`) or pull requests labeled `codex-automerge`.
3. `CI` and `Policy Check` run on the pull request.
4. GitHub branch protection blocks merge until every required status check passes.
5. GitHub-native auto-merge squash-merges the pull request after required checks pass.
6. A merge to `main` triggers `Deploy Production`, but the deploy job is gated by the `DEPLOY_PRODUCTION_ENABLED` repository variable. Leave it unset or set to `false` until manual bootstrap is complete.
7. When explicitly enabled, deployment authenticates to Azure with GitHub Actions OIDC, deploys infrastructure/application artifacts when present, and runs production smoke tests.
8. If deployment or smoke tests fail, the workflow fails closed and creates a GitHub issue with the failed run and commit.

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

Production deployment uses repository or environment variables, not long-lived Azure client secrets:

- `DEPLOY_PRODUCTION_ENABLED` - Set to `true` only after all manual bootstrap steps below are complete. Any other value skips production deployment, including on `main` pushes.
- `AZURE_CLIENT_ID` - Entra application or managed identity client ID configured for federated GitHub credentials.
- `AZURE_TENANT_ID` - Azure tenant ID.
- `AZURE_SUBSCRIPTION_ID` - Azure subscription ID.
- `AZURE_RESOURCE_GROUP` - Production resource group.
- `AZURE_FUNCTIONAPP_NAME` - Production Azure Functions app name, when Functions are present.
- `AZURE_STATIC_WEB_STORAGE_ACCOUNT` - Azure Storage static website account used for Angular static hosting, when Angular is present.
- `PRODUCTION_BASE_URL` - Public base URL used by smoke tests.

## Build and deployment assumptions

The workflows are intentionally scaffold-safe for this repository's current state:

- If there is no root `package.json`, install, lint, type-check, unit test, API test, Angular build, Azure Functions build, and dependency audit jobs report that the check is not applicable instead of inventing a second application layout.
- When a root `package.json` is added, prefer standard scripts: `lint`, `type-check`, `test`, `test:api`, `build`, `build:api`, and `build:functions`. The CI jobs use those scripts when present.
- Angular CI builds use a root `angular.json` first and then the first nested `angular.json` found outside `node_modules`. If the Angular project is nested, keep its dependency installation compatible with the root workspace or update the workflow in the same PR that introduces the app.
- Azure Functions CI builds use `build:api` or `build:functions` when present and otherwise detect `host.json` outside `node_modules`.
- Bicep validation compiles every `*.bicep` file with `az bicep build`; it does not deploy infrastructure during CI. Production deployment only targets `infra/main.bicep` after `DEPLOY_PRODUCTION_ENABLED=true`.
- No Azure SQL, Cosmos DB, API Management, Front Door, or other additional paid Azure services are introduced by this setup. New paid services require a cost note under `docs/cost/`.

## Manual bootstrap checklist

Complete these steps before setting `DEPLOY_PRODUCTION_ENABLED=true`:

1. In GitHub repository settings, enable auto-merge and require squash merge or linear history.
2. Protect `main`: require pull requests, disable direct pushes, disable force pushes, disable branch deletion, and require status checks before merge.
3. Add required status checks for `install`, `lint`, `type-check`, `unit tests`, `API tests`, `Angular build`, `Azure Functions build`, `OpenAPI validation`, `Bicep validation`, `security scan`, `secret scan`, `dependency audit`, `cost-policy check`, `guardrail policy check`, `CI complete`, and `Policy complete`.
4. Create labels used by automation if they do not already exist: `codex-automerge`, `codex-repair`, and `production-failure`.
5. Create the GitHub `production` environment if you want environment-scoped variables or environment-level deployment history. Do not add a required human approval gate if routine autonomous production deploys are desired after all checks pass.
6. Create an Entra application or user-assigned managed identity and configure GitHub OIDC federated credentials for this repository.
7. Grant the Azure identity only the minimum RBAC required at the production resource-group scope. Avoid subscription-wide Owner permissions.
8. Add repository or production-environment variables for `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `PRODUCTION_BASE_URL`, and, only when applicable, `AZURE_FUNCTIONAPP_NAME` and `AZURE_STATIC_WEB_STORAGE_ACCOUNT`.
9. Run CI and policy checks on a pull request and confirm branch protection blocks merge when any required check fails.
10. Confirm the production smoke endpoint responds at `PRODUCTION_BASE_URL/health` or `/`.
11. Only after the above are complete, set `DEPLOY_PRODUCTION_ENABLED=true` to allow `main` pushes to deploy.

## Azure OIDC bootstrap

Create an Entra application or user-assigned managed identity for GitHub Actions and add federated credentials for this repository.

Recommended federated credential subjects:

- `repo:OWNER/REPO:ref:refs/heads/main` for production deployment from `main`.
- `repo:OWNER/REPO:environment:production` if the production environment is used as the trust boundary.

Grant only the minimum Azure RBAC permissions needed for deployment. Prefer resource-group-scoped roles over subscription-wide roles. Do not grant broad Owner permissions unless there is a documented temporary bootstrap reason.

Example Azure CLI outline:

```bash
az ad app create --display-name github-OWNER-REPO-prod
az ad app federated-credential create --id <app-id> --parameters credential.json
az role assignment create --assignee <client-id> --role Contributor --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>
```

`credential.json` should use issuer `https://token.actions.githubusercontent.com`, the exact GitHub subject, and audience `api://AzureADTokenExchange`.

## Long-lived secret fallback

Long-lived Azure client secrets are not part of the normal autonomous path. If OIDC is impossible, document the reason, expiration date, rotation owner, and blast radius before introducing any `AZURE_CLIENT_SECRET` fallback. Never commit client secrets to the repository.

## Smoke tests

`Deploy Production` requires `PRODUCTION_BASE_URL` and checks `/health`, falling back to `/`. Failed smoke tests fail the workflow and create a repair issue. The workflow does not retry deployment indefinitely.

## Bounded repair

`Codex Autofix` is bounded to two attempts per pull request. It creates a repair task instead of weakening checks. If the same failure repeats after two attempts, automation stops and the failure must be summarized.
