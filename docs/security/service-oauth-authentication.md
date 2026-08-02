# Service OAuth authentication

All protected REST and MCP operations use Microsoft Entra JWTs. The backend validates exact issuer/JWKS, audience, time claims, tenant, delegated client or app identity allowlists, and the operation's granular scope/app role.

| Caller               | Token                                           | Allowed permissions                                                                  |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Browser/GPT operator | delegated `scp` plus user and client allowlists | Explicit consented read/write permissions; destructive Bring only for the operator   |
| Deployment smoke app | app-only `roles` plus client/object allowlists  | `catalogue.service.read`, `reddit.service.read`, normalized to canonical permissions |
| Bring read canary    | app-only `roles` plus dedicated allowlists      | `bring.read` only                                                                    |
| Other service client | app-only `roles` plus dedicated allowlists      | Only documented non-destructive permissions; never `bring.complete`/`bring.remove`   |

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

`api.access` and `api.test` are retired. Entra exposes the canonical values above as delegated scopes. Because Entra custom applications reject a delegated scope whose value duplicates an application-role value, service-only roles use `catalogue.service.read` and `reddit.service.read`. The backend normalizes those two aliases to the canonical operation permissions only after it has classified and allowlisted an app-only service token. Delegated user tokens never receive service-role alias normalization.

`OIDC_REQUIRED_SCOPES` remains the canonical operation-permission vocabulary. Operation authorization always evaluates the canonical permission after the service-only normalization boundary.

Service tokens are recognized only by an app-only marker or roles-only client-credential evidence plus explicit service allowlists. Delegated tokens always remain on the user allowlist path. The code denies service tokens for destructive Bring operations even if a role is accidentally assigned.

`OIDC_ALLOWED_DELEGATED_CLIENT_IDS` is mandatory and non-empty in test and production deployment and startup validation. Delegated authorization requires an exact `azp` or `appid` match; a missing configuration, empty list, or missing client claim denies the user token. App-only service-token authorization remains independent and still requires its dedicated object/client allowlists.

Authenticated deployment smoke uses an already configured external test identity and short-lived tokens. This repository does not create, repair, rotate, or audit that service identity or its trust routes. Any future identity or permission maintenance is a separate privileged operator task outside the application delivery path. Runtime authorization remains fail closed on exact issuer, audience, allowlists, token type, and per-operation permissions.
