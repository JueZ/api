# Service OAuth authentication

All protected REST and MCP operations use Microsoft Entra JWTs. The backend validates exact issuer/JWKS, audience, time claims, tenant, delegated client or app identity allowlists, and the operation's granular scope/app role.

| Caller               | Token                                           | Allowed permissions                                                                                          |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Browser/GPT operator | delegated `scp` plus user and client allowlists | Explicit consented read/write permissions; destructive Bring only for the operator                           |
| Deployment smoke app | app-only `roles` plus client/object allowlists  | `catalogue.service.read`, `reddit.service.read`, `weather.service.read`, normalized to canonical permissions |
| Bring read canary    | app-only `roles` plus dedicated allowlists      | `bring.read` only                                                                                            |
| Other service client | app-only `roles` plus dedicated allowlists      | Only documented non-destructive permissions; never `bring.complete`/`bring.remove`                           |

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

`api.access` and `api.test` are retired. Entra exposes the canonical values above as delegated scopes. Because Entra custom applications reject a delegated scope whose value duplicates an application-role value, service-only roles use `catalogue.service.read`, `reddit.service.read`, and `weather.service.read`. The backend normalizes those aliases to the canonical operation permissions only after it has classified and allowlisted an app-only service token. Delegated user tokens never receive service-role alias normalization.

`OIDC_REQUIRED_SCOPES` remains the canonical operation-permission vocabulary. Operation authorization always evaluates the canonical permission after the service-only normalization boundary.

Service tokens with `idtyp=app` use the explicit service object-ID or client-ID allowlist. For older Entra access tokens that omit `idtyp`, the roles-only compatibility path additionally requires a confidential-client marker (`azpacr`/`appidacr` `1` or `2`) and the service principal `oid` in `OIDC_ALLOWED_APP_OBJECT_IDS`; a client ID alone is deliberately insufficient. `idtyp=user` and every token with `scp` stay on the delegated user path, while ambiguous or unknown `idtyp` values are rejected. Delegated authorization uses only `scp`; app roles and service-role aliases never grant user permissions. The code denies service tokens for destructive Bring operations even if a role is accidentally assigned.

`OIDC_ALLOWED_DELEGATED_CLIENT_IDS` is mandatory and non-empty in test and production deployment and startup validation. Delegated authorization requires an exact `azp` or `appid` match; a missing configuration, empty list, or missing client claim denies the user token. App-only service-token authorization remains independent and still requires its dedicated object/client allowlists.

Every accepted token must contain an expiry and pass issuer, audience, expiry/not-before, tenant, identity, client, token-shape, and operation-permission checks. Test and production also require a non-empty tenant allowlist inside the request authorization boundary, independently of startup validation.

When `OIDC_JWKS_URI` is configured explicitly, it is a protected operator pin and may intentionally use a different HTTPS origin from the issuer. Without that pin, discovery metadata is untrusted: redirects are rejected, metadata `issuer` must match the configured issuer or its supported Entra alias, and `jwks_uri` must be a clean same-origin HTTPS URL. Loopback HTTP exists only for controlled local tests. Remote JWKS caching and unknown-key refresh preserve normal key rotation.

Authenticated deployment smoke uses an already configured external test identity and short-lived tokens. This repository does not create, repair, rotate, or audit that service identity or its trust routes. Any future identity or permission maintenance is a separate privileged operator task outside the application delivery path. Runtime authorization remains fail closed on exact issuer, audience, allowlists, token type, and per-operation permissions.
