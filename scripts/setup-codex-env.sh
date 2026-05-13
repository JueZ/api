#!/usr/bin/env bash
set -euo pipefail

# Install the CLIs needed for Codex DevOps verification.
# This script is intentionally deployment-free: it only installs tooling.

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
apt-get install -y ca-certificates curl apt-transport-https lsb-release gnupg

install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
  | gpg --dearmor > /etc/apt/keyrings/microsoft.gpg
chmod go+r /etc/apt/keyrings/microsoft.gpg

architecture="$(dpkg --print-architecture)"
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

az version
gh --version
