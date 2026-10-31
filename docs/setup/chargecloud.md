# Chargecloud setup

The read-only MCP tools access the public Wien Energie Chargecloud source. No provider account, API key, or new Azure service is required. The API authenticates callers and requires the `chargecloud.read` operation permission; the upstream source is not an authorization boundary.

`chargecloud_list_charging_points` accepts a four-digit postal code (default `1080`), `availableOnly` (default `false`), `limit` (default and maximum `100`), and `offset` (default `0`, maximum `10000`). It returns bounded normalized charging points and pagination information. Each call fetches provider data again: EVSE IDs are sorted before slicing, but an offset is not a consistent snapshot, so changing availability or membership between calls can cause omissions or duplicates. `fetchedAt` identifies retrieval and `sourceTimestamp` identifies the provider response; neither proves when a charger measured its status. `chargecloud_get_charging_point` fetches a charging point by its full starred EVSE identifier. Availability may change after retrieval, and charger telemetry lag is unknown.

## Provider behavior and bounds

The fixed upstream URL is `https://app.chargecloud.de/emobility:ocpi/16551d48ed6c048085c5e8bccd34b0c7/app/2.0/locations`. The configured Wien Energie feed includes roaming operators. Postal filtering happens locally against exactly `postal_code`; the provider ignored a postal-code query in the live probe. No list of twenty known IDs is hard-coded, and both `AT*VNA*` and `AT*VIE*` identifiers remain valid.

The client allows at most 32 MiB for a list response, 1 MiB for an EVSE response, and 25 seconds for the fetch and body. It rejects redirects, malformed envelopes, and ambiguous EVSE identities. An unknown EVSE is `not_found`; an invalid provider response is an error, never a successful empty availability result. Only exact `AVAILABLE` is considered free. Output contains at most 100 EVSEs and 16 normalized connectors per EVSE. Connector metadata beyond that bound is omitted.

The custom provider field `max_power` is retained as `maxPowerKw`: kW is empirically inferred from the observed 11/22/50/150/300/400 values and connector electrical data. This unit interpretation and the observed feed coverage have no published field-specific contractual guarantee. The provider-derived fixtures document the 2026-10-31 probe and do not establish future physical availability.

Example MCP calls:

```json
{ "name": "chargecloud_list_charging_points", "arguments": { "postalCode": "1080", "availableOnly": true } }
```

```json
{ "name": "chargecloud_get_charging_point", "arguments": { "evseId": "AT*VNA*E1080570007*2" } }
```

## Entra and deployment

1. On the API app registration, expose and enable a delegated scope with the exact value `chargecloud.read` under **Expose an API**. Keep the existing application ID URI, scopes, roles, and authorization policy intact.
2. Add `chargecloud.read` to the existing comma-separated `OIDC_REQUIRED_SCOPES` repository/environment variable for every deployed environment, retaining every existing canonical permission. Test and production runtime safety validation requires the complete vocabulary. The deployed setting is sourced from that variable; changing a repository default alone does not update an explicitly configured variable.
3. Ensure the intended OAuth client requests the fully qualified scope. An administrator can grant it for one existing user and one existing OAuth client using the repository's per-user helper, which preserves other scopes on that grant:

   ```bash
   API_APP_ID='<API application client ID>' \
   OAUTH_CLIENT_APP_ID='<ChatGPT OAuth client application ID>' \
   USER_ID='<user object ID or user principal name>' \
   DELEGATED_SCOPE_VALUE='chargecloud.read' \
   ./scripts/grant-entra-user-scope.sh
   ```

   The helper requires the Graph permissions or directory role described in [service OAuth authentication](../security/service-oauth-authentication.md). Run it only for the intended user and client. It requires the scope to exist and does not create credentials.

4. Reconnect or reauthorize the client to obtain a fresh token containing the scope. Verify an underprivileged token is denied and an authorized caller can list and retrieve charging points after deployment.

For an app-only client, use a separately configured `chargecloud.service.read` application role only when that service needs access. The backend maps that role to `chargecloud.read` after service identity classification and allowlist checks. Creating the role or assigning it is not needed for delegated user access.

These steps describe required configuration; the presence of this document does not establish that a scope, grant, setting, or deployment is live.
