#!/usr/bin/env bash
set -euo pipefail

# Install and authenticate the CLIs needed for Codex DevOps verification.
# This script is deployment-free: it installs tooling and caches az/gh auth only.
# Never run with shell tracing enabled because the environment includes secrets.

reject_shell_tracing() {
  if [[ $- == *x* || "${TRACE:-}" == "1" ]]; then
    # Turn off xtrace before printing the refusal so no later command can leak
    # secret-bearing environment variables into logs.
    set +x
    echo "Refusing to run with shell tracing enabled because setup uses secret environment variables." >&2
    exit 1
  fi
}

reject_shell_tracing

# Legacy service-principal setup variables must not be inherited by any child
# process. Azure authentication below uses the host's managed identity.
unset CODEX_AZURE_CLIENT_ID CODEX_AZURE_CLIENT_SECRET CODEX_AZURE_TENANT_ID

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}


configure_git_remote() {
  local repository="${CODEX_GITHUB_REPOSITORY:-JueZ/api}"
  local remote_url="https://github.com/${repository}.git"
  local worktree

  if ! worktree="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "Skipping git remote configuration because the current directory is not a git worktree."
    return 0
  fi

  if git -C "${worktree}" remote get-url origin >/dev/null 2>&1; then
    echo "Git remote 'origin' is already configured."
    return 0
  fi

  echo "Configuring git remote 'origin' for ${repository}."
  git -C "${worktree}" remote add origin "${remote_url}"
}

install_tools() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "This setup script must run as root so it can configure apt repositories." >&2
    exit 1
  fi

  if [[ -r /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
  else
    echo "Unsupported OS: /etc/os-release not found." >&2
    exit 1
  fi

  if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *"debian"* ]]; then
    echo "Unsupported OS: this setup script expects Ubuntu/Debian with apt." >&2
    exit 1
  fi

  export DEBIAN_FRONTEND=noninteractive

  apt-get update
  apt-get install -y ca-certificates curl apt-transport-https lsb-release gnupg git

  install -m 0755 -d /etc/apt/keyrings

  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor > /etc/apt/keyrings/microsoft.gpg
  chmod go+r /etc/apt/keyrings/microsoft.gpg

  local architecture
  architecture="$(dpkg --print-architecture)"
  local azure_suite
  azure_suite="$(lsb_release -cs)"
  cat > /etc/apt/sources.list.d/azure-cli.sources <<AZURE_SOURCES
Types: deb
URIs: https://packages.microsoft.com/repos/azure-cli/
Suites: ${azure_suite}
Components: main
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/microsoft.gpg
AZURE_SOURCES

  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    > /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

  cat > /etc/apt/sources.list.d/github-cli.sources <<GITHUB_CLI_SOURCES
Types: deb
URIs: https://cli.github.com/packages
Suites: stable
Components: main
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/githubcli-archive-keyring.gpg
GITHUB_CLI_SOURCES

  apt-get update
  apt-get install -y azure-cli gh
}

login_azure() {
  reject_shell_tracing
  require_env AZURE_SUBSCRIPTION_ID

  if [[ -n "${CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID:-}" ]]; then
    echo "Logging into Azure CLI with the configured user-assigned managed identity."
    az login \
      --identity \
      --client-id "${CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID}" \
      --output none
  else
    echo "Logging into Azure CLI with the host system-assigned managed identity."
    az login --identity --output none
  fi
  az account set --subscription "${AZURE_SUBSCRIPTION_ID}"
  az account show --query '{name:name, id:id, tenantId:tenantId}' --output table
}

login_github() {
  reject_shell_tracing
  require_env CODEX_GH_TOKEN

  echo "Logging into GitHub CLI with CODEX_GH_TOKEN."
  # gh gives precedence to GH_TOKEN/GITHUB_TOKEN environment variables and will not
  # persist authentication while they are set. Clear them before --with-token.
  unset GH_TOKEN
  unset GITHUB_TOKEN
  printf '%s' "${CODEX_GH_TOKEN}" | gh auth login --with-token
  gh auth status
}

main() {
  install_tools
  az version --output table
  gh --version
  login_azure
  login_github
  configure_git_remote

  echo "Codex environment setup complete."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
