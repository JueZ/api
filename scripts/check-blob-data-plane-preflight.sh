#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <storage-account> <container> <blob-name> [timeout-seconds]" >&2
  exit 2
fi

ACCOUNT="$1"
CONTAINER="$2"
BLOB_NAME="$3"
TIMEOUT_SECS="${4:-30}"

ACCOUNT_HOST="${ACCOUNT}.blob.core.windows.net"

echo "[info] az account"
az account show --query '{subscription:id,tenant:tenantId,principalType:user.type,principal:user.name}' -o table

echo "[info] storage token metadata (sanitized)"
az account get-access-token --resource https://storage.azure.com/ --query '{tokenType:tokenType,expiresOn:expiresOn,tenant:tenant,subscription:subscription}' -o table

echo "[info] storage account network configuration"
az storage account show -n "$ACCOUNT" \
  --query '{name:name,publicNetworkAccess:publicNetworkAccess,defaultAction:networkRuleSet.defaultAction,bypass:networkRuleSet.bypass,ipRuleCount:length(networkRuleSet.ipRules),vnetRuleCount:length(networkRuleSet.virtualNetworkRules),privateEndpointCount:length(privateEndpointConnections)}' \
  -o table

echo "[info] DNS resolution for ${ACCOUNT_HOST}"
getent ahosts "$ACCOUNT_HOST" | awk '{print $1}' | sort -u | sed 's/^/[dns] /'

echo "[info] HTTPS probe to blob endpoint via runtime proxy settings"
if timeout "$TIMEOUT_SECS" curl -I -sS "https://${ACCOUNT_HOST}/" >/tmp/blob-preflight-curl.out; then
  head -n 2 /tmp/blob-preflight-curl.out | sed 's/^/[curl] /'
else
  echo "[curl] FAILED/TIMEOUT"
fi

echo "[info] data-plane check with Azure AD login (bounded timeout)"
set +e
timeout "$TIMEOUT_SECS" az storage blob exists \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --container-name "$CONTAINER" \
  --name "$BLOB_NAME" \
  --output json >/tmp/blob-preflight-login.json 2>/tmp/blob-preflight-login.err
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  python - <<'PY'
import json
print('[login]', json.load(open('/tmp/blob-preflight-login.json')))
PY
elif [[ $rc -eq 124 ]]; then
  echo "[login] TIMEOUT after ${TIMEOUT_SECS}s"
else
  echo "[login] FAILED rc=${rc}"
  tail -n 5 /tmp/blob-preflight-login.err | sed 's/^/[login-err] /'
fi

echo "[info] done"
