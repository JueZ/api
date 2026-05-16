# Authentication setup for the v0 API catalogue

This project uses standards-based OAuth 2.0 / OpenID Connect with JWT bearer access tokens.
Browser and future iOS clients should use Authorization Code + PKCE. The Azure Functions
backend validates access tokens server-side and authorizes only the configured allowlisted user.

## Current production status

As of the 2026-05-14 consolidation, the authentication implementation is merged to
`main`, and GitHub auth-related repository variables are present. Production has
not yet been verified as auth-enabled: unauthenticated `GET /api/hello` at the
production API URL still returned the pre-auth public placeholder response. Treat
the commands below as setup/verification for the next staged test deployment and
production promotion; do not deploy production outside the guarded workflows.


## Required app registrations

A non-destructive planning helper is available at `scripts/plan-entra-auth-apps.sh`. It prints the required Entra setup shape without creating or modifying resources.


Create at least two Microsoft Entra or Entra External ID app registrations for browser auth, and add a third service-client registration when app-only tests or integrations need API access:

Add a fourth delegated confidential-client registration when a ChatGPT Custom GPT / GPT Action needs to call the protected API. This GPT Action app registration represents ChatGPT / GPT Builder as a delegated web client, uses Authorization Code against the same `api.access` API scope, and must have the exact GPT Builder OAuth callback URL registered as a web redirect URI. Once validated, list the GPT Action client/application ID in `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` so only the dedicated GPT OAuth client can present delegated tokens for this integration.

1. **API app registration**
   - Represents the Azure Functions API.
   - Expose a delegated API scope named `api.access`.
   - Expose application app roles for app-only callers, for example `api.test` for test/e2e clients and `api.service` for trusted backend applications.
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

3. **Service/e2e app registration**
   - Represents non-browser callers such as CI service tests or trusted backend applications.
   - Uses OAuth 2.0 client credentials. Prefer a GitHub Actions OIDC federated credential over a client secret.
   - Is assigned an API app role such as `api.test` or `api.service`; app-only tokens should carry the role in the `roles` claim.

Do not create a client secret for the SPA. Public clients must use Authorization Code + PKCE. GPT Actions use a confidential web-client secret that belongs only in GPT Builder and must be rotated if exposed. Avoid static bearer tokens, Resource Owner Password Credentials, or disabling auth in the deployed test zone. The security details for delegated, app-only, and GPT Action OAuth callers live in `docs/security/service-oauth-authentication.md`.

## Issuer URL

Use the issuer value that appears in access tokens and OpenID Connect discovery metadata.
Common Microsoft Entra issuer patterns are:

- `https://login.microsoftonline.com/<tenant-id>/v2.0`
- An Entra External ID issuer URL for your external tenant.

Set `OIDC_ISSUER` to the exact issuer expected in the access token `iss` claim.
If the app supports both an organization tenant and a personal Microsoft account, set
`OIDC_ISSUER` to a comma-separated list of exact accepted issuers and keep
`OIDC_ALLOWED_TENANTS` and `OIDC_ALLOWED_OBJECT_IDS` scoped to the explicitly allowed
tenant/user IDs. If `OIDC_JWKS_URI` is not set, the backend uses OpenID discovery for
each configured issuer and verifies each token against the matching exact issuer/JWKS
pair:

