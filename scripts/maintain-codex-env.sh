#!/usr/bin/env bash
set -euo pipefail

# Maintenance script for cached Codex containers.
# It verifies tools and cached authentication only.
# It does not deploy and does not require or print secrets.

if [[ "${TRACE:-}" == "1" ]]; then
  echo "Refusing to run with TRACE=1." >&2
  exit 1
fi

if [[ ! -x scripts/setup-codex-env.sh ]]; then
  chmod +x scripts/setup-codex-env.sh
fi

if ! command -v az >/dev/null 2>&1 || ! command -v gh >/dev/null 2>&1; then
  echo "az or gh missing; running setup script to install tools."
  scripts/setup-codex-env.sh
fi

export AZURE_CORE_OUTPUT=none

echo "Azure CLI version:"
az version --output table

echo "GitHub CLI version:"
gh --version

echo "Checking cached Azure CLI login."
if az account show --query '{name:name, id:id, tenantId:tenantId}' --output table; then
  if [[ -n "${AZURE_RESOURCE_GROUP:-}" ]]; then
    az group show \
      --name "${AZURE_RESOURCE_GROUP}" \
      --query '{name:name, location:location}' \
      --output table || true
  fi
else
  echo "Azure CLI is not logged in. Reset Codex cache or rerun setup with Azure secrets available."
fi

echo "Checking cached GitHub CLI login."
if gh auth status; then
  gh repo view JueZ/api >/dev/null || true
else
  echo "GitHub CLI is not logged in. Reset Codex cache or rerun setup with CODEX_GH_TOKEN/GH_TOKEN available."
fi

echo "Codex environment maintenance complete."
