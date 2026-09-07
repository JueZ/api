#!/usr/bin/env bash
set -euo pipefail

# Cached startup is a health check. Package upgrades are an explicit operation.
# Source the single signed-repository installer without running setup or login.
# shellcheck source=scripts/setup-codex-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/setup-codex-env.sh"

azure_tool_healthy() {
  local version
  version="$(az version --query '"azure-cli"' --output tsv 2>/dev/null)" || return 1
  [[ "$version" =~ ^2\.[0-9]+\.[0-9]+$ ]] || return 1
  az account get-access-token --help >/dev/null 2>&1 && az rest --help >/dev/null 2>&1
}

github_tool_healthy() {
  local version merge_help
  version="$(gh --version 2>/dev/null)" || return 1
  [[ "$version" =~ ^gh\ version\ 2\.[0-9]+\.[0-9]+ ]] || return 1
  merge_help="$(gh pr merge --help 2>/dev/null)" || return 1
  [[ "$merge_help" == *--match-head-commit* && "$merge_help" == *--auto* && "$merge_help" == *--squash* ]] &&
    gh run view --help >/dev/null 2>&1
}

verify_local_runtime() {
  local version
  version="$(node --version 2>/dev/null)" || { echo 'Node.js 22 is required in the host configuration.' >&2; return 1; }
  [[ "$version" == v22.* ]] || { echo 'Select Node.js 22 in the host configuration.' >&2; return 1; }
  npm --version
  git --version
}

verify_cached_auth() {
  echo 'Verifying cached Azure CLI authentication.'
  az account show --query '{name:name, id:id, tenantId:tenantId}' --output table
  echo 'Verifying cached GitHub CLI authentication.'
  # Do not let environment tokens mask a missing persisted credential.
  unset GH_TOKEN GITHUB_TOKEN
  gh auth status
}

verify_repository() {
  local repository="${CODEX_GITHUB_REPOSITORY:-JueZ/api}" origin
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo 'Invalid CODEX_GITHUB_REPOSITORY.' >&2; return 1;
  }
  configure_git_remote
  if ! git rev-parse --show-toplevel >/dev/null 2>&1; then return 0; fi
  origin="$(git remote get-url origin)"
  case "${origin%.git}" in
    "https://github.com/${repository}"|"git@github.com:${repository}"|"ssh://git@github.com/${repository}") ;;
    *) echo 'Existing origin does not match CODEX_GITHUB_REPOSITORY; it was preserved.' >&2; return 1 ;;
  esac
}

maintain() {
  local mode="${1:-check}" packages=()
  [[ "$#" -le 1 && ( "$mode" == check || "$mode" == --upgrade-tools ) ]] || {
    echo 'Usage: maintain-codex-env.sh [--upgrade-tools]' >&2; return 1;
  }
  verify_local_runtime
  if [[ "$mode" == --upgrade-tools ]]; then
    install_tools azure-cli gh
    if ! azure_tool_healthy || ! github_tool_healthy; then
      echo 'CLI capability verification failed after upgrade.' >&2; return 1
    fi
  else
    if ! azure_tool_healthy; then packages+=(azure-cli); fi
    if ! github_tool_healthy; then packages+=(gh); fi
    if [[ "${#packages[@]}" -gt 0 ]]; then
      echo "Repairing unavailable or incompatible CLI packages: ${packages[*]}"
      install_tools --reinstall "${packages[@]}"
      if ! azure_tool_healthy || ! github_tool_healthy; then
        echo 'CLI capability verification failed after repair.' >&2; return 1
      fi
    else
      echo 'CLI tools are healthy; no package indexes, keys, or installations changed.'
    fi
  fi
  verify_cached_auth
  verify_repository
  echo 'Codex environment maintenance complete.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  maintain "$@"
fi
