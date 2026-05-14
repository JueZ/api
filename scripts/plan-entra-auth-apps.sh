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

3. Expose delegated scope api.access on the API app registration.
   The Azure CLI command requires the API app object ID and an oauth2PermissionScopes
   manifest patch. Review generated GUIDs and tenant policy before applying.

4. SPA app registration
   az ad app create \
     --display-name 'JueZ API Catalogue Web' \
     --sign-in-audience AzureADMyOrg \
     --web-redirect-uris 'http://localhost:4200' '<production-frontend-origin>'

5. Add the SPA platform redirect URIs and grant delegated access to the API scope.

See docs/setup/authentication.md for exact required repository variables and validation steps.
PLAN
