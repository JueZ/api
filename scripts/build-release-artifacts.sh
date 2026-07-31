#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
output_dir="${1:-$repository_root/.release}"
source_ref="${SOURCE_REF:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"

if ! [[ "$source_ref" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "SOURCE_REF must be a full 40-character commit SHA." >&2
  exit 1
fi

release_temp="$(mktemp -d)"
cleanup() {
  rm -rf "$release_temp"
}
trap cleanup EXIT

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
rm -f \
  "$output_dir/functionapp.zip" \
  "$output_dir/frontend.tar.gz" \
  "$output_dir/sbom.cdx.json" \
  "$output_dir/SHA256SUMS" \
  "$output_dir/release-manifest.json"

function_stage="$release_temp/function-package"
mkdir -p "$function_stage"
cp \
  "$repository_root/apps/api/host.json" \
  "$repository_root/apps/api/package.json" \
  "$repository_root/apps/api/package-lock.json" \
  "$function_stage/"
cp -R "$repository_root/apps/api/dist" "$function_stage/dist"
npm ci --omit=dev --ignore-scripts --prefix "$function_stage"

# Import the exact production-only staged package with fail-closed deployment
# settings. This catches dependencies that exist only in the root workspace and
# composition-root/indexing regressions before the archive can be published.
# Entra object and tenant IDs are GUID-shaped identifiers; they are not
# guaranteed to encode RFC UUID version or variant marker bits. Keep these
# production-package probes deliberately non-versioned so the release build
# exercises the same identifier contract as a real Entra configuration.
DEPLOYED_ENVIRONMENT_NAME=test \
AUTH_ENABLED=true \
OIDC_ISSUER=https://login.example.test/tenant/v2.0 \
OIDC_AUDIENCE=api://catalogue-test \
OIDC_REQUIRED_SCOPES=catalogue.read,reddit.read,wlh.read,bring.read,bring.write,bring.complete,bring.remove \
OIDC_ALLOWED_OBJECT_IDS=11111111-1111-0000-0000-111111111111 \
OIDC_ALLOWED_TENANTS=22222222-2222-0000-0000-222222222222 \
API_CORS_ALLOWED_ORIGINS=https://web.example.test \
MCP_RESOURCE_ORIGIN=https://api.example.test \
MCP_ALLOWED_ORIGINS=https://chatgpt.com \
BRING_ENABLED=false \
BRING_ADD_ENABLED=false \
BRING_DESTRUCTIVE_ENABLED=false \
node "$function_stage/dist/index.js"

(
  cd "$function_stage"
  find . -type f -print0 \
    | sort -z \
    | xargs -0 zip -q -X "$output_dir/functionapp.zip"
)

frontend_root="$repository_root/dist/apps/web/browser"
if [ ! -f "$frontend_root/index.html" ]; then
  echo "Angular build output was not found at $frontend_root." >&2
  exit 1
fi
tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -czf "$output_dir/frontend.tar.gz" \
  -C "$frontend_root" \
  .

(
  cd "$function_stage"
  npm sbom --omit=dev --sbom-format cyclonedx > "$output_dir/sbom.cdx.json"
)

(
  cd "$output_dir"
  sha256sum functionapp.zip frontend.tar.gz sbom.cdx.json > SHA256SUMS
)

function_digest="$(sha256sum "$output_dir/functionapp.zip" | awk '{print $1}')"
frontend_digest="$(sha256sum "$output_dir/frontend.tar.gz" | awk '{print $1}')"
sbom_digest="$(sha256sum "$output_dir/sbom.cdx.json" | awk '{print $1}')"

# JavaScript reads these environment variables at runtime.
# shellcheck disable=SC2016
SOURCE_REF="${source_ref,,}" \
FUNCTION_DIGEST="$function_digest" \
FRONTEND_DIGEST="$frontend_digest" \
SBOM_DIGEST="$sbom_digest" \
node --input-type=module --eval '
  import { writeFileSync } from "node:fs";
  const manifest = {
    schemaVersion: 1,
    sourceRef: process.env.SOURCE_REF,
    artifacts: {
      functionapp: { file: "functionapp.zip", sha256: process.env.FUNCTION_DIGEST },
      frontend: { file: "frontend.tar.gz", sha256: process.env.FRONTEND_DIGEST },
      sbom: { file: "sbom.cdx.json", sha256: process.env.SBOM_DIGEST },
    },
  };
  writeFileSync(process.argv[1], `${JSON.stringify(manifest, null, 2)}\n`);
' "$output_dir/release-manifest.json"

echo "Release artifacts created for ${source_ref,,} in $output_dir."
