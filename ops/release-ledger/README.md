# Release ledger

Deployment workflows write a machine-readable release ledger JSON artifact for each test or production deployment. The ledger connects the deployed source commit, runtime-reported SHA, smoke correlation ID, protected API smoke status, telemetry gate status, and public frontend/API URLs.

Ledgers are uploaded as GitHub Actions artifacts. They are not committed back to `main` because they describe individual workflow executions and may include runtime resource names or URLs, but they must never contain secrets, tokens, connection strings, SAS URLs, or full environment dumps.

Validate a ledger with:

```bash
npm run ops:validate-release-ledger -- path/to/release-ledger.json
```
