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

GitHub Actions obtains a GitHub OIDC assertion and exchanges it for a short-lived Entra access token. No static API bearer token or service client secret is stored. `scripts/configure-entra-service-oauth.sh` is a read-only test verifier locked to the checked-in tenant, API client/identifier URI, service client/service-principal object, `JueZ/api` / `test` / main deployment-workflow subject, named FIC, and fixed `catalogue.read,reddit.read` assignments. Caller values can only assert those exact constants. The verifier performs no Azure or GitHub mutation and cannot create, update, rotate, or broaden a trust route; a mismatch requires a separately reviewed privileged repair.
