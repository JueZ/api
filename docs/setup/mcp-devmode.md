# Private ChatGPT Developer Mode MCP gateway

This repo now exposes a private Model Context Protocol (MCP) gateway in addition to the existing Azure Functions REST API, GPT Actions OpenAPI contracts, Angular app, authentication system, and deployment flow. The MCP interface is intended for personal ChatGPT Developer Mode connector use only; it is not a public ChatGPT App submission and does not include a UI widget.

## Implemented endpoints

- `POST /mcp`, `GET /mcp`, `DELETE /mcp`, `OPTIONS /mcp` — Streamable HTTP MCP endpoint hosted by the existing Azure Functions app.
- `GET /.well-known/oauth-protected-resource` — OAuth protected-resource metadata generated from safe environment values.

The gateway uses the official TypeScript MCP SDK with the Web Standards Streamable HTTP transport so it can run inside Azure Functions without a separate `apps/mcp` package.

## MCP tools

All tools are read-only. `health_check` is intentionally public and returns only safe health/build metadata. Every API-backed tool requires the same Microsoft Entra OAuth/OIDC bearer token validation used by the REST API.

| Tool | Auth | Purpose |
| --- | --- | --- |
| `health_check` | No auth | Check that the MCP gateway/API catalogue is reachable. |
| `hello_authenticated` | OAuth | Verify ChatGPT OAuth linking and return the same safe user shape as `GET /api/hello`. |
| `reddit_get_thread` | OAuth | Fetch a Reddit thread snapshot using the existing Reddit service. |
| `reddit_get_thread_overview` | OAuth | Fetch the compact Reddit thread overview using the existing service. |
| `wlh_search` | OAuth | Search Willhaben/WLH offers using the existing WLH service. |
| `wlh_get_offer` | OAuth | Fetch one WLH offer/detail using the existing WLH service. |
| `wlh_categories_top` | OAuth | List top-level WLH categories. |
| `wlh_category_children` | OAuth | List child categories for a WLH category. |

## Local testing

Use Node.js 22.

```bash
npm install
npm run build:api
npm run test:api
npm run type-check
```

A minimal local MCP initialize request after starting the Functions host should include both accepted response media types:

```bash
curl -sS http://localhost:7071/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"local-test","version":"1"}}}'
```

When `AUTH_ENABLED=true`, protected tool calls require a valid bearer token and fail closed when missing or invalid. Do not paste tokens into logs, docs, or issue comments.

## Exposing local `/mcp` to ChatGPT Developer Mode

ChatGPT Developer Mode requires an HTTPS public connector URL. For local development, expose the Functions host through a secure HTTPS tunnel such as your approved dev tunnel provider, then point ChatGPT at:

```text
https://<public-host>/mcp
```

This repo's `apps/api/host.json` sets `extensions.http.routePrefix` to an empty string, so the Azure Functions route is exposed as `/mcp` rather than `/api/mcp`.

Do not use hidden URLs, shared static bearer tokens, API keys, or unauthenticated private-data endpoints as a substitute for OAuth.

## ChatGPT Developer Mode setup

1. In ChatGPT, open **Settings -> Apps & Connectors -> Advanced settings -> Developer Mode**.
2. Create a connector.
3. Set the connector URL to the public HTTPS MCP endpoint, for example:
   - local tunnel: `https://<public-host>/mcp`
   - deployed Functions/custom domain: `https://<deployed-host>/mcp`.
4. Complete OAuth linking when prompted.

## Microsoft Entra compatibility notes

The MCP gateway preserves the existing Microsoft Entra OAuth/OIDC model. Before relying on ChatGPT linking in a tenant, verify these Entra setup points:

- OIDC discovery is reachable for `OIDC_ISSUER`.
- Authorization Code + PKCE is supported by the Entra app registration used for ChatGPT Developer Mode.
- The redirect URI shown by ChatGPT Developer Mode is added to the Entra app registration.
- The exposed API Application ID URI/audience matches `OIDC_AUDIENCE`; the protected-resource metadata `resource` value must be this audience, not the MCP host origin.
- The delegated scope exposed by Entra is `<OIDC_AUDIENCE>/api.access`; issued access tokens should contain the short `scp` claim `api.access`, matching `OIDC_REQUIRED_SCOPES`.
- `OIDC_ALLOWED_DELEGATED_CLIENT_IDS` includes the ChatGPT/connector delegated client ID when that allowlist is configured.
- User allowlists (`OIDC_ALLOWED_OBJECT_IDS` or `OIDC_ALLOWED_SUBJECTS`) still include the intended operator.
- `authorizeRequest`/`authorizeBearerToken` can validate the resulting token issuer, audience, scope/role, tenant, user, and delegated client.

If ChatGPT Developer Mode presents a redirect URI or client behavior that the current Entra app registration cannot support, do not weaken security. Keep tools protected and update this document with the exact blocker and the safest local/dev-only workaround.

## Required environment variables

Existing auth variables are reused:

