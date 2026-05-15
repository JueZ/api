#!/usr/bin/env bash
set -euo pipefail

# Safe, idempotent helper for preparing a dedicated Microsoft Entra OAuth client
# for ChatGPT Custom GPT / GPT Actions against the JueZ API Catalogue.
#
# Defaults are inspect/prepare oriented. It only mutates GitHub variables or Azure
# Function App settings when SET_GITHUB_VARIABLES=true or SET_AZURE_APP_SETTINGS=true.
# It creates a client secret only when CREATE_CLIENT_SECRET=true.

REPOSITORY="${REPOSITORY:-JueZ/api}"
API_APP_ID="${API_APP_ID:-}"
GPT_ACTION_REDIRECT_URI="${GPT_ACTION_REDIRECT_URI:-}"
GPT_ACTION_ADDITIONAL_REDIRECT_URIS="${GPT_ACTION_ADDITIONAL_REDIRECT_URIS:-}"
GPT_ACTION_APP_DISPLAY_NAME="${GPT_ACTION_APP_DISPLAY_NAME:-JueZ API Catalogue ChatGPT Action}"
API_SCOPE_VALUE="${API_SCOPE_VALUE:-api.access}"
SET_GITHUB_VARIABLES="${SET_GITHUB_VARIABLES:-false}"
SET_AZURE_APP_SETTINGS="${SET_AZURE_APP_SETTINGS:-false}"
CREATE_CLIENT_SECRET="${CREATE_CLIENT_SECRET:-false}"
CLIENT_SECRET_DISPLAY_NAME="${CLIENT_SECRET_DISPLAY_NAME:-ChatGPT Action OAuth secret}"
CLIENT_SECRET_YEARS="${CLIENT_SECRET_YEARS:-1}"
TEST_RESOURCE_GROUP="${TEST_RESOURCE_GROUP:-rg-api-test}"
PROD_RESOURCE_GROUP="${PROD_RESOURCE_GROUP:-rg-api-prod}"
TEST_FUNCTION_APP="${TEST_FUNCTION_APP:-func-api-catalogue-test-iwt54bovfzvrc}"
PROD_FUNCTION_APP="${PROD_FUNCTION_APP:-func-api-catalogue-prod-bfjstshehpbfk}"
PRODUCTION_API_BASE_URL="${PRODUCTION_API_BASE_URL:-https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

bool_is_true() {
  [ "${1,,}" = "true" ]
}

csv_join_unique() {
  tr ',' '\n' | awk 'NF { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 != "" && !seen[$0]++) print $0 }' | paste -sd, -
}

require_cmd az
require_cmd jq

if [ -z "$API_APP_ID" ]; then
  echo "API_APP_ID is required. Set it to the API app client ID from WEB_AUTH_API_SCOPE or OIDC_AUDIENCE." >&2
  exit 1
fi

if [ -z "$GPT_ACTION_REDIRECT_URI" ]; then
  cat >&2 <<MSG
GPT_ACTION_REDIRECT_URI is required.
Paste the callback/redirect URL shown by GPT Builder after you choose OAuth authentication.
Example: GPT_ACTION_REDIRECT_URI='https://chat.openai.com/aip/g-.../oauth/callback'
You may also set GPT_ACTION_ADDITIONAL_REDIRECT_URIS to a comma-separated list.
MSG
  exit 1
fi

