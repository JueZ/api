# Codex environment setup and maintenance

Use `scripts/setup-codex-env.sh` once per fresh Codex host to install required CLIs, cache authentication for Azure CLI and GitHub CLI, and ensure the checkout has a GitHub `origin` remote. Use `scripts/maintain-codex-env.sh` later to refresh the tools, verify that cached authentication still works, and repair a missing `origin` remote.

Both scripts are deployment-free. They install or verify tooling only and must not deploy infrastructure or application code.

Codex base images can include an `apt.llvm.org` source that is unreachable through the environment's egress proxy. This repository does not require LLVM or Clang, so setup and maintenance remove only `apt.llvm.org` entries from inherited APT source files before updating package indexes. Ubuntu and the explicitly configured Microsoft and GitHub signed repositories remain enabled; APT signature verification is never disabled.

For the repository instruction baseline and fresh-session trial checklist, see [Sol-to-Astra agent migration](astra-agent-migration.md).

## Related Codex skills

Use the repo-scoped `autonomous-pr-delivery` skill for routine branch, pull request, checks, merge, and delivery work. Load `github-cli-devops` for non-routine GitHub CLI diagnostics, failed Actions runs, repository configuration, or delivery-controller investigation. Use the repo-scoped `azure-cli-devops` skill for Azure CLI work, resource diagnostics, Bicep validation, RBAC checks, Azure Functions, Storage, and deployment debugging.

Azure CLI setup uses an explicit host-appropriate authentication mode. Azure-hosted environments default to Managed Identity. Codex Cloud must set `CODEX_AZURE_AUTH_MODE=service-principal` because the OpenAI-managed compute host has no project Azure Managed Identity attached and direct Azure CLI access is required for repository operations.

`CODEX_GH_TOKEN` is for setup only and must not be printed, logged, echoed, or committed. Setup clears `GH_TOKEN` and `GITHUB_TOKEN` before `gh auth login --with-token` so GitHub CLI can persist credentials instead of relying on environment-only token authentication. Maintenance verifies cached Azure CLI and GitHub CLI authentication and must not require or print secrets. Both setup and maintenance configure a missing git `origin` remote to `https://github.com/JueZ/api.git` by default, or to `https://github.com/${CODEX_GITHUB_REPOSITORY}.git` when `CODEX_GITHUB_REPOSITORY` is intentionally set.

## Required setup configuration

Provide these shared values only to the setup process:

- `AZURE_SUBSCRIPTION_ID` - Azure subscription selected after login.
- `CODEX_GH_TOKEN` - GitHub token used by `gh auth login --with-token`.

For an Azure-hosted environment, omit `CODEX_AZURE_AUTH_MODE` or set it to `managed-identity`. Set the non-secret `CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID` only to select an attached user-assigned identity; omit it for the system-assigned identity. The host identity must have least-privilege RBAC assigned before setup.

For Codex Cloud, set:

- `CODEX_AZURE_AUTH_MODE=service-principal`.
- `CODEX_AZURE_CLIENT_ID` - the least-privilege Codex Cloud application/client ID.
- `CODEX_AZURE_CLIENT_SECRET` - the time-limited credential stored only in the Codex Cloud secret manager.
- `CODEX_AZURE_TENANT_ID` - the Azure tenant ID.
- `CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON` - the non-secret credential expiry date in `YYYY-MM-DD` format. Setup rejects invalid or expired dates and warns within 30 days of expiry.

The service-principal path is an explicit exception because Codex Cloud has no attached Managed Identity or usable workload-identity token source while direct `az` access is required. The rotation owner is the repository operator, Martin. RBAC must remain limited to the project resource groups (`rg-api-test` and `rg-api-prod`) and must not grant Owner or unrelated subscription-wide access. The credential's exact expiry must match `CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON` in the Codex Cloud configuration.

