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

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

validate_service_principal_expiry() {
  require_env CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON

  if [[ ! "${CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON must use YYYY-MM-DD format." >&2
    exit 1
  fi

  local expiry_epoch
  if ! expiry_epoch="$(date -u -d "${CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON}T23:59:59Z" +%s 2>/dev/null)"; then
    echo "CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON is not a valid calendar date." >&2
    exit 1
  fi

  local now_epoch
  now_epoch="$(date -u +%s)"
  if (( expiry_epoch <= now_epoch )); then
    echo "The configured Codex Azure client secret is expired." >&2
    exit 1
  fi

  if (( expiry_epoch - now_epoch < 2592000 )); then
    echo "Warning: the configured Codex Azure client secret expires within 30 days." >&2
  fi
}

configure_azure_imds_proxy_bypass() {
  local imds_host="169.254.169.254"
  local variable
  local current

  # Azure CLI uses Python's proxy handling, which honors uppercase HTTP_PROXY.
  # Keep the link-local IMDS request on the host even when Codex supplies a proxy.
  for variable in NO_PROXY no_proxy; do
    current="${!variable:-}"
    case ",${current}," in
      *",${imds_host},"*) ;;
      *) printf -v "${variable}" '%s%s' "${current}" "${current:+,}${imds_host}" ;;
    esac
    export "${variable?}"
  done
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

  case "${CODEX_AZURE_AUTH_MODE:-managed-identity}" in
    service-principal)
      require_env CODEX_AZURE_CLIENT_ID
      require_env CODEX_AZURE_CLIENT_SECRET
      require_env CODEX_AZURE_TENANT_ID
      validate_service_principal_expiry

      echo "Logging into Azure CLI with the Codex Cloud service principal."
      az login \
        --service-principal \
        --username "${CODEX_AZURE_CLIENT_ID}" \
        --password "${CODEX_AZURE_CLIENT_SECRET}" \
        --tenant "${CODEX_AZURE_TENANT_ID}" \
        --output none
      ;;
    managed-identity)
      # Do not let stale service-principal credentials reach child processes when
      # an Azure-hosted Codex environment uses Managed Identity.
      unset CODEX_AZURE_CLIENT_ID CODEX_AZURE_CLIENT_SECRET CODEX_AZURE_TENANT_ID
      unset CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON
      configure_azure_imds_proxy_bypass

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
      ;;
    *)
      echo "Unsupported CODEX_AZURE_AUTH_MODE: ${CODEX_AZURE_AUTH_MODE}" >&2
      echo "Use 'managed-identity' or 'service-principal'." >&2
      exit 1
      ;;
  esac

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
