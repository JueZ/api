# Service OAuth authentication

All protected REST and MCP operations use Microsoft Entra JWTs. The backend validates exact issuer/JWKS, audience, time claims, tenant, delegated client or app identity allowlists, and the operation's granular scope/app role.

| Caller               | Token                                           | Allowed permissions                                                                |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Browser/GPT operator | delegated `scp` plus user and client allowlists | Explicit consented read/write permissions; destructive Bring only for the operator |
| Deployment smoke app | app-only `roles` plus client/object allowlists  | `catalogue.read`, `reddit.read`                                                    |
| Bring read canary    | app-only `roles` plus dedicated allowlists      | `bring.read` only                                                                  |
| Other service client | app-only `roles` plus dedicated allowlists      | Only documented non-destructive permissions; never `bring.complete`/`bring.remove` |

Canonical permissions:

```text
catalogue.read
reddit.read
wlh.read
bring.read
bring.write
bring.complete
bring.remove
```

`api.access` and `api.test` are retired. Entra exposes delegated scopes and matching application roles as needed. `OIDC_REQUIRED_SCOPES` lists the canonical permission vocabulary; operation authorization still requires the exact permission in the token.

Service tokens are recognized only by an app-only marker or roles-only client-credential evidence plus explicit service allowlists. Delegated tokens always remain on the user allowlist path. The code denies service tokens for destructive Bring operations even if a role is accidentally assigned.

GitHub Actions obtains a GitHub OIDC assertion and exchanges it for a short-lived Entra access token. No static API bearer token or service client secret is stored. Use `scripts/configure-entra-service-oauth.sh` to configure non-destructive roles; it rejects destructive Bring roles.

Before authenticated smoke, `scripts/mint-smoke-token.mjs` decodes only the short-lived token it just received over the Entra token endpoint and verifies the configured tenant/client correlation plus the exact expected application-role names. It does not log token claims. Deployment smoke requires `catalogue.read,reddit.read`; the Bring read canary requires only `bring.read`. Missing roles fail before the token is exported and must be repaired in Entra rather than by broadening API authorization.
