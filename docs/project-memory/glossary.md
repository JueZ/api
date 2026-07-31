# Glossary

- GitHub Actions OIDC identity: The Azure federated identity used by GitHub Actions to deploy without a long-lived Azure client secret.
- Codex direct Azure identity: The separate Azure identity used by Codex for direct diagnostics and safe operational work from the Codex environment.
- `Deploy Test`: GitHub Actions workflow that deploys merged commits to the test environment and runs smoke tests.
- `Promote Production`: GitHub Actions workflow that promotes a commit to production after test smoke tests pass or by manual dispatch.
- `rg-api-test`: Test Azure resource group for this project.
- `rg-api-prod`: Production Azure resource group for this project.
- Function App: Azure Functions hosting resource for the TypeScript API backend.
- Storage account: Azure Storage resource used by the Function App and static frontend deployment flow.
- `WEBSITE_RUN_FROM_PACKAGE`: Function App setting that points the runtime at a deployment package, currently backed by a package blob URL and targeted for future hardening.
- OpenAPI: API contract format used in `contracts/openapi.yaml` to describe routes, responses, and future security schemes.
- Azure Functions `routePrefix`: Host-level route prefix setting. This project uses `routePrefix: ""`, so function routes are defined explicitly in code.
- CI complete: Aggregate GitHub Actions check indicating the CI workflow required jobs completed successfully.
- Policy complete: Aggregate GitHub Actions check indicating cost and guardrail policy checks completed successfully.
- Production failure repair issue: GitHub issue created only when production deployment or production smoke tests fail after merge, so the failure remains visible outside any completed PR.
- Codex Auto-Merge: Trusted exact-head controller for eligible Codex branches or PRs labeled `codex-automerge`; it reviews the recorded head, proves source-bound required checks, and requests a squash merge of only that SHA. It does not rely on GitHub-native auto-merge.
