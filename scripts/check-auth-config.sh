#!/usr/bin/env bash
set -euo pipefail

missing=0
for name in \
  AUTH_ENABLED \
  OIDC_ISSUER \
  OIDC_AUDIENCE \
  OIDC_REQUIRED_SCOPES \
  OIDC_ALLOWED_OBJECT_IDS \
  WEB_AUTH_ENABLED \
  WEB_AUTH_CLIENT_ID \
  WEB_AUTH_AUTHORITY \
  WEB_AUTH_API_SCOPE \
  WEB_API_BASE_URL; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required auth configuration variable: $name" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

if [ "${AUTH_ENABLED}" != "true" ]; then
  echo "AUTH_ENABLED must be true for production." >&2
  exit 1
fi

if [ "${WEB_AUTH_ENABLED}" != "true" ]; then
  echo "WEB_AUTH_ENABLED must be true for production." >&2
  exit 1
fi

if [ "${OIDC_REQUIRED_SCOPES}" = "api.access" ] || [[ ",${OIDC_REQUIRED_SCOPES}," == *",api.access,"* ]]; then
  echo "OIDC_REQUIRED_SCOPES must use granular permissions; api.access is no longer supported." >&2
  exit 1
fi

for permission in \
  catalogue.read \
  reddit.read \
  wlh.read \
  bring.read \
  bring.write \
  bring.complete \
  bring.remove; do
  if [[ ",${OIDC_REQUIRED_SCOPES}," != *",${permission},"* ]]; then
    echo "OIDC_REQUIRED_SCOPES is missing canonical permission: $permission" >&2
    exit 1
  fi
done

if [[ "${WEB_AUTH_API_SCOPE}" != */catalogue.read ]]; then
  echo "WEB_AUTH_API_SCOPE must be the fully qualified catalogue.read scope." >&2
  exit 1
fi

echo "Required authentication configuration variable names are present. Values were not printed."
