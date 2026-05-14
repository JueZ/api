# Authentication setup for the v0 API catalogue

This project uses standards-based OAuth 2.0 / OpenID Connect with JWT bearer access tokens.
Browser and future iOS clients should use Authorization Code + PKCE. The Azure Functions
backend validates access tokens server-side and authorizes only the configured allowlisted user.

## Required app registrations

A non-destructive planning helper is available at `scripts/plan-entra-auth-apps.sh`. It prints the required Entra setup shape without creating or modifying resources.


Create two Microsoft Entra or Entra External ID app registrations:

1. **API app registration**
   - Represents the Azure Functions API.
   - Expose an API scope named `api.access`.
   - Use an Application ID URI such as `api://<api-app-client-id>`.
   - The backend `OIDC_AUDIENCE` must match the access token `aud` claim. For Microsoft
     Entra this is commonly the API Application ID URI or API client ID, depending on the
     token shape you configure and request.
2. **SPA app registration**
   - Represents the Angular frontend.
   - Platform type: Single-page application.
   - Redirect URIs:
     - Local development: `http://localhost:4200`
     - Production: the deployed frontend origin.
   - Grant delegated permission to the API scope, for example
     `api://<api-app-client-id>/api.access`.

Do not create a client secret for the SPA. Public clients must use Authorization Code + PKCE.

## Issuer URL

Use the issuer value that appears in access tokens and OpenID Connect discovery metadata.
Common Microsoft Entra issuer patterns are:

- `https://login.microsoftonline.com/<tenant-id>/v2.0`
- An Entra External ID issuer URL for your external tenant.

Set `OIDC_ISSUER` to the exact issuer expected in the access token `iss` claim. If
`OIDC_JWKS_URI` is not set, the backend discovers JWKS from:

```text
<OIDC_ISSUER>/.well-known/openid-configuration
```

## Find your user object ID

Use the Microsoft Entra admin center or Azure CLI to find the allowed user's stable object ID.
Prefer the `oid` claim over email, display name, or username.

Example Azure CLI query for your signed-in user:

```bash
az ad signed-in-user show --query id -o tsv
```

For another user, query by UPN without printing unrelated data:

```bash
az ad user show --id martin@example.com --query id -o tsv
```

## GitHub repository variables

Set these non-secret repository variables before production deployment:

```text
AUTH_ENABLED=true
OIDC_ISSUER=<issuer URL>
OIDC_AUDIENCE=<API application ID URI or API client ID expected in aud>
OIDC_REQUIRED_SCOPES=api.access
OIDC_ALLOWED_OBJECT_IDS=<your user object ID>
OIDC_ALLOWED_SUBJECTS=<optional comma-separated fallback subject IDs>
OIDC_ALLOWED_TENANTS=<optional comma-separated tenant IDs>
WEB_AUTH_ENABLED=true
WEB_AUTH_CLIENT_ID=<SPA application client ID>
WEB_AUTH_AUTHORITY=<MSAL authority URL, usually issuer without token-specific assumptions>
WEB_AUTH_REDIRECT_URI=<frontend redirect URI>
WEB_AUTH_API_SCOPE=api://<api-app-client-id>/api.access
WEB_API_BASE_URL=https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net
```

`OIDC_JWKS_URI` and `AUTH_DEBUG` are supported backend app settings but are not normally
needed as repository variables. Keep `AUTH_DEBUG=false` in production unless temporarily
troubleshooting sanitized authentication failures.

Client IDs, issuer URLs, scopes, and allowed object IDs are normally not secrets. If your
identity provider gives you a value that is secret, store it in GitHub Secrets instead and do
not print it in logs.

## Azure Function app settings

Production deployment applies the backend settings through Bicep and GitHub repository
variables. To inspect whether a setting exists without printing values, use narrow Azure CLI
queries such as:

```bash
az functionapp config appsettings list \
  --resource-group rg-api-prod \
  --name func-api-catalogue-prod-bfjstshehpbfk \
  --query "[?name=='AUTH_ENABLED' || name=='OIDC_ISSUER' || name=='OIDC_AUDIENCE' || name=='OIDC_REQUIRED_SCOPES' || name=='OIDC_ALLOWED_OBJECT_IDS'].name" \
  -o table
```

To set app settings manually, pass names and values directly without echoing tokens or secret
values:

```bash
az functionapp config appsettings set \
  --resource-group rg-api-prod \
  --name <function-app-name> \
  --settings \
    AUTH_ENABLED=true \
    OIDC_ISSUER='<issuer URL>' \
    OIDC_AUDIENCE='<audience>' \
    OIDC_REQUIRED_SCOPES='api.access' \
    OIDC_ALLOWED_OBJECT_IDS='<allowed object ID>' \
    OIDC_ALLOWED_SUBJECTS='' \
    OIDC_ALLOWED_TENANTS='' \
    AUTH_DEBUG=false \
  -o none
```

## Test token acquisition

For browser testing, open the Angular frontend, sign in with the SPA app registration, and use
**Call hello with access token**. The app uses MSAL Browser with session storage and does not
store tokens in `localStorage`.

For CLI testing, acquire an access token for the API scope with your preferred Microsoft tool.
Do not paste real bearer values into logs, issues, or commits.

```bash
az account get-access-token --scope 'api://<api-app-client-id>/api.access' --query accessToken -o tsv
```

If your tenant or app registration requires an interactive PKCE flow, use a Microsoft identity
sample app, MSAL tooling, or the frontend login flow instead of trying to embed credentials in
scripts.

## curl verification

Public health endpoint:

```bash
curl --fail --show-error --silent \
  https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net/health
```

Unauthenticated protected endpoint should return `401` when `AUTH_ENABLED=true`:

```bash
curl --show-error --silent --output - --write-out '\n%{http_code}\n' \
  https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net/api/hello
```

Authenticated protected endpoint:

```bash
API_BEARER='<paste bearer value from Authorization Code + PKCE or a safe CLI flow>'
curl --fail --show-error --silent \
  -H "Authorization: Bearer ${API_BEARER}" \
  https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net/api/hello
```

Expected success response shape:

```json
{
  "message": "Hello, Martin",
  "authenticated": true,
  "user": {
    "subject": "...",
    "objectId": "...",
    "tenantId": "..."
  }
}
```

The API never returns the full claims object.

## Future iOS clients

Future iOS clients should register as public/native clients and use Authorization Code + PKCE
with a platform-appropriate redirect URI. They should request the same API scope, send the
resulting access token as `Authorization: Bearer <token>`, and rely on the backend for all JWT,
scope/role, tenant, and allowlist enforcement.

## Low-cost architecture note

This milestone adds application code, app settings, and Microsoft Entra app registrations only.
It does not add Azure SQL, Cosmos DB, API Management, Front Door, Cognitive Services,
Kubernetes, or other paid platform services.
