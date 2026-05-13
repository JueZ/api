# Azure OIDC setup

## Verification status

Azure OIDC for GitHub Actions has been verified for this repository.

- Repository: `JueZ/api`
- Azure resource group: `rg-api-prod`
- Azure region: `westeurope`
- GitHub environment: `production` exists
- GitHub Actions Azure client ID variable: `AZURE_CLIENT_ID` is configured
- Production deployment gate: `DEPLOY_PRODUCTION_ENABLED` is not enabled yet

## Confirmed workflow run

The `Verify Azure OIDC` workflow (`verify-azure-oidc.yml`) was manually dispatched on `main` and completed successfully on 2026-05-13.

Confirmed successful steps:

1. Required Azure repository variables were present, including `AZURE_CLIENT_ID`.
2. `azure/login@v2` authenticated to Azure using GitHub Actions OIDC.
3. `az account show` succeeded.
4. `az group show --name rg-api-prod` succeeded.

Workflow run: <https://github.com/JueZ/api/actions/runs/25819197241>

## Notes

Do not commit Azure tenant IDs, subscription IDs, client IDs, federated credential details, tokens, or secrets to this repository. Keep deployment disabled until the remaining production readiness checks are complete and `DEPLOY_PRODUCTION_ENABLED=true` is intentionally configured outside the repository.
