#!/usr/bin/env bash
set -euo pipefail

API_APP_ID="${API_APP_ID:-97df847a-3e44-4aa7-82ea-557f3dfe0203}"
CHATGPT_APP_ID="${CHATGPT_APP_ID:-a1fd3433-6094-4411-b336-6b3a02cf9376}"
USER_UPN="${USER_UPN:-}"
APPLY="${APPLY:-false}"

if [[ -z "$USER_UPN" ]]; then
  echo 'USER_UPN is required.' >&2
  exit 1
fi

for command_name in az jq; do
  command -v "$command_name" >/dev/null || { echo "$command_name is required." >&2; exit 1; }
done

api_app="$(az ad app show --id "$API_APP_ID" --output json)"
api_object_id="$(jq -r '.id' <<<"$api_app")"
resource_sp_id="$(az ad sp show --id "$API_APP_ID" --query id --output tsv)"
chatgpt_sp_id="$(az ad sp show --id "$CHATGPT_APP_ID" --query id --output tsv)"
user_id="$(az ad user show --id "$USER_UPN" --query id --output tsv)"
scope_id="$(jq -r '.api.oauth2PermissionScopes[]? | select(.value == "weather.read" and .isEnabled == true) | .id' <<<"$api_app" | head -1)"

if [[ -z "$scope_id" ]]; then
  scope_id="$(cat /proc/sys/kernel/random/uuid)"
  updated_scopes="$(jq -c --arg id "$scope_id" '
    (.api.oauth2PermissionScopes // []) + [{
      adminConsentDescription: "Read current conditions and weather forecasts",
      adminConsentDisplayName: "Read weather forecasts",
      id: $id,
      isEnabled: true,
      type: "Admin",
      userConsentDescription: "Allow this application to read weather forecasts on your behalf.",
      userConsentDisplayName: "Read weather forecasts",
      value: "weather.read"
    }]' <<<"$api_app")"
  if [[ "$APPLY" == true ]]; then
    az rest --method PATCH \
      --url "https://graph.microsoft.com/v1.0/applications/${api_object_id}" \
      --headers Content-Type=application/json \
      --body "$(jq -cn --argjson scopes "$updated_scopes" '{api:{oauth2PermissionScopes:$scopes}}')" \
      --output none
  else
    echo 'Would expose weather.read on the API application.'
  fi
fi

grants_json="$(az rest --method GET \
  --url 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' --output json)"
grant_id="$(jq -r \
  --arg clientId "$chatgpt_sp_id" \
  --arg resourceId "$resource_sp_id" \
  --arg principalId "$user_id" \
  '[.value[]? | select(.clientId == $clientId and .resourceId == $resourceId and
    .consentType == "Principal" and .principalId == $principalId)] | first.id // empty' \
  <<<"$grants_json")"

if [[ -n "$grant_id" ]]; then
  existing_scopes="$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${grant_id}" \
    --query scope --output tsv)"
  merged_scopes="$(printf '%s\nweather.read\n' "$existing_scopes" | tr ' ' '\n' | sed '/^$/d' | sort -u | paste -sd' ' -)"
  if [[ "$APPLY" == true ]]; then
    az rest --method PATCH \
      --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${grant_id}" \
      --headers Content-Type=application/json \
      --body "$(jq -cn --arg scope "$merged_scopes" '{scope:$scope}')" --output none
  else
    echo 'Would add weather.read to the existing per-user ChatGPT consent grant.'
  fi
else
  if [[ "$APPLY" == true ]]; then
    az rest --method POST --url 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' \
      --headers Content-Type=application/json \
      --body "$(jq -cn --arg clientId "$chatgpt_sp_id" --arg resourceId "$resource_sp_id" \
        --arg principalId "$user_id" \
        '{clientId:$clientId,consentType:"Principal",principalId:$principalId,resourceId:$resourceId,scope:"weather.read"}')" \
      --output none
  else
    echo 'Would create a per-user weather.read consent grant for the ChatGPT client.'
  fi
fi

if [[ "$APPLY" == true ]]; then
  echo "Granted weather.read to the requested user for the ChatGPT OAuth client. Mint a new token."
else
  echo 'Dry run only. Rerun with APPLY=true after reviewing the resolved tenant objects.'
fi
