# Authentication setup

This is an operator bootstrap procedure. Do not run it from an untrusted branch and do not print token/secret values.

## Entra API app

Configure the API Application ID URI used by `OIDC_AUDIENCE`. Expose delegated scopes and, where app-only access is needed, application roles:

```text
catalogue.read
reddit.read
wlh.read
bring.read
bring.write
bring.complete
bring.remove
```

Do not recreate `api.access`. Do not assign `bring.complete` or `bring.remove` to application/service principals.

Configure exact issuer(s), tenant(s), user object/subject allowlists, delegated client allowlists, and service client/object allowlists. Keep debug logging disabled outside controlled diagnosis.

## Browser client

Register the Angular client as a SPA with exact local/test/production redirect origins. Grant only the delegated scopes it needs. Set:

```text
WEB_AUTH_ENABLED=true
WEB_AUTH_CLIENT_ID=<spa-client-id>
WEB_AUTH_AUTHORITY=https://login.microsoftonline.com/<tenant>
WEB_AUTH_REDIRECT_URI=<exact production origin>
WEB_AUTH_API_SCOPE=api://<api-app-id>/catalogue.read
```

The catalogue derives other operation scope URIs from that resource prefix and the OpenAPI operation security declaration.

## GPT Action and MCP

Use a dedicated confidential delegated client and exact ChatGPT callback URIs. `scripts/configure-entra-gpt-action-oauth.sh` verifies and grants all configured granular scopes and prints them as one space-separated OAuth scope value. A generated client secret is displayed once; transfer it directly to the external OAuth client and never store it in this repository or GitHub variables.

MCP uses the same API audience and per-tool permission. See `mcp-devmode.md`.

## Service identities

Use `scripts/configure-entra-service-oauth.sh` with GitHub Environment federation. Default smoke roles are `catalogue.read,reddit.read`. Create a separate test canary identity with `bring.read` only. Each identity needs exact `OIDC_ALLOWED_APP_OBJECT_IDS`/`OIDC_ALLOWED_CLIENT_IDS`.

The token-mint step validates these expected application roles from the short-lived Entra token before exposing it to smoke tests. It emits only missing role names, never the token or full claims. A missing-role failure is an Entra app-role assignment/configuration problem: rerun the configuration script under an operator with Microsoft Graph application-management permission, then start a new first-attempt test deployment. Do not work around it by accepting retired roles or weakening an operation policy.

## Repository/runtime variables

Set non-secret values through repository/environment variables and secrets through the deployment/Key Vault path. At minimum:

```text
AUTH_ENABLED=true
OIDC_ISSUER=<exact issuer list>
OIDC_AUDIENCE=api://<api-app-id>
OIDC_REQUIRED_SCOPES=catalogue.read,reddit.read,wlh.read,bring.read,bring.write,bring.complete,bring.remove
OIDC_ALLOWED_OBJECT_IDS=<operator object id>
OIDC_ALLOWED_TENANTS=<allowed tenant ids>
OIDC_ALLOWED_DELEGATED_CLIENT_IDS=<spa,gpt client ids>
```

Run `scripts/check-auth-config.sh` using only safely sourced configuration. It validates names/granular scope shape without printing values.

After deployment, verify missing/invalid tokens return 401, valid-but-underprivileged tokens return 403, each operation accepts only its permission, service tokens cannot perform destructive Bring actions, and MCP challenges advertise the fully qualified missing scope.
