#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <storage-account> [container] [blob-name]" >&2
  exit 2
fi

ACCOUNT="$1"
CONTAINER="${2:-wlh-reference}"
BLOB_NAME="${3:-categories-marketplace.v1.json.gz}"

command -v az >/dev/null || { echo "az CLI not found" >&2; exit 1; }
command -v timeout >/dev/null || { echo "timeout not found" >&2; exit 1; }

echo "== Identity =="
az account show --query '{subscription:id,tenant:tenantId,principalType:user.type,principal:user.name}' -o table

SP_APP_ID="$(az account show --query user.name -o tsv)"
SP_OBJECT_ID="$(az ad sp show --id "$SP_APP_ID" --query id -o tsv 2>/dev/null || true)"
if [[ -n "$SP_OBJECT_ID" ]]; then
  echo "servicePrincipalObjectId: $SP_OBJECT_ID"
fi

echo "== Storage token sanity (metadata only) =="
az account get-access-token --resource https://storage.azure.com/ --query '{tenant:tenant,expiresOn:expiresOn,tokenType:tokenType}' -o table

echo "== Storage account network settings =="
az storage account show -n "$ACCOUNT" --query '{resourceGroup:resourceGroup,publicNetworkAccess:publicNetworkAccess,defaultAction:networkRuleSet.defaultAction,bypass:networkRuleSet.bypass,ipRules:networkRuleSet.ipRules[].value,vnetRules:networkRuleSet.virtualNetworkRules[].virtualNetworkResourceId,privateEndpoints:privateEndpointConnections[].id}' -o json

echo "== DNS + HTTPS reachability =="
getent hosts "$ACCOUNT.blob.core.windows.net" || true
timeout 15s curl -I --max-time 10 "https://$ACCOUNT.blob.core.windows.net/" -sS -o /dev/null -w 'http=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' || true

echo "== RBAC (Storage Blob Data* for current principal) =="
if [[ -n "$SP_OBJECT_ID" ]]; then
  az role assignment list --assignee-object-id "$SP_OBJECT_ID" --all --query "[?contains(roleDefinitionName, 'Storage Blob Data')].{role:roleDefinitionName,scope:scope}" -o table
fi

echo "== Data-plane call (bounded) =="
set +e
timeout 30s az storage blob exists --account-name "$ACCOUNT" --container-name "$CONTAINER" --name "$BLOB_NAME" --auth-mode login -o json
status=$?
set -e
if [[ $status -eq 124 ]]; then
  echo "RESULT: timeout (likely network/proxy path issue)."
elif [[ $status -ne 0 ]]; then
  echo "RESULT: non-timeout failure (inspect stderr for RBAC/auth/resource errors)."
else
  echo "RESULT: success."
fi

exit 0
