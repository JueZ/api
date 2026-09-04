# Google Weather MCP setup

`weather_get_forecast` is the catalogue's single read-only weather tool. It requires the delegated or application permission `weather.read` and returns compact, normalized metric-unit data sourced from the Google Weather API. It supports current conditions, 1–72 hourly records, 1–10 daily records, or an overview (current plus both forecast ranges). It is not direct WeatherNext dataset access and does not report per-response forecast-model provenance.

## Google Cloud and deployment configuration

In a billing-enabled Google Cloud project, enable **Weather API** in Google Maps Platform and create an API key. Restrict the key to the Weather API and apply appropriate application restrictions. Store a separate value in each GitHub `test` and `production` Environment as the secret `GOOGLE_WEATHER_API_KEY`; never put it in a variable, caller argument, source file, or log. Protected delivery enables weather by default, stores that environment's secret in its environment-specific Azure Key Vault, and configures the Function App with a versioned Key Vault reference. An explicit environment variable `WEATHER_ENABLED=false` disables the provider independently for that environment; no key is then required and calls return the standard provider-disabled error.

Also add `weather.read` to `OIDC_REQUIRED_SCOPES`, expose/grant that scope in the Entra API application, consent it to the ChatGPT MCP OAuth client, and reconnect the connector if fresh consent is needed. The Google project needs billing and the Weather API enabled, as described by the [Google Weather API overview](https://developers.google.com/maps/documentation/weather/overview).

## Entra assignment commands

For a single delegated user, use the checked-in, dry-run-by-default helper. The guest UPN must be copied exactly from Entra:

```bash
USER_UPN='mkos_postat_outlook.com#EXT#@mkospostatoutlook.onmicrosoft.com' \
  ./scripts/grant-weather-user-access.sh
USER_UPN='mkos_postat_outlook.com#EXT#@mkospostatoutlook.onmicrosoft.com' APPLY=true \
  ./scripts/grant-weather-user-access.sh
```

The helper creates the missing `weather.read` delegated scope when necessary and grants only that user a `Principal` consent for the configured ChatGPT OAuth client. Future users can be added by rerunning it with their exact Entra UPN. It does not assign a service-only role to a human user.

If an administrator explicitly wants the automation identity to maintain these assignments later, first review and run the separate bootstrap helper. This is a tenant-wide privileged grant and must not be applied to the runtime Function identity:

```bash
AUTOMATION_APP_ID='<Codex automation application client ID>' ./scripts/grant-entra-bootstrap-rights.sh
AUTOMATION_APP_ID='<Codex automation application client ID>' APPLY=true \
  ./scripts/grant-entra-bootstrap-rights.sh
```

The bootstrap helper grants exactly Microsoft Graph `Application.Read.All`, `AppRoleAssignment.ReadWrite.All`, and `DelegatedPermissionGrant.ReadWrite.All`. A Privileged Role Administrator must execute the initial grant; no script can legitimately self-elevate around that Entra boundary. Revoke these roles when ongoing autonomous Entra maintenance is not intended.

The production/test smoke identity is an application, so assign the service-only `weather.service.read` app role to its **enterprise application service principal**. `az role assignment create` is not applicable because that command manages Azure RBAC, not Microsoft Graph app roles. Run the following while signed in as a tenant administrator whose Azure CLI token has Microsoft Graph `AppRoleAssignment.ReadWrite.All` and `Application.Read.All`:

```bash
API_APP_ID='<API application client ID>'
SMOKE_APP_ID='<deployment smoke application client ID>'

RESOURCE_SP_ID="$(az ad sp show --id "$API_APP_ID" --query id --output tsv)"
SMOKE_SP_ID="$(az ad sp show --id "$SMOKE_APP_ID" --query id --output tsv)"
WEATHER_ROLE_ID="$(az ad app show --id "$API_APP_ID" \
  --query "appRoles[?value=='weather.service.read' && isEnabled].id | [0]" \
  --output tsv)"

test -n "$RESOURCE_SP_ID" && test -n "$SMOKE_SP_ID" && test -n "$WEATHER_ROLE_ID"
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${SMOKE_SP_ID}/appRoleAssignments" \
  --headers Content-Type=application/json \
  --body "{\"principalId\":\"${SMOKE_SP_ID}\",\"resourceId\":\"${RESOURCE_SP_ID}\",\"appRoleId\":\"${WEATHER_ROLE_ID}\"}" \
  --output none

az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${SMOKE_SP_ID}/appRoleAssignments" \
  --query "value[?resourceId=='${RESOURCE_SP_ID}' && appRoleId=='${WEATHER_ROLE_ID}'].{resourceId:resourceId,appRoleId:appRoleId}" \
  --output table
```

Entra does not support assigning an application role to a synthetic “all users” principal. For all tenant users of the ChatGPT OAuth client, use tenant-wide delegated admin consent for the canonical `weather.read` scope instead. The safe sequence below preserves scopes on an existing grant rather than replacing them. It requires Microsoft Graph `DelegatedPermissionGrant.ReadWrite.All` and `Application.Read.All`:

```bash
API_APP_ID='<API application client ID>'
CHATGPT_APP_ID='<ChatGPT OAuth client application ID>'

RESOURCE_SP_ID="$(az ad sp show --id "$API_APP_ID" --query id --output tsv)"
CHATGPT_SP_ID="$(az ad sp show --id "$CHATGPT_APP_ID" --query id --output tsv)"
GRANT_ID="$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId%20eq%20'${CHATGPT_SP_ID}'%20and%20resourceId%20eq%20'${RESOURCE_SP_ID}'%20and%20consentType%20eq%20'AllPrincipals'" \
  --query 'value[0].id' --output tsv)"

if [ -n "$GRANT_ID" ]; then
  EXISTING_SCOPES="$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${GRANT_ID}" \
    --query scope --output tsv)"
  MERGED_SCOPES="$(printf '%s\nweather.read\n' "$EXISTING_SCOPES" \
    | tr ' ' '\n' | sed '/^$/d' | sort -u | paste -sd' ' -)"
  az rest --method PATCH \
    --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${GRANT_ID}" \
    --headers Content-Type=application/json \
    --body "$(jq -cn --arg scope "$MERGED_SCOPES" '{scope:$scope}')" \
    --output none
else
  az rest --method POST \
    --url 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' \
    --headers Content-Type=application/json \
    --body "$(jq -cn \
      --arg clientId "$CHATGPT_SP_ID" \
      --arg resourceId "$RESOURCE_SP_ID" \
      '{clientId:$clientId,consentType:"AllPrincipals",resourceId:$resourceId,scope:"weather.read"}')" \
    --output none
fi

az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId%20eq%20'${CHATGPT_SP_ID}'%20and%20resourceId%20eq%20'${RESOURCE_SP_ID}'%20and%20consentType%20eq%20'AllPrincipals'" \
  --query 'value[].{consentType:consentType,scope:scope}' \
  --output table
```

These are tenant-wide identity changes, so test the exact smoke identity and ChatGPT client IDs before running them. A `403 Authorization_RequestDenied` means the signed-in operator lacks the required Microsoft Graph permission or tenant-admin consent; subscription `Owner` or resource-group permissions do not grant it. After assignment, mint a new token because existing access tokens do not gain newly assigned roles or scopes.

## Location and locale

Explicit `latitude` and `longitude` must be supplied together, are range checked, and override ChatGPT metadata. When they are omitted, the tool best-effort reads optional, untrusted `_meta["openai/userLocation"]` coordinates. City, region, country, and timezone are descriptive only; they are never used for authorization or geocoding. ChatGPT location can be coarse. If neither source contains usable coordinates, the tool tells ChatGPT to ask for a location/coordinates or enable location sharing and never to guess. `_meta["openai/locale"]` supplies `languageCode` only when the caller did not specify one.

Examples: “What is the weather here?”, “Will it rain here tomorrow afternoon?”, and “What is the weather here this weekend?” Hour-specific questions should use `hourly`; multi-day questions should use `daily`; `overview` is for requests needing both.

## Local verification

Set `DEPLOYED_ENVIRONMENT_NAME=local`, `WEATHER_ENABLED=true`, and a local secret `GOOGLE_WEATHER_API_KEY` only when manually exercising the provider. Automated tests inject `fetch` and never contact Google:

```bash
npm run test:api
npm run ops:check-operation-drift
npm run docs:check-operations
```
