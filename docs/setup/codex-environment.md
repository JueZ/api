# Codex environment setup and maintenance

Use `scripts/setup-codex-env.sh` once per fresh Codex host to install required CLIs and cache authentication for Azure CLI and GitHub CLI. Use `scripts/maintain-codex-env.sh` later to refresh the tools and verify that cached authentication still works.

Both scripts are deployment-free. They install or verify tooling only and must not deploy infrastructure or application code.

## Required setup secrets

Provide these environment variables only to the setup process:

- `CODEX_AZURE_CLIENT_ID` - Azure service principal application/client ID used by Codex setup.
- `CODEX_AZURE_CLIENT_SECRET` - Azure service principal secret used by Codex setup.
- `CODEX_AZURE_TENANT_ID` - Azure tenant ID for the service principal.
- `AZURE_SUBSCRIPTION_ID` - Azure subscription selected after login.
- `CODEX_GH_TOKEN` - GitHub token used by `gh auth login --with-token`.

Do not use `GH_TOKEN` or `GITHUB_TOKEN` for setup. GitHub CLI gives those variables precedence over cached credentials, so authentication may appear to work without being persisted. The setup script explicitly unsets `GH_TOKEN` and `GITHUB_TOKEN` before piping `CODEX_GH_TOKEN` into `gh auth login --with-token`.

## Secret handling rules

- Secrets are used only during initial setup.
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
4. Logs into Azure using `CODEX_AZURE_CLIENT_ID`, `CODEX_AZURE_CLIENT_SECRET`, and `CODEX_AZURE_TENANT_ID`.
5. Selects `AZURE_SUBSCRIPTION_ID` with `az account set`.
6. Unsets `GH_TOKEN` and `GITHUB_TOKEN`.
7. Logs into GitHub CLI by piping `CODEX_GH_TOKEN` to `gh auth login --with-token` so the credential is cached.

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

Maintenance must fail if cached authentication has expired or is missing. Re-run setup with fresh secrets instead of adding secrets to the maintenance path.
