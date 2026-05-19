# Willhaben category endpoint feasibility (sanitized)

Date: 2026-05-19 (UTC)

## Probe A: unauthenticated category endpoint
Command (sanitized):
`curl -i --max-time 10 https://api.willhaben.at/restapi/v2/categorytree/withattributes/67`

Result summary:
- curl exit: `0`
- HTTP status: `400 Bad Request`
- content-type: `text/plain; charset=UTF-8`
- JSON returned: `no`
- auth/application-token style error: not explicitly returned in body (plain text response)

Conclusion:
- Direct unauthenticated category-tree access did not succeed in this environment.
- Live endpoint remains unverified for safe category ingestion.

## Probe B (application-data token flow)
- Required env vars checked: `WH_APP_HMAC_SECRET`, `WH_APP_ORGANIZATION`, `WH_APP_CLIENT_HEADER`, `WH_APP_SECURITY_VERSION`, `WH_APP_PROVIDER`, `WH_USER_AGENT`.
- Status: **skipped** because required env vars were not available.
- No token/signature generation was performed.

## Probe C (category-tree with application token)
- Status: **skipped** because Probe B did not run and no application token was available.

## Probe D (optional adTypeId=69)
- Status: **deferred** because adTypeId 67 was not successfully verified.

## Implementation decision from probe
- Use snapshot-first category provider.
- Keep live category provider disabled by default.
- Do not implement live token flow in this change.
