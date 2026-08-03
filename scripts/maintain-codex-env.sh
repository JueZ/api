#!/usr/bin/env bash
set -euo pipefail

# Reinstall/verify Codex CLI tooling and cached CLI authentication.
# This script is deployment-free and must never print tokens, client secrets, or other secrets.


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
    echo "This maintenance script must run as root so it can refresh apt packages." >&2
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
    echo "Unsupported OS: this maintenance script expects Ubuntu/Debian with apt." >&2
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
  apt-get install -y --reinstall azure-cli gh
}

verify_cached_auth() {
  echo "Verifying cached Azure CLI authentication."
  az account show --query '{name:name, id:id, tenantId:tenantId}' --output table

  echo "Verifying cached GitHub CLI authentication."
  # Ensure this check uses the persisted gh credential cache, not environment tokens.
  unset GH_TOKEN
  unset GITHUB_TOKEN
  gh auth status
}

install_tools
az version --output table
gh --version
verify_cached_auth
configure_git_remote

echo "Codex environment maintenance complete."
