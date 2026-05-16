# Service and e2e OAuth authentication

The API uses one standards-based OAuth 2.0 / OpenID Connect model for both
interactive users and trusted applications. Do not add static bearer tokens,
hardcoded JWTs, password-grant login, or an authentication bypass for deployed
test/e2e environments.

## Supported token types

| Caller | OAuth flow | Access claim | Backend allowlist |
| --- | --- | --- | --- |
| Browser / future mobile user | Authorization Code + PKCE | `scp` contains `api.access` | `OIDC_ALLOWED_OBJECT_IDS` or fallback `OIDC_ALLOWED_SUBJECTS` |
| ChatGPT Custom GPT / GPT Action | Authorization Code as a confidential web client | `scp` contains `api.access`; `azp` or `appid` identifies the GPT Action app registration | User allowlist plus `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` when configured |
| CI service tests / trusted backend app | Client credentials | `roles` contains `api.test` or `api.service` | `OIDC_ALLOWED_APP_OBJECT_IDS` or `OIDC_ALLOWED_CLIENT_IDS` |

The backend still validates issuer, audience, tenant, and required scope/role for
all protected routes. Service-client allowlists are additional checks; they do
not replace tenant or role validation.

Delegated OAuth clients and app-only service clients intentionally use separate
settings. `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` applies to delegated user tokens
from browser, mobile, or GPT Action OAuth clients. `OIDC_ALLOWED_CLIENT_IDS` and
`OIDC_ALLOWED_APP_OBJECT_IDS` apply only to app-only client-credentials tokens,
so adding a GPT Action OAuth client does not grant app-only service access.

## Recommended Entra setup

Use separate app registrations per environment when practical:

- `juez-api-catalogue-api-test`
- `juez-api-catalogue-web-test`
- `juez-api-catalogue-service-test`
- `juez-api-catalogue-api-prod`
- `juez-api-catalogue-web-prod`
- `juez-api-catalogue-gpt-action-prod` when ChatGPT / GPT Builder should call the API
- production service clients only when a production app-to-app caller is needed

The API app registration should expose:

- delegated scope `api.access` for browser/mobile users;
- application app role `api.test` for test-zone service/e2e clients;
- application app role `api.service` for production trusted application callers,
  if such callers are later required.

Grant app roles only to specific service principals. Prefer GitHub Actions OIDC
federated credentials for CI service clients instead of client secrets. A GPT
Action app registration is not a service client: configure it as a confidential
web app with the GPT Builder callback URI and the delegated `api.access`
permission, then store its client secret only in GPT Builder.

## GitHub environment variables

Set service-client values at the GitHub **environment** level, especially for the
`test` environment, so test-only clients do not become production callers by
accident:

```text
OIDC_REQUIRED_SCOPES=api.access,api.test
OIDC_ALLOWED_APP_OBJECT_IDS=<service-principal-object-id>
OIDC_ALLOWED_CLIENT_IDS=<service-client-application-id>
TEST_SERVICE_AUTH_CLIENT_ID=<service-client-application-id>
TEST_SERVICE_AUTH_TENANT_ID=<tenant-id>
TEST_SERVICE_AUTH_SCOPE=api://<api-app-client-id>/.default
```

Keep the existing user variables in place. Add the delegated client setting
when a specific OAuth client such as the GPT Action client should be required
for delegated tokens:

```text
OIDC_ALLOWED_OBJECT_IDS=<allowed-user-object-id>
OIDC_ALLOWED_SUBJECTS=<optional fallback subject ID>
OIDC_ALLOWED_DELEGATED_CLIENT_IDS=<optional GPT Action or other delegated client application ID>
OIDC_ALLOWED_TENANTS=<allowed-tenant-id>
```

If production does not need app-only callers, leave production
`OIDC_ALLOWED_APP_OBJECT_IDS` and `OIDC_ALLOWED_CLIENT_IDS` empty and keep
`OIDC_REQUIRED_SCOPES=api.access`.


## GPT Actions delegated OAuth client

GPT Actions belong in the delegated-user path, not the app-only service path.
The dedicated GPT Action app registration should request the existing
`api.access` delegated scope, and the resulting token still has to pass the
configured user allowlist (`OIDC_ALLOWED_OBJECT_IDS` or `OIDC_ALLOWED_SUBJECTS`).

Use `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` only for delegated OAuth clients. When
it is empty, any OAuth client can be used for an otherwise valid allowlisted
user token, preserving the original browser behavior. When it is non-empty, the
backend requires a delegated token to contain an `azp` or `appid` claim matching
one of the configured client/application IDs. This is the right place to pin the
ChatGPT / GPT Builder client ID after the dedicated GPT Action registration is
created.

Do not put the GPT Action client ID in `OIDC_ALLOWED_CLIENT_IDS`; that setting
is for app-only client-credentials tokens and is evaluated separately from the
GPT Action delegated flow. Do not put the GPT Action client secret in GitHub
variables, Azure app settings, project memory, PRs, chats, or logs; paste it
only into GPT Builder and rotate it immediately if it is exposed. Operational
setup steps and GPT Builder field values are documented in
`docs/setup/authentication.md` under "ChatGPT Custom GPT / GPT Actions OAuth
setup".

## Cloud Shell setup helper

Use `scripts/configure-entra-service-oauth.sh` from Azure Cloud Shell or a local
machine that has Azure CLI, GitHub CLI, `jq`, and Microsoft Graph permissions to
read/write app registrations and app-role assignments.

Example for the test environment:

```bash
cd api
export API_APP_ID='<api app registration client/application ID>'
export REPOSITORY='JueZ/api'
export GITHUB_ENVIRONMENT='test'
export SERVICE_APP_DISPLAY_NAME='JueZ API Catalogue Service Test'
export SERVICE_APP_ROLE_VALUE='api.test'
export SET_GITHUB_VARIABLES=true
./scripts/configure-entra-service-oauth.sh
```

The helper creates or reuses a service-client app registration, adds the API app
role, assigns that role to the service principal, creates a GitHub Actions
federated credential, and optionally writes the non-secret GitHub environment
variables. It creates no client secret.

## Token acquisition for service tests

A service test should request an app-only access token for the API app's
`.default` scope, then call protected endpoints with `Authorization: Bearer`.
The token itself must never be printed or stored in project memory.

For GitHub Actions, the preferred next implementation is to use the service app's
federated credential and an OIDC assertion from GitHub Actions, not a client
secret. Local manual smoke tests may use `az account get-access-token` only for a
human delegated token; that does not replace the service-client test path.
