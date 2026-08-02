# Codex environment setup and maintenance

Use `scripts/setup-codex-env.sh` once per fresh Codex host to install required CLIs, cache authentication for Azure CLI and GitHub CLI, and ensure the checkout has a GitHub `origin` remote. Use `scripts/maintain-codex-env.sh` later to refresh the tools, verify that cached authentication still works, and repair a missing `origin` remote.

Both scripts are deployment-free. They install or verify tooling only and must not deploy infrastructure or application code.

## Related Codex skills

Use the repo-scoped `github-cli-devops` skill for GitHub CLI work, pull requests, workflow runs, CI logs, and repository automation. Use the repo-scoped `azure-cli-devops` skill for Azure CLI work, resource diagnostics, Bicep validation, RBAC checks, Azure Functions, Storage, and deployment debugging.

Azure CLI setup uses the Azure compute host's managed identity. The system-assigned identity is the default. Set the non-secret `CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID` only to select an attached user-assigned identity.

`CODEX_GH_TOKEN` is for setup only and must not be printed, logged, echoed, or committed. Setup clears `GH_TOKEN` and `GITHUB_TOKEN` before `gh auth login --with-token` so GitHub CLI can persist credentials instead of relying on environment-only token authentication. Maintenance verifies cached Azure CLI and GitHub CLI authentication and must not require or print secrets. Both setup and maintenance configure a missing git `origin` remote to `https://github.com/JueZ/api.git` by default, or to `https://github.com/${CODEX_GITHUB_REPOSITORY}.git` when `CODEX_GITHUB_REPOSITORY` is intentionally set.

## Required setup configuration

Provide these values only to the setup process:

- `AZURE_SUBSCRIPTION_ID` - Azure subscription selected after login.
- `CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID` - optional non-secret client ID for a user-assigned identity; omit it to use the system-assigned identity.
- `CODEX_GH_TOKEN` - GitHub token used by `gh auth login --with-token`.

The host must run on Azure compute with the selected managed identity attached and least-privilege RBAC assigned before setup. Do not provide a standing Azure client secret. The script explicitly unsets the legacy `CODEX_AZURE_CLIENT_ID`, `CODEX_AZURE_CLIENT_SECRET`, and `CODEX_AZURE_TENANT_ID` variables before starting child processes so stale setup configuration cannot be inherited.

Do not use `GH_TOKEN` or `GITHUB_TOKEN` for setup. GitHub CLI gives those variables precedence over cached credentials, so authentication may appear to work without being persisted. The setup script explicitly unsets `GH_TOKEN` and `GITHUB_TOKEN` before piping `CODEX_GH_TOKEN` into `gh auth login --with-token`.

## Secret handling rules

- The GitHub setup token is used only during initial setup; Azure authentication has no operator-managed credential.
- Do not print, log, echo, or commit any secret value.
- Do not run setup with shell tracing (`set -x`) or wrapper commands that echo environment variables.
- Do not store these secrets in repository files, PR descriptions, issue comments, or CI logs.
- Maintenance must verify cached `az` and `gh` authentication without requiring or printing secrets.

## Initial setup

Run setup as root on an Ubuntu/Debian host with the required environment variables already populated by the environment secret manager:

```bash
sudo -E scripts/setup-codex-env.sh
```

The setup script:

1. Installs or updates apt prerequisites.
2. Configures Microsoft and GitHub CLI apt repositories.
3. Installs `azure-cli` and `gh`.
4. Logs into Azure with `az login --identity`, selecting `CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID` only when configured.
5. Selects `AZURE_SUBSCRIPTION_ID` with `az account set`.
6. Unsets `GH_TOKEN` and `GITHUB_TOKEN`.
7. Logs into GitHub CLI by piping `CODEX_GH_TOKEN` to `gh auth login --with-token` so the credential is cached.
8. Adds a missing git `origin` remote for the repository so hosted PR URLs can be resolved after commits.

## Maintenance

Run maintenance as root when the environment starts or on a regular cadence:

```bash
sudo scripts/maintain-codex-env.sh
```

The maintenance script:

1. Reinstalls `azure-cli` and `gh` from their apt repositories.
2. Prints CLI versions.
3. Verifies cached Azure CLI authentication with `az account show`.
4. Unsets `GH_TOKEN` and `GITHUB_TOKEN`.
5. Verifies cached GitHub CLI authentication with `gh auth status`.
6. Adds a missing git `origin` remote for the repository so hosted PR URLs can be resolved after commits.

Maintenance must fail if cached authentication has expired or is missing. Re-run setup on the managed-identity host rather than adding Azure credentials to the maintenance path. After the managed-identity path is verified, remove legacy Azure setup values from the host secret manager and revoke the obsolete service-principal credential through the normal operator rotation process.
