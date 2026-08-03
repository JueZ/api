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

Use a dedicated confidential delegated client and exact ChatGPT callback URIs. `scripts/configure-entra-gpt-action-oauth.sh` defaults to and reconciles the exact read-only scope set `catalogue.read`, `reddit.read`, `wlh.read`, and `bring.read`, then prints it as one space-separated OAuth scope value. An `API_SCOPE_VALUES` override may only select a subset of that fixed read-only allowlist; unknown, write, and destructive scopes fail before Azure reconciliation. The GPT contract intentionally excludes all Bring mutation routes and scopes. A generated client secret is displayed once; transfer it directly to the external OAuth client and never store it in this repository or GitHub variables.

MCP uses the same API audience and per-tool permission. See `mcp-devmode.md`.

## Service identities

The repository does not include a service-identity setup, repair, rotation, or audit helper. Authenticated test smoke consumes the already configured external identity through the deployment workflow. Changes to that identity, its credentials, federation, or app-role grants require a separate privileged operator procedure and are not part of application delivery. A future dedicated `bring.read` canary requires its own reviewed identity and allowlist.

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
