#!/usr/bin/env bash
set -euo pipefail

# Read-only verification for the one existing test service OAuth identity.
# This helper deliberately performs no Entra, GitHub, credential, role, or
# federation mutation. Identity repair requires a separately reviewed operator
# procedure; this script only proves that the deployed test tuple still matches
# the checked-in public identifiers and least-privilege grants.

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command az
require_command grep
require_command jq
require_command sort

approved_repository='JueZ/api'
approved_github_environment='test'
approved_github_job_workflow_ref='JueZ/api/.github/workflows/deploy-environment.yml@refs/heads/main'
approved_tenant_id='7ac3dfd6-e810-4693-805a-9535eb3ab166'
approved_service_client_id='2a5dd0fe-eb6f-41ab-ba48-6542645c508f'
approved_service_principal_object_id='6519c92f-2dbc-43d1-9396-1f2d9e766357'
approved_service_display_name='JueZ API Catalogue Service Test'
approved_credential_name='github-test-service-tests'
approved_credential_issuer='https://token.actions.githubusercontent.com'
approved_credential_audience='api://AzureADTokenExchange'
approved_credential_subject='repo:JueZ/api:environment:test:job_workflow_ref:JueZ/api/.github/workflows/deploy-environment.yml@refs/heads/main'
approved_role_values=('catalogue.read' 'reddit.read')

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contract_path="$script_dir/../contracts/openapi.gpt.yaml"
mapfile -t contract_api_identifiers < <(
  grep -oE 'api://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' "$contract_path" |
    sort -u
)
if [ "${#contract_api_identifiers[@]}" -ne 1 ]; then
  echo 'The canonical GPT Actions contract must contain one unique Entra API identifier.' >&2
  exit 1
fi
approved_api_identifier_uri="${contract_api_identifiers[0]}"
approved_api_client_id="${approved_api_identifier_uri#api://}"

repository="${REPOSITORY:-$approved_repository}"
github_environment="${GITHUB_ENVIRONMENT:-$approved_github_environment}"
github_job_workflow_ref="${GITHUB_JOB_WORKFLOW_REF:-$approved_github_job_workflow_ref}"

assert_optional_exact() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    echo "$name does not match the checked-in test identity." >&2
    exit 1
  fi
}

assert_optional_exact REPOSITORY "$repository" "$approved_repository"
assert_optional_exact GITHUB_ENVIRONMENT "$github_environment" "$approved_github_environment"
assert_optional_exact GITHUB_JOB_WORKFLOW_REF "$github_job_workflow_ref" "$approved_github_job_workflow_ref"
assert_optional_exact API_APP_ID "${API_APP_ID:-}" "$approved_api_client_id"
assert_optional_exact SERVICE_APP_CLIENT_ID "${SERVICE_APP_CLIENT_ID:-}" "$approved_service_client_id"
assert_optional_exact TENANT_ID "${TENANT_ID:-}" "$approved_tenant_id"

if [ "${SET_GITHUB_VARIABLES:-false}" != "false" ]; then
  echo 'SET_GITHUB_VARIABLES is unsupported: this verifier never mutates GitHub configuration.' >&2
  exit 1
fi
if [ -n "${SERVICE_APP_ROLE_VALUES:-${SERVICE_APP_ROLE_VALUE:-}}" ]; then
  echo 'Service roles are fixed to catalogue.read and reddit.read and cannot be overridden.' >&2
  exit 1
fi

account_tenant_id="$(az account show --query tenantId -o tsv)"
if [ "$account_tenant_id" != "$approved_tenant_id" ]; then
  echo 'The active Azure tenant does not match the checked-in test tenant.' >&2
  exit 1
fi

# The pinned tenant/client pairs are the immutable application authorities.
# Directory object IDs are resolved only after those checks and are never used
# to select a different identity or to authorize a mutation.
api_app_json="$(az ad app show --id "$approved_api_client_id" --query '{appId:appId,id:id,identifierUris:identifierUris,appRoles:appRoles}' -o json)"
if ! jq -e \
  --arg client_id "$approved_api_client_id" \
  --arg identifier_uri "$approved_api_identifier_uri" \
  '.appId == $client_id and (.id | type == "string" and length > 0) and (.identifierUris | index($identifier_uri) != null)' \
  <<<"$api_app_json" >/dev/null; then
  echo 'The API application does not match the checked-in tenant/client/identifier tuple.' >&2
  exit 1
