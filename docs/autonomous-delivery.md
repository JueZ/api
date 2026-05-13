# Autonomous delivery

This repository is configured for routine changes to move from Codex-created pull request to production without human approval when every required automated check passes.

## Delivery flow

1. Codex implements a change on a feature branch and opens a pull request.
2. `Codex Auto-Merge` enables GitHub-native squash auto-merge for Codex branches (`codex/` or `codex-`) or pull requests labeled `codex-automerge`.
3. `CI` and `Policy Check` run on the pull request.
4. GitHub branch protection blocks merge until every required status check passes.
5. GitHub-native auto-merge squash-merges the pull request after required checks pass.
6. A merge to `main` triggers `Deploy Production`.
7. Deployment authenticates to Azure with GitHub Actions OIDC, deploys infrastructure/application artifacts when present, and runs production smoke tests.
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

- `AZURE_CLIENT_ID` - Entra application or managed identity client ID configured for federated GitHub credentials.
- `AZURE_TENANT_ID` - Azure tenant ID.
- `AZURE_SUBSCRIPTION_ID` - Azure subscription ID.
- `AZURE_RESOURCE_GROUP` - Production resource group.
- `AZURE_FUNCTIONAPP_NAME` - Production Azure Functions app name, when Functions are present.
- `AZURE_STATIC_WEB_STORAGE_ACCOUNT` - Azure Storage static website account used for Angular static hosting, when Angular is present.
- `PRODUCTION_BASE_URL` - Public base URL used by smoke tests.

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
