#!/usr/bin/env bash
set -euo pipefail

# Idempotently grant one delegated API scope to one user for one OAuth client.
# This is intentionally separate from application-role assignment: user tokens
# carry delegated scopes in `scp`, while service tokens carry roles.

API_APP_ID="${API_APP_ID:-}"
OAUTH_CLIENT_APP_ID="${OAUTH_CLIENT_APP_ID:-}"
USER_ID="${USER_ID:-}"
DELEGATED_SCOPE_VALUE="${DELEGATED_SCOPE_VALUE:-youtube.read}"

for required_command in az jq; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "Missing required command: $required_command" >&2
    exit 1
  }
done

if [ -z "$API_APP_ID" ] || [ -z "$OAUTH_CLIENT_APP_ID" ] || [ -z "$USER_ID" ]; then
  cat >&2 <<'USAGE'
API_APP_ID, OAUTH_CLIENT_APP_ID, and USER_ID are required.

USER_ID may be the user's object ID or user principal name. Example:
  API_APP_ID='<API application client ID>' \
  OAUTH_CLIENT_APP_ID='<web or ChatGPT OAuth client application ID>' \
  USER_ID='user@example.com' \
  DELEGATED_SCOPE_VALUE='youtube.read' \
  ./scripts/grant-entra-user-scope.sh
USAGE
  exit 1
fi

api_app_json="$(az ad app show --id "$API_APP_ID" --output json)"
scope_enabled="$(jq -r --arg scope "$DELEGATED_SCOPE_VALUE" \
  '[.api.oauth2PermissionScopes[]? | select(.value == $scope and .isEnabled == true)] | length' \
  <<<"$api_app_json")"
if [ "$scope_enabled" != "1" ]; then
  echo "The API application does not expose exactly one enabled '$DELEGATED_SCOPE_VALUE' delegated scope." >&2
  exit 1
fi

resource_object_id="$(az ad sp show --id "$API_APP_ID" --query id --output tsv)"
client_object_id="$(az ad sp show --id "$OAUTH_CLIENT_APP_ID" --query id --output tsv)"
user_object_id="$(az ad user show --id "$USER_ID" --query id --output tsv)"
grants_url='https://graph.microsoft.com/v1.0/oauth2PermissionGrants'
grants_json="$(az rest --method GET --url "$grants_url" --output json)"
existing_grant="$(jq -c \
  --arg clientId "$client_object_id" \
  --arg resourceId "$resource_object_id" \
  --arg principalId "$user_object_id" \
  '[.value[]? | select(.clientId == $clientId and .resourceId == $resourceId and
    .consentType == "Principal" and .principalId == $principalId)] | first // empty' \
  <<<"$grants_json")"

if [ -z "$existing_grant" ]; then
  body="$(jq -nc \
    --arg clientId "$client_object_id" \
    --arg resourceId "$resource_object_id" \
    --arg principalId "$user_object_id" \
    --arg scope "$DELEGATED_SCOPE_VALUE" \
    '{clientId:$clientId, consentType:"Principal", principalId:$principalId,
      resourceId:$resourceId, scope:$scope}')"
  az rest --method POST --url "$grants_url" --headers Content-Type=application/json \
    --body "$body" --only-show-errors --output none
  echo "Granted delegated scope '$DELEGATED_SCOPE_VALUE' to '$USER_ID' for the OAuth client."
  exit 0
fi

grant_id="$(jq -r '.id' <<<"$existing_grant")"
current_scopes="$(jq -r '.scope // ""' <<<"$existing_grant")"
updated_scopes="$({ tr ' ' '\n' <<<"$current_scopes"; printf '%s\n' "$DELEGATED_SCOPE_VALUE"; } |
  awk 'NF && !seen[$0]++' | sort | paste -sd' ' -)"

if [ "$updated_scopes" = "$current_scopes" ]; then
  echo "Verified delegated scope '$DELEGATED_SCOPE_VALUE' for '$USER_ID' on the OAuth client."
else
  body="$(jq -nc --arg scope "$updated_scopes" '{scope:$scope}')"
  az rest --method PATCH --url "$grants_url/$grant_id" --headers Content-Type=application/json \
    --body "$body" --only-show-errors --output none
  echo "Added delegated scope '$DELEGATED_SCOPE_VALUE' for '$USER_ID' without removing existing scopes."
fi
