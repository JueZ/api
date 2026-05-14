# Known issues and unresolved risks

Last updated: 2026-05-14

## Active

- `Promote Production` run `25852035606` successfully deployed production and passed smoke tests, but the workflow concluded `failure` because `GITHUB_TOKEN` could not write repository variables in the post-smoke metadata update step. This is a workflow correctness issue, not an application deployment failure. Fix by making that metadata update idempotent/best-effort or by documenting a safe token strategy; do not fail a successful deployment solely because repository metadata could not be rewritten.
- Codex Azure identity lacks sufficient Microsoft Graph directory permissions to list or inspect Microsoft Entra app registrations and federated credentials. During the readiness sprint, `az ad sp list --filter "appId eq '<client-id>'"` and `az ad app federated-credential list --id '<client-id>'` failed with insufficient privileges. A delegated identity with app-registration read permissions is needed for full Entra/OIDC verification.
- Deployment-principal RBAC could be inspected at resource-group scope and required service-principal role assignments were present, but Graph limits prevented mapping all service-principal assignments to the exact display name/object ID from Codex.
- Interactive Angular/MSAL login and allowlisted authenticated `GET /api/hello` were not browser-verified by Codex because the environment cannot complete interactive Entra sign-in. Manual verification remains required.
- GitHub Actions reported Node.js 20 action runtime deprecation warnings for upstream actions (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/github-script@v7`, `azure/login@v2`). Runtime application code is Node 22; monitor upstream action updates or GitHub runner defaults before June 2026.

## Historical / resolved

- Production previously served the pre-auth public placeholder for unauthenticated `GET /api/hello`; this was resolved by the 2026-05-14 production promotion, and unauthenticated production `GET /api/hello` now returns `401`.
- Production Function App previously lacked an observable system-assigned identity before the auth-enabled production deployment; this is resolved after the production promotion.
- Earlier notes about auth implementation being unmerged or PR #40 being open are superseded; auth code is on `main`.
- Historical SAS-backed package URL issues are superseded by managed-identity package access.
- Historical storage upload/RBAC, static website, and Node runtime deployment failures are recorded in `incident-log.md`.
