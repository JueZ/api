#!/usr/bin/env bash
set -euo pipefail

# Install and authenticate the CLIs needed for Codex DevOps verification.
# This script is deployment-free: it installs tooling and caches az/gh auth only.
# Never run with shell tracing enabled because the environment may include secrets.

if [[ "${TRACE:-}" == "1" ]]; then
  echo "Refusing to run with TRACE=1 because setup may use secret environment variables." >&2
  exit 1
fi

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This setup script needs root privileges or sudo to configure apt repositories." >&2
    exit 1
  fi
}

install_tools() {
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

  run_as_root apt-get update
  run_as_root apt-get install -y ca-certificates curl apt-transport-https lsb-release gnupg

  run_as_root install -m 0755 -d /etc/apt/keyrings

  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor \
    | run_as_root tee /etc/apt/keyrings/microsoft.gpg >/dev/null
  run_as_root chmod go+r /etc/apt/keyrings/microsoft.gpg

  local architecture
  architecture="$(dpkg --print-architecture)"

  local azure_suite
  azure_suite="$(lsb_release -cs)"

  cat > /tmp/azure-cli.sources <<AZURE_SOURCES
Types: deb
URIs: https://packages.microsoft.com/repos/azure-cli/
Suites: ${azure_suite}
Components: main
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/microsoft.gpg
AZURE_SOURCES
  run_as_root mv /tmp/azure-cli.sources /etc/apt/sources.list.d/azure-cli.sources

  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | run_as_root tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  run_as_root chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

  cat > /tmp/github-cli.sources <<GITHUB_CLI_SOURCES
Types: deb
URIs: https://cli.github.com/packages
Suites: stable
Components: main
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/githubcli-archive-keyring.gpg
GITHUB_CLI_SOURCES
  run_as_root mv /tmp/github-cli.sources /etc/apt/sources.list.d/github-cli.sources

  run_as_root apt-get update
  run_as_root apt-get install -y azure-cli gh
}

login_azure_if_configured() {
  local tenant_id="${CODEX_AZURE_TENANT_ID:-${AZURE_TENANT_ID:-}}"

  local any_azure_config="false"
  for name in CODEX_AZURE_CLIENT_ID CODEX_AZURE_CLIENT_SECRET CODEX_AZURE_TENANT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do
    if [[ -n "${!name:-}" ]]; then
      any_azure_config="true"
    fi
  done

  if [[ "${any_azure_config}" != "true" ]]; then
    echo "Azure auth variables not present; skipping Azure CLI login."
    return 0
  fi

  local missing=()

  [[ -z "${CODEX_AZURE_CLIENT_ID:-}" ]] && missing+=("CODEX_AZURE_CLIENT_ID")
  [[ -z "${CODEX_AZURE_CLIENT_SECRET:-}" ]] && missing+=("CODEX_AZURE_CLIENT_SECRET")
  [[ -z "${tenant_id}" ]] && missing+=("CODEX_AZURE_TENANT_ID or AZURE_TENANT_ID")
  [[ -z "${AZURE_SUBSCRIPTION_ID:-}" ]] && missing+=("AZURE_SUBSCRIPTION_ID")

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "Partial Azure auth configuration detected. Missing required variable(s):" >&2
    printf ' - %s\n' "${missing[@]}" >&2
    exit 1
  fi

  export AZURE_CORE_OUTPUT=none

  echo "Logging into Azure CLI with Codex service principal credentials."
  az login \
    --service-principal \
    --username "${CODEX_AZURE_CLIENT_ID}" \
    --password "${CODEX_AZURE_CLIENT_SECRET}" \
    --tenant "${tenant_id}" \
    --output none

  az account set --subscription "${AZURE_SUBSCRIPTION_ID}"

  az account show \
    --query '{name:name, id:id, tenantId:tenantId}' \
    --output table

  if [[ -n "${AZURE_RESOURCE_GROUP:-}" ]]; then
    az group show \
      --name "${AZURE_RESOURCE_GROUP}" \
      --query '{name:name, location:location}' \
      --output table
  fi
}

login_github_if_configured() {
  local token=""

  if [[ -n "${CODEX_GH_TOKEN:-}" ]]; then
    token="${CODEX_GH_TOKEN}"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    token="${GH_TOKEN}"
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    token="${GITHUB_TOKEN}"
  fi

  if [[ -z "${token}" ]]; then
    echo "GitHub token not present; skipping GitHub CLI login."
    return 0
  fi

  echo "Logging into GitHub CLI with provided token."

  # gh gives precedence to GH_TOKEN/GITHUB_TOKEN and will not persist auth while
  # they are set. Copy the token into a local variable, then clear those env vars.
  unset GH_TOKEN
  unset GITHUB_TOKEN

  printf '%s' "${token}" | gh auth login --hostname github.com --with-token
  token=""

  gh auth status
  gh repo view JueZ/api >/dev/null
  echo "GitHub CLI authentication verified for JueZ/api."
}

install_tools

az version --output table
gh --version

login_azure_if_configured
login_github_if_configured

echo "Codex environment setup complete."