```text
<each OIDC_ISSUER entry>/.well-known/openid-configuration
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

Set these non-secret repository variables before staged test and production deployment. The
`Deploy Environment` reusable workflow intentionally uses the same backend OIDC issuer,
audience, required scope, tenant filter, and user allowlist for `test` and `prod` so the test
environment validates the same tokens and protects the same routes before promotion.

```text
AUTH_ENABLED=true
OIDC_ISSUER=<issuer URL or comma-separated issuer URLs>
OIDC_AUDIENCE=<API application ID URI or API client ID expected in aud>
OIDC_REQUIRED_SCOPES=api.access
OIDC_ALLOWED_OBJECT_IDS=<your user object ID>
OIDC_ALLOWED_SUBJECTS=<optional comma-separated fallback subject IDs>
OIDC_ALLOWED_APP_OBJECT_IDS=<optional comma-separated service-principal object IDs for app-only tokens>
OIDC_ALLOWED_CLIENT_IDS=<optional comma-separated service-client/application IDs for app-only tokens>
OIDC_ALLOWED_DELEGATED_CLIENT_IDS=<optional comma-separated delegated client/application IDs, for example the GPT Action client ID>
OIDC_ALLOWED_TENANTS=<comma-separated tenant IDs>
WEB_AUTH_ENABLED=true
WEB_AUTH_CLIENT_ID=<SPA application client ID>
WEB_AUTH_AUTHORITY=<MSAL authority URL, usually issuer without token-specific assumptions>
WEB_AUTH_REDIRECT_URI=<production frontend redirect URI>
WEB_AUTH_API_SCOPE=api://<api-app-client-id>/api.access
WEB_API_BASE_URL=https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net
TEST_WEB_AUTH_REDIRECT_URI=<optional test frontend redirect URI override>
TEST_WEB_API_BASE_URL=<optional test API base URL override>
```

For the test frontend, omit `TEST_WEB_AUTH_REDIRECT_URI` unless the same SPA app registration
needs a fixed redirect value; when omitted, the Angular app uses the deployed test frontend
origin at runtime. If you provide it, add that exact URI to the same SPA app registration that
production uses. `TEST_WEB_API_BASE_URL` is normally omitted so the test frontend calls the
Function App discovered during the test deployment instead of the production API.

For test-zone app-only service tests, set `OIDC_REQUIRED_SCOPES=api.access,api.test` as an environment-level variable for the GitHub `test` environment and set the service allowlists there. Leave production service allowlists empty unless production app-to-app access is intentionally required.

`OIDC_JWKS_URI` and `AUTH_DEBUG` are supported backend app settings but are not normally
needed as repository variables. Keep `AUTH_DEBUG=false` in production unless temporarily
troubleshooting sanitized authentication failures.

Client IDs, issuer URLs, scopes, and allowed object IDs are normally not secrets. If your
identity provider gives you a value that is secret, store it in GitHub Secrets instead and do
not print it in logs.

## Azure Function app settings

Staged test and production deployments apply the backend settings through Bicep and GitHub
repository variables. To inspect whether a setting exists without printing values, use narrow
Azure CLI queries such as:

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
    OIDC_ALLOWED_APP_OBJECT_IDS='' \
    OIDC_ALLOWED_CLIENT_IDS='' \
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

## ChatGPT Custom GPT / GPT Actions OAuth setup

A ChatGPT Custom GPT must use its own Microsoft Entra app registration. Do **not** reuse the Angular SPA app registration as the GPT Action OAuth client. The GPT authenticates to this API with the existing delegated API scope; the backend then calls Reddit with backend-only Reddit OAuth credentials.

Current non-secret values discovered from repository variables on 2026-05-15:

- API application/client ID: read from the non-secret `WEB_AUTH_API_SCOPE` / `OIDC_AUDIENCE` repository variables.
- API Application ID URI / audience: read from `OIDC_AUDIENCE`.
- Delegated API scope: read from `WEB_AUTH_API_SCOPE`; it should end with `/api.access`.
- Primary tenant for the GPT Action OAuth URLs: read from `AZURE_TENANT_ID` / `WEB_AUTH_AUTHORITY`.
- Existing Angular SPA client ID: read from `WEB_AUTH_CLIENT_ID`.
- Production API base URL: `https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net`
- GPT-specific OpenAPI schema: `contracts/openapi.gpt.yaml`

The API supports an optional delegated OAuth client allowlist with `OIDC_ALLOWED_DELEGATED_CLIENT_IDS`. Leave it empty to preserve the previous behavior. When it is non-empty, user/delegated tokens must include `azp` or `appid` matching one of the configured client application IDs, while the existing user object ID / subject allowlist still applies. App-only tokens continue to use `OIDC_ALLOWED_APP_OBJECT_IDS` and `OIDC_ALLOWED_CLIENT_IDS`.

After the dedicated GPT Action app registration is working, set `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` to the GPT Action client/application ID. See `docs/security/service-oauth-authentication.md` for the security model and when to use each allowlist.

### Cloud Shell helper

Run the helper from Azure Cloud Shell after GPT Builder shows the OAuth callback / redirect URI:

```bash
export API_APP_ID='<paste API app client ID from WEB_AUTH_API_SCOPE or OIDC_AUDIENCE>'
export GPT_ACTION_REDIRECT_URI='<paste GPT Builder OAuth callback URL here>'
# Optional: add comma-separated extra callbacks. The helper automatically registers
# both chat.openai.com and chatgpt.com variants when GPT_ACTION_REDIRECT_URI uses
# either standard ChatGPT Actions callback host.
export GPT_ACTION_ADDITIONAL_REDIRECT_URIS=''
export SET_GITHUB_VARIABLES=false
export SET_AZURE_APP_SETTINGS=false
export CREATE_CLIENT_SECRET=false
./scripts/configure-entra-gpt-action-oauth.sh
```

To apply configuration after reviewing the output, rerun with:

```bash
export SET_GITHUB_VARIABLES=true
export SET_AZURE_APP_SETTINGS=true
export CREATE_CLIENT_SECRET=true
./scripts/configure-entra-gpt-action-oauth.sh
```

If a generated GPT Action client secret is copied into chat, logs, shell history, or any other place outside GPT Builder, treat it as exposed and rotate it. The helper can delete previous GPT Action client secret credentials with the default display name before creating a replacement:

```bash
export DELETE_EXISTING_CLIENT_SECRETS=true
export DELETE_CLIENT_SECRET_DISPLAY_NAME='ChatGPT Action OAuth secret'
export CREATE_CLIENT_SECRET=true
./scripts/configure-entra-gpt-action-oauth.sh
```

After rotation, paste only the newly printed secret into GPT Builder and remove the old value from any non-secure location where it was copied. Client secret values cannot be retrieved later; only credential metadata such as display name and key ID can be listed.

The script creates or reuses a confidential web app registration named `JueZ API Catalogue ChatGPT Action`, adds the GPT Builder redirect URI (including the alternate `chat.openai.com` / `chatgpt.com` callback host when applicable), verifies the API app exposes `api.access`, adds the delegated API permission, attempts admin consent when permissions allow it, and prints the Client ID, OAuth URLs, scope, production API URL, and OpenAPI schema path for GPT Builder. If a new client secret is created, it is printed once and must be pasted directly into GPT Builder; do not commit it, store it in GitHub variables, paste it into chats, or leave it in terminal logs.

### GPT Builder values

- Authentication type: OAuth
- Client ID: the ChatGPT Action app registration client ID printed by the helper
- Client Secret: the one-time secret printed only when `CREATE_CLIENT_SECRET=true`
- Authorization URL: `https://login.microsoftonline.com/7ac3dfd6-e810-4693-805a-9535eb3ab166/oauth2/v2.0/authorize`
- Token URL: `https://login.microsoftonline.com/7ac3dfd6-e810-4693-805a-9535eb3ab166/oauth2/v2.0/token`
- Scope: `api://97df847a-3e44-4aa7-82ea-557f3dfe0203/api.access`
- OpenAPI schema: paste or upload `contracts/openapi.gpt.yaml`

