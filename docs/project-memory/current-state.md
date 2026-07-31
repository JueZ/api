# Current state

## 2026-07-31 AI-native hardening delivery in progress

- Branch `codex/full-ai-native-remediation` contains the 2026-07 architecture and AI-native audit remediation. The user lifted the previous no-commit boundary and authorized PR delivery plus deployment to test only. Production deployment is explicitly out of scope for this rollout even though `DEPLOY_PRODUCTION_ENABLED=true`; delivery must use the repository skip-autodeploy control and manually dispatch only `Deploy Test` after merge.
- The repository `OPENAI_API_KEY` is intentionally shared by test and production deployment configuration. Its value was not read or recorded. Runtime REC analysis is enabled by repository variables and remains deterministic-first.
- The local operation registry is the policy source for granular REST/MCP permissions, token types, environment access, idempotency, confirmation, and audit requirements. OpenAPI route/permission drift, registered MCP tool drift, generated operation docs, and mutation-governance evals are mechanically checked.
- All MCP capabilities remain bundled behind one `/mcp` Azure Function route and one `McpServer` instance. An architecture check prevents a second MCP server or endpoint.
- All service-generated REST errors and bundled MCP tool errors now use deterministic-first REC. Only sanitized `diagnostic_uncertain` capsules may reach the OpenAI Responses API; model output is schema/policy gated and model-authored JSON Patch is rejected.
- Bring test access deliberately uses the configured account in structurally read-only mode. Production mutations require explicit writable own-list UUIDs; shared/unlisted lists are denied. Add is durable and idempotent; complete/remove require a principal/list/payload-bound prepare/apply confirmation flow. Ambiguous and concurrent outcomes are never automatically replayed.
- Local delivery code uses an exact-head trusted merge controller, deterministic policy, independent AI review for high-risk paths, one post-main delivery chain, build-once artifacts, digest/SBOM/attestation verification, and exact test-to-production artifact promotion.
- Local infrastructure code separates host, release, static, and private storage; uses managed identity and Key Vault references; encodes auth/origin fail-closed rules; and adds lifecycle, alert, and budget policy.
- Earlier full local validation passed formatting/ESLint, TypeScript and Angular development type checks, production builds, contracts, policy, workflow, Bicep, release-verifier, and audit checks. After the REC expansion, the full suite passes 242 tests including 156 API tests; the remaining workflow/Bicep/security checks are rerun before commit. CodeQL, Trivy, Gitleaks, commit-bound release packaging, exact-head review, remote CI, deployment, smoke, telemetry, and runtime truth remain delivery gates.

## Authoritative references

- Architecture: `docs/architecture/`
- Current formal decisions: `docs/adr/`
- Operational rollout: `docs/project-memory/next-steps.md`
- Unresolved risk: `docs/project-memory/known-issues.md`
- Historical deployments/incidents/decisions: the corresponding append-only logs in this directory