```text
AUTH_ENABLED=true
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_AUDIENCE=api://<application-id-or-application-id-uri>  # OAuth resource / token audience / Entra Application ID URI
OIDC_REQUIRED_SCOPES=api.access
OIDC_ALLOWED_OBJECT_IDS=<allowed-user-object-id>
OIDC_ALLOWED_SUBJECTS=<optional-subject-allowlist>
OIDC_ALLOWED_APP_OBJECT_IDS=<optional-service-app-object-id-allowlist>
OIDC_ALLOWED_CLIENT_IDS=<optional-service-client-id-allowlist>
OIDC_ALLOWED_DELEGATED_CLIENT_IDS=<optional-delegated-client-id-allowlist>
OIDC_ALLOWED_TENANTS=<optional-tenant-allowlist>
```

MCP-specific safe settings:

```text
MCP_RESOURCE_ORIGIN=https://<deployed-function-app-or-custom-domain>  # Public HTTPS MCP origin used to build resource_metadata URLs
MCP_RESOURCE_DOCUMENTATION_URL=https://<optional-docs-url>
MCP_OAUTH_SCOPE=<optional-full-oauth-scope-override>
```

`OIDC_AUDIENCE` is the OAuth resource, token audience, and Microsoft Entra Application ID URI, for example `api://97df847a-3e44-4aa7-82ea-557f3dfe0203`. The protected-resource metadata endpoint returns this value as `resource` so Entra can match the requested scope prefix.

The MCP gateway advertises the OAuth request scope as `<OIDC_AUDIENCE>/api.access` when `OIDC_AUDIENCE` is configured, for example `api://97df847a-3e44-4aa7-82ea-557f3dfe0203/api.access`. This is the scope ChatGPT should request from Entra. The backend still validates the resulting access token against the short `scp`/role value in `OIDC_REQUIRED_SCOPES`, normally `api.access`. Use `MCP_OAUTH_SCOPE` only if a non-standard authorization server requires a different advertised request scope.

`MCP_RESOURCE_ORIGIN` is only the public HTTPS origin used to construct `resource_metadata` URLs in `WWW-Authenticate`, for example `https://<deployed-function-app-or-custom-domain>`. It is not the OAuth audience and should not be used as the metadata `resource` when `OIDC_AUDIENCE` is configured. In local development only, if `MCP_RESOURCE_ORIGIN` is missing, the gateway derives the origin from the request host/proxy headers.

## Security model

- OAuth is required for all private/API-backed MCP tools.
- The user allowlist remains enforced.
- Delegated client allowlisting remains enforced when configured.
- Service-client allowlisting remains enforced for app-only tokens.
- No static shared bearer tokens, API keys, hidden URLs, or unauthenticated private-data endpoints are introduced.
- Tool outputs must not include raw tokens, claims, Reddit credentials, WLH credentials, raw headers, or secrets.
- Public metadata and health may be unauthenticated only because they return safe operational metadata.
- The implementation reuses the existing `jose`-based JWT validation through `authorizeBearerToken`; it does not duplicate token validation logic.

## Troubleshooting

### `401` missing bearer

The connector did not send an access token, or OAuth linking has not completed. Check the MCP response `_meta["mcp/www_authenticate"]` and the HTTP `WWW-Authenticate` challenge from `GET /mcp`.

### `403` user not allowlisted

The token is valid, but neither the object ID nor subject matches the configured user allowlists. Update `OIDC_ALLOWED_OBJECT_IDS` or `OIDC_ALLOWED_SUBJECTS` with the intended operator identity.

### `403` delegated client not allowlisted

`OIDC_ALLOWED_DELEGATED_CLIENT_IDS` is configured and the token's delegated client (`azp` or `appid`) is not listed. Add the ChatGPT Developer Mode connector client ID only after verifying it is the intended client.

### Wrong `aud`, `iss`, or scope

Ensure `OIDC_AUDIENCE`, `OIDC_ISSUER`, and `OIDC_REQUIRED_SCOPES` match the token issued by Entra. The MCP protected-resource metadata returns `resource: OIDC_AUDIENCE` and advertises the fully qualified request scope `<OIDC_AUDIENCE>/api.access` so ChatGPT does not mix `resource=api://...` with a short `scope=api.access` authorization request.

### Entra `AADSTS9010010` resource/scope mismatch

If Entra returns:

```text
The resource parameter provided in the request doesn't match with the requested scopes.
```

verify:

```text
metadata.resource == OIDC_AUDIENCE == scope prefix
```

Example:

```text
metadata.resource:
api://97df847a-3e44-4aa7-82ea-557f3dfe0203

requested scope:
api://97df847a-3e44-4aa7-82ea-557f3dfe0203/api.access
```

`MCP_RESOURCE_ORIGIN` should still be the HTTPS host used for the `resource_metadata` URL, not the `api://...` OAuth audience. If ChatGPT reports that not all permissions were granted after connecting, reconnect after confirming the discovered/default scope is the fully qualified value (`api://.../api.access`) rather than the short value (`api.access`).

### ChatGPT OAuth linking does not start

Verify that `GET /.well-known/oauth-protected-resource` is reachable over HTTPS and returns the expected `resource`, `authorization_servers`, and `scopes_supported` values. Also verify the connector URL points at the public HTTPS MCP endpoint, not the metadata endpoint.

### Local tunnel is not HTTPS

Use an HTTPS tunnel. ChatGPT Developer Mode will not reliably connect to plain HTTP local endpoints.