Test the GPT Action first with `GET /api/hello`, then with `POST /api/reddit/thread`. Example Reddit request:

```json
{
  "post": "https://www.reddit.com/r/redditdev/comments/abc123/example/",
  "sort": "confidence",
  "maxComments": 100
}
```

### Troubleshooting GPT Actions

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| GPT OAuth login fails | Redirect URI mismatch, wrong tenant, or app not configured as a confidential web client. | Copy the exact GPT Builder callback URL into `GPT_ACTION_REDIRECT_URI` and rerun the helper. The helper registers the alternate `chat.openai.com` / `chatgpt.com` callback host when the URL has a standard GPT Actions callback shape. |
| Token endpoint fails | Missing/expired/exposed client secret, wrong Client ID, or wrong token URL tenant. | Create a fresh client secret with the helper, rotate old helper-created secrets with `DELETE_EXISTING_CLIENT_SECRETS=true` when needed, and verify the GPT Builder OAuth fields. |
| API returns `401` | Missing/invalid token, wrong audience, wrong issuer, or signature validation failure. | Confirm GPT Builder uses the `api://97df847a-3e44-4aa7-82ea-557f3dfe0203/api.access` scope and the production schema server. |
| API returns `403` | Scope, tenant, user allowlist, service allowlist, or delegated client allowlist rejected the token. | Confirm `OIDC_ALLOWED_OBJECT_IDS` / `OIDC_ALLOWED_SUBJECTS` includes the user and `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` includes the GPT Action client ID when configured. |
| Reddit endpoint returns `502` | Reddit upstream call failed or credentials/user-agent are not configured correctly. | Verify backend-only `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT` in Function App settings without printing secret values. |
| Reddit endpoint returns `429` | Reddit throttled the backend. | Reduce call frequency or `maxComments`; retry later. |
| GPT Action importer rejects schema | Schema too large or unsupported constructs. | Use the minimal GPT-specific schema in `contracts/openapi.gpt.yaml`, not the full catalogue schema. |