fi
api_app_object_id="$(jq -r '.id' <<<"$api_app_json")"

api_sp_json="$(az ad sp show --id "$approved_api_client_id" --query '{appId:appId,id:id}' -o json)"
if ! jq -e --arg client_id "$approved_api_client_id" '.appId == $client_id and (.id | type == "string" and length > 0)' <<<"$api_sp_json" >/dev/null; then
  echo 'The API service principal does not match the checked-in API client.' >&2
  exit 1
fi
api_sp_object_id="$(jq -r '.id' <<<"$api_sp_json")"

service_app_json="$(az ad app show --id "$approved_service_client_id" --query '{appId:appId,id:id,displayName:displayName}' -o json)"
if ! jq -e \
  --arg client_id "$approved_service_client_id" \
  --arg display_name "$approved_service_display_name" \
  '.appId == $client_id and .displayName == $display_name and (.id | type == "string" and length > 0)' \
  <<<"$service_app_json" >/dev/null; then
  echo 'The service application does not match the checked-in test client and display name.' >&2
  exit 1
fi
service_app_object_id="$(jq -r '.id' <<<"$service_app_json")"

service_sp_json="$(az ad sp show --id "$approved_service_client_id" --query '{appId:appId,id:id}' -o json)"
if ! jq -e \
  --arg client_id "$approved_service_client_id" \
  --arg object_id "$approved_service_principal_object_id" \
  '.appId == $client_id and .id == $object_id' \
  <<<"$service_sp_json" >/dev/null; then
  echo 'The service principal does not match the checked-in client/object pair.' >&2
  exit 1
fi

credentials_json="$(az ad app federated-credential list --id "$service_app_object_id" -o json)"
credential_matches="$(jq \
  --arg name "$approved_credential_name" \
  '[.[] | select(.name == $name)] | length' \
  <<<"$credentials_json")"
if [ "$credential_matches" != '1' ] || ! jq -e \
  --arg name "$approved_credential_name" \
  --arg issuer "$approved_credential_issuer" \
  --arg subject "$approved_credential_subject" \
  --arg audience "$approved_credential_audience" \
  '[.[] | select(.name == $name)] | first | .issuer == $issuer and .subject == $subject and .audiences == [$audience]' \
  <<<"$credentials_json" >/dev/null; then
  echo 'The existing test federated credential is missing, ambiguous, or not bound to the approved main workflow.' >&2
  exit 1
fi

api_roles="$(jq -c '.appRoles' <<<"$api_app_json")"
assignments="$(az rest \
  --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$approved_service_principal_object_id/appRoleAssignments" \
  --query value \
  -o json)"
for role_value in "${approved_role_values[@]}"; do
  role_ids="$(jq -c \
    --arg value "$role_value" \
    '[.[] | select(.value == $value and (.isEnabled // true) and (.allowedMemberTypes | index("Application") != null)) | .id]' \
    <<<"$api_roles")"
  if [ "$(jq 'length' <<<"$role_ids")" != '1' ]; then
    echo "Expected exactly one enabled application role for $role_value." >&2
    exit 1
  fi
  role_id="$(jq -r '.[0]' <<<"$role_ids")"
  assignment_count="$(jq \
    --arg principal_id "$approved_service_principal_object_id" \
    --arg resource_id "$api_sp_object_id" \
    --arg role_id "$role_id" \
    '[.[] | select(.principalId == $principal_id and .resourceId == $resource_id and .appRoleId == $role_id)] | length' \
    <<<"$assignments")"
  if [ "$assignment_count" != '1' ]; then
    echo "Expected exactly one existing $role_value assignment for the approved service principal." >&2
    exit 1
  fi
done

printf '%s\n' \
  'Verified the existing test service OAuth identity without mutation.' \
  "Tenant: $approved_tenant_id" \
  "API client: $approved_api_client_id" \
  "API app object: $api_app_object_id" \
  "API service principal: $api_sp_object_id" \
  "Service client: $approved_service_client_id" \
  "Service app object: $service_app_object_id" \
  "Service principal: $approved_service_principal_object_id" \
  "Federated credential: $approved_credential_name" \
  'Roles: catalogue.read,reddit.read'
