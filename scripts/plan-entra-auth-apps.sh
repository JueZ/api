#!/usr/bin/env bash
set -euo pipefail

cat <<'PLAN'
This helper documents the Microsoft Entra app registrations needed for the v0 API catalogue.
It does not create or modify Azure resources.

Create manually or adapt these Azure CLI commands after reviewing tenant policy:

1. API app registration
   az ad app create \
     --display-name 'JueZ API Catalogue API' \
     --sign-in-audience AzureADMyOrg

2. Set an Application ID URI, commonly api://<api-app-client-id>.

3. Expose delegated scopes catalogue.read, reddit.read, youtube.read, wlh.read, weather.read, bring.read,
   bring.write, bring.complete, and bring.remove on the API app registration.
   The Azure CLI command requires the API app object ID and an oauth2PermissionScopes
   manifest patch. Review generated GUIDs and tenant policy before applying.

4. SPA app registration
   az ad app create \
     --display-name 'JueZ API Catalogue Web' \
     --sign-in-audience AzureADMyOrg \
     --web-redirect-uris 'http://localhost:4200' '<production-frontend-origin>'

5. Add the SPA platform redirect URIs and grant only the delegated scopes the
   browser client needs. Destructive Bring scopes should be consented only for
   the allowlisted operator client.

See docs/setup/authentication.md for exact required repository variables and validation steps.
PLAN
