# Release ledger

Deployment workflows write a machine-readable release ledger JSON artifact for each test or production deployment. The ledger connects the deployed source commit, runtime-reported SHA, smoke correlation ID, protected API smoke status, telemetry gate status, and public frontend/API URLs.

Ledgers are uploaded as GitHub Actions artifacts. They are not committed back to `main` because they describe individual workflow executions and may include runtime resource names or URLs, but they must never contain secrets, tokens, connection strings, SAS URLs, or full environment dumps.

Validate a ledger with:

```bash
npm run ops:validate-release-ledger -- path/to/release-ledger.json
```

## Runtime truth operator command

`npm run ops:runtime-truth` can check live `/health` only, or combine live runtime truth with the latest release-ledger artifact from GitHub Actions.

Live-only mode verifies the public health endpoint and, when provided, the expected environment and deployed commit:

```bash
npm run ops:runtime-truth -- --environment prod --api-base-url https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net --expected-sha <sha>
```

Ledger mode additionally finds or downloads `release-ledger-<environment>-<sha>` from the relevant workflow run, validates the ledger, and compares live `/health` with the ledger commit:

```bash
npm run ops:runtime-truth -- --environment prod --api-base-url https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net --expected-sha <sha> --include-ledger=true --repo JueZ/api --run-id <exact-promote-run-id> --delivery-correlation <exact-correlation>
npm run ops:runtime-truth -- --environment test --api-base-url https://func-api-catalogue-test-iwt54bovfzvrc.azurewebsites.net --expected-sha <sha> --include-ledger=true --repo JueZ/api --run-id <exact-deploy-test-run-id> --delivery-correlation <exact-correlation>
```

Exit codes are `0` for verified, `1` for mismatch or failed smoke/telemetry evidence, and `2` for blocked or missing required evidence such as an unavailable GitHub CLI or missing release-ledger artifact.