When a Managed Identity host defines an HTTP proxy, setup preserves the existing proxy exclusions and appends the Azure Instance Metadata Service address `169.254.169.254` to both `NO_PROXY` and `no_proxy` for the setup process.

Do not use `GH_TOKEN` or `GITHUB_TOKEN` for setup. GitHub CLI gives those variables precedence over cached credentials, so authentication may appear to work without being persisted. The setup script explicitly unsets `GH_TOKEN` and `GITHUB_TOKEN` before piping `CODEX_GH_TOKEN` into `gh auth login --with-token`.

## Secret handling rules

- The GitHub setup token is used only during initial setup.
- The Codex Cloud Azure credential is a documented exception: keep it only in the Codex Cloud secret manager, rotate it before the configured expiry, and retain least-privilege resource-group-scoped RBAC.
- Do not print, log, echo, or commit any secret value.
- Do not run setup with shell tracing (`set -x`) or wrapper commands that echo environment variables.
- Do not store these secrets in repository files, PR descriptions, issue comments, or CI logs.
- Azure CLI necessarily receives a service-principal password argument during the short-lived login process. This process-list exposure is the residual risk accepted for direct Azure CLI access from Codex Cloud; Managed Identity remains preferred wherever available.
- Maintenance must verify cached `az` and `gh` authentication without requiring or printing secrets.

## Initial setup

Run setup as root on an Ubuntu/Debian host with the required environment variables already populated by the environment secret manager:

```bash
sudo -E scripts/setup-codex-env.sh
```

Use this complete setup command in Codex Cloud:

```bash
set -euo pipefail

export AZURE_CORE_OUTPUT=none
export CODEX_AZURE_AUTH_MODE=service-principal

bash scripts/setup-codex-env.sh

az account show \
  --query "{name:name,id:id,tenantId:tenantId}" \
  --output table

if [ -n "${AZURE_RESOURCE_GROUP:-}" ]; then
  az group show \
    --name "${AZURE_RESOURCE_GROUP}" \
    --query "{name:name,location:location}" \
    --output table
fi

gh auth status
gh repo view JueZ/api --json nameWithOwner,url
```

Do not repeat `az login` or `gh auth login` in the wrapper; `scripts/setup-codex-env.sh` performs each login exactly once using the selected Azure mode and the configured GitHub setup token.

The setup script:

1. Removes an inherited `apt.llvm.org` source that the repository does not use.
2. Installs or updates apt prerequisites from the remaining signed repositories.
3. Configures Microsoft and GitHub CLI apt repositories.
4. Installs `azure-cli` and `gh`.
5. Logs into Azure using the explicit mode: Managed Identity by default, or the time-limited service principal when Codex Cloud selects `service-principal`. Managed Identity mode also bypasses host proxies for Azure IMDS.
6. Selects `AZURE_SUBSCRIPTION_ID` with `az account set`.
7. Unsets `GH_TOKEN` and `GITHUB_TOKEN`.
8. Logs into GitHub CLI by piping `CODEX_GH_TOKEN` to `gh auth login --with-token` so the credential is cached.
9. Adds a missing git `origin` remote for the repository so hosted PR URLs can be resolved after commits.

## Maintenance

Run maintenance as root when the environment starts or on a regular cadence:

```bash
sudo scripts/maintain-codex-env.sh
```

The maintenance script:

1. Removes an inherited `apt.llvm.org` source that the repository does not use.
2. Reinstalls `azure-cli` and `gh` from their signed apt repositories.
3. Prints CLI versions.
4. Verifies cached Azure CLI authentication with `az account show`.
5. Unsets `GH_TOKEN` and `GITHUB_TOKEN`.
6. Verifies cached GitHub CLI authentication with `gh auth status`.
7. Adds a missing git `origin` remote for the repository so hosted PR URLs can be resolved after commits.

Maintenance must fail if cached authentication has expired or is missing. Re-run setup using the host's documented authentication mode. Rotate the Codex Cloud service-principal credential before its configured expiry and update both the secret and `CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON` together.