build_redirect_uris_json() {
  local primary_uri="$1"
  local additional_uris="$2"
  {
    printf '%s\n' "$primary_uri"
    if [[ "$primary_uri" == https://chat.openai.com/aip/*/oauth/callback ]]; then
      printf '%s\n' "${primary_uri/https:\/\/chat.openai.com/https://chatgpt.com}"
    elif [[ "$primary_uri" == https://chatgpt.com/aip/*/oauth/callback ]]; then
      printf '%s\n' "${primary_uri/https:\/\/chatgpt.com/https://chat.openai.com}"
    fi
    if [ -n "$additional_uris" ]; then
      tr ',' '\n' <<<"$additional_uris"
    fi
  } | jq -R 'gsub("^[[:space:]]+|[[:space:]]+$"; "") | select(length > 0)' | jq -s -c 'unique'
}

requested_redirect_uris_json="$(build_redirect_uris_json "$GPT_ACTION_REDIRECT_URI" "$GPT_ACTION_ADDITIONAL_REDIRECT_URIS")"

account_json="$(az account show -o json)"
tenant_id="$(jq -r '.tenantId' <<<"$account_json")"
subscription_id="$(jq -r '.id' <<<"$account_json")"

echo "Using tenant: $tenant_id"
echo "Using subscription: $subscription_id"

api_json="$(az ad app show --id "$API_APP_ID" -o json)"
api_object_id="$(jq -r '.id' <<<"$api_json")"
api_display_name="$(jq -r '.displayName' <<<"$api_json")"
api_identifier_uri="$(jq -r --arg fallback "api://$API_APP_ID" '(.identifierUris // []) | if length > 0 then .[0] else $fallback end' <<<"$api_json")"
scope_id="$(jq -r --arg value "$API_SCOPE_VALUE" '.api.oauth2PermissionScopes // [] | map(select(.value == $value and (.isEnabled // true))) | .[0].id // empty' <<<"$api_json")"

if [ -z "$scope_id" ]; then
  cat >&2 <<MSG
The API app '$api_display_name' ($API_APP_ID) does not expose an enabled delegated scope named '$API_SCOPE_VALUE'.
Create or enable the scope on the API app registration first, then rerun this script.
Expected scope URI: ${api_identifier_uri}/${API_SCOPE_VALUE}
Azure Portal path: Microsoft Entra ID > App registrations > $api_display_name > Expose an API > Add a scope.
MSG
  exit 1
fi

scope_uri="${api_identifier_uri%/}/$API_SCOPE_VALUE"
authorization_url="https://login.microsoftonline.com/$tenant_id/oauth2/v2.0/authorize"
token_url="https://login.microsoftonline.com/$tenant_id/oauth2/v2.0/token"

echo "API app: $api_display_name"
echo "API app client ID: $API_APP_ID"
echo "API app object ID: $api_object_id"
echo "API identifier URI: $api_identifier_uri"
echo "Delegated scope: $scope_uri"

existing_apps="$(az ad app list --display-name "$GPT_ACTION_APP_DISPLAY_NAME" -o json)"
matching_app="$(jq -c --arg name "$GPT_ACTION_APP_DISPLAY_NAME" '[.[] | select(.displayName == $name)] | .[0] // empty' <<<"$existing_apps")"

if [ -n "$matching_app" ]; then
  gpt_app_id="$(jq -r '.appId' <<<"$matching_app")"
  gpt_object_id="$(jq -r '.id' <<<"$matching_app")"
  echo "Reusing existing GPT Action app registration: $GPT_ACTION_APP_DISPLAY_NAME ($gpt_app_id)"
else
  echo "Creating GPT Action app registration: $GPT_ACTION_APP_DISPLAY_NAME"
  mapfile -t requested_redirect_uris < <(jq -r '.[]' <<<"$requested_redirect_uris_json")
  created_app="$(az ad app create \
    --display-name "$GPT_ACTION_APP_DISPLAY_NAME" \
    --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "${requested_redirect_uris[@]}" \
    -o json)"
  gpt_app_id="$(jq -r '.appId' <<<"$created_app")"
  gpt_object_id="$(jq -r '.id' <<<"$created_app")"
fi

current_app="$(az ad app show --id "$gpt_app_id" -o json)"
missing_redirects_json="$(jq -c --argjson requested "$requested_redirect_uris_json" '[($requested[] | select((. as $uri | ($ARGS.named.current | fromjson | index($uri)) | not)))]' --arg current "$(jq -c '(.web.redirectUris // [])' <<<"$current_app")" <<< '{}')"
if [ "$(jq -r 'length' <<<"$missing_redirects_json")" -gt 0 ]; then
  echo "Adding GPT Action redirect URI/URIs to web client."
  mapfile -t redirect_uris < <(jq -r --argjson requested "$requested_redirect_uris_json" '((.web.redirectUris // []) + $requested) | unique | .[]' <<<"$current_app")
  az ad app update \
    --id "$gpt_app_id" \
    --web-redirect-uris "${redirect_uris[@]}" \
    --enable-access-token-issuance false \
    --enable-id-token-issuance false \
    >/dev/null
else
  az ad app update \
    --id "$gpt_app_id" \
    --enable-access-token-issuance false \
    --enable-id-token-issuance false \
    >/dev/null
fi

# Add delegated API permission to the GPT Action client if missing.
current_app="$(az ad app show --id "$gpt_app_id" -o json)"
permission_exists="$(jq -r --arg api "$API_APP_ID" --arg scope "$scope_id" '(.requiredResourceAccess // []) | map(select(.resourceAppId == $api) | .resourceAccess // [] | map(select(.id == $scope and .type == "Scope")) | length) | add // 0 | . > 0' <<<"$current_app")"
if [ "$permission_exists" != "true" ]; then
  echo "Adding delegated API permission $scope_uri to GPT Action app."
  updated_required_resource_access="$(jq -c --arg api "$API_APP_ID" --arg scope "$scope_id" '
    .requiredResourceAccess = (
      (.requiredResourceAccess // [] | map(select(.resourceAppId != $api))) +
      [
        {
          resourceAppId: $api,
          resourceAccess: (((.requiredResourceAccess // [] | map(select(.resourceAppId == $api)) | .[0].resourceAccess) // []) + [{id: $scope, type: "Scope"}] | unique_by(.id, .type))
        }
      ]
    ) | .requiredResourceAccess' <<<"$current_app")"
  az ad app update --id "$gpt_app_id" --required-resource-accesses "$updated_required_resource_access" >/dev/null
fi

consent_status="not-attempted"
if az ad app permission admin-consent --id "$gpt_app_id" >/tmp/gpt-action-admin-consent.out 2>/tmp/gpt-action-admin-consent.err; then
  consent_status="granted-or-already-present"
else
  consent_status="manual-admin-consent-may-be-required"
fi
rm -f /tmp/gpt-action-admin-consent.out /tmp/gpt-action-admin-consent.err

new_client_secret=""
if bool_is_true "$CREATE_CLIENT_SECRET"; then
  echo "Creating a new client secret. It will be printed once; do not store it in this repo or GitHub variables."
  end_date="$(date -u -d "+${CLIENT_SECRET_YEARS} year" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+${CLIENT_SECRET_YEARS}y +%Y-%m-%dT%H:%M:%SZ)"
  secret_json="$(az ad app credential reset --id "$gpt_app_id" --append --display-name "$CLIENT_SECRET_DISPLAY_NAME" --end-date "$end_date" -o json)"
  new_client_secret="$(jq -r '.password' <<<"$secret_json")"
fi

allowed_delegated_client_ids="$gpt_app_id"
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1 && gh repo view "$REPOSITORY" >/dev/null 2>&1; then
    web_client_id="$(gh variable list --repo "$REPOSITORY" --json name,value 2>/dev/null | jq -r '.[] | select(.name == "WEB_AUTH_CLIENT_ID") | .value' || true)"
    existing_allowed="$(gh variable list --repo "$REPOSITORY" --json name,value 2>/dev/null | jq -r '.[] | select(.name == "OIDC_ALLOWED_DELEGATED_CLIENT_IDS") | .value' || true)"
    allowed_delegated_client_ids="$(printf '%s,%s,%s\n' "$existing_allowed" "$web_client_id" "$gpt_app_id" | csv_join_unique)"
  else
    echo "gh is available but not authenticated for $REPOSITORY; skipping GitHub variable discovery."
  fi
else
  echo "gh is not available; GitHub variable discovery/update is skipped."
fi

if bool_is_true "$SET_GITHUB_VARIABLES"; then
  require_cmd gh
  gh auth status >/dev/null
  gh repo view "$REPOSITORY" >/dev/null
  echo "Setting GitHub repository variables GPT_ACTION_CLIENT_ID and OIDC_ALLOWED_DELEGATED_CLIENT_IDS on $REPOSITORY."
  gh variable set GPT_ACTION_CLIENT_ID --repo "$REPOSITORY" --body "$gpt_app_id" >/dev/null
  gh variable set OIDC_ALLOWED_DELEGATED_CLIENT_IDS --repo "$REPOSITORY" --body "$allowed_delegated_client_ids" >/dev/null
else
  echo "SET_GITHUB_VARIABLES is false; not changing GitHub repository variables."
fi

if bool_is_true "$SET_AZURE_APP_SETTINGS"; then
  echo "Setting OIDC_ALLOWED_DELEGATED_CLIENT_IDS on test and production Function Apps."
  az functionapp config appsettings set --resource-group "$TEST_RESOURCE_GROUP" --name "$TEST_FUNCTION_APP" --settings "OIDC_ALLOWED_DELEGATED_CLIENT_IDS=$allowed_delegated_client_ids" >/dev/null
  az functionapp config appsettings set --resource-group "$PROD_RESOURCE_GROUP" --name "$PROD_FUNCTION_APP" --settings "OIDC_ALLOWED_DELEGATED_CLIENT_IDS=$allowed_delegated_client_ids" >/dev/null
else
  echo "SET_AZURE_APP_SETTINGS is false; not changing Azure Function App settings."
fi

cat <<MSG

GPT Builder values
------------------
Authentication type: OAuth
Client ID: $gpt_app_id
Authorization URL: $authorization_url
Token URL: $token_url
Scope: $scope_uri
Production API base URL: $PRODUCTION_API_BASE_URL
OpenAPI schema file: contracts/openapi.gpt.yaml
Registered redirect URIs: $(jq -r 'join(", ")' <<<"$requested_redirect_uris_json")
Admin consent status: $consent_status
Recommended OIDC_ALLOWED_DELEGATED_CLIENT_IDS: $allowed_delegated_client_ids
MSG

if [ -n "$new_client_secret" ]; then
  cat <<MSG

IMPORTANT: Newly created client secret. Copy it now into GPT Builder's Client Secret field.
It cannot be retrieved again. Do not commit it, save it in repo files, or put it in GitHub variables.
Client Secret: $new_client_secret
MSG
else
  cat <<MSG

Client Secret: not created by this run.
If GPT Builder needs a secret, rerun with CREATE_CLIENT_SECRET=true and copy the printed value immediately.
MSG
fi

if [ "$consent_status" != "granted-or-already-present" ]; then
  cat <<MSG

Manual admin-consent instructions
---------------------------------
If users see consent errors, an Entra admin should grant consent for the GPT Action app:
1. Azure Portal > Microsoft Entra ID > App registrations > $GPT_ACTION_APP_DISPLAY_NAME.
2. API permissions > Grant admin consent for the tenant.
3. Confirm delegated permission '$scope_uri' is listed.
MSG
fi
