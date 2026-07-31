# Cost note: AI-native hardening

The Bicep design keeps the combined monthly budget target at €25: €10 for test and €15 for production.

Added/expanded cost-bearing capabilities:

- Standard Key Vault for secret references;
- four low-volume StorageV2 accounts per environment to isolate trust boundaries;
- Application Insights/Log Analytics already used for runtime telemetry;
- Azure Monitor action group, scheduled-query alerts, and budget notifications;
- OpenAI API calls for high-risk PR review and optional bounded REC analysis of only `diagnostic_uncertain` runtime failures.

All storage remains standard LRS with lifecycle deletion (mutation 35 days, audit 365 days, releases 180 days). There is no SQL, Cosmos DB, API Management, Front Door, Search, Kubernetes, Cognitive Services, or always-on compute.

Known runtime failures use predefined deterministic REC messages and therefore add no model cost or latency. The runtime analyzer permits only Luna/low reasoning, has a 24,000-byte capsule cap, 700 output-token cap, no SDK retries, bounded timeout, optional sampling, schema/policy gate, and deterministic fallback. An unapproved configured model, oversized capsule, unavailable model, or invalid response returns the deterministic REC fallback. `REPAIRABLE_ERRORS_LLM_ENABLED=false` or a lower `REPAIRABLE_ERRORS_LLM_SAMPLE_RATE` disables or reduces this variable cost without weakening the public REC envelope.

High-risk PR review is cost-bounded independently from runtime REC. Free deterministic CI, policy, and CodeQL checks must pass before the paid call. The trusted controller permits only `gpt-5.6-luna` with low reasoning, at most 100,000 diff bytes, 2,000 output tokens, one API call, no SDK retries, and a conservative pre-call ceiling of $0.12. The sanitized artifact records the maximum budget and returned token usage. A missing, malformed, oversized, over-budget, or incomplete review fails closed without an automatic paid retry. Local/unit/API tests use injected fakes and do not enable live review calls.

The $0.12 ceiling is per exact high-risk PR head, not a monthly account cap. Configure an OpenAI project hard spend limit and earlier alerts in the Platform as the account-level backstop. Batch locally validated changes before pushing because each changed exact head must be reviewed again.

Cheaper alternatives considered were one shared storage account, Function settings containing secrets, and no scheduled telemetry alerts. They were rejected because they collapse public/private, deploy/runtime, or detection trust boundaries. Disable the Bring canary or runtime LLM analysis independently if their variable/API costs are not justified. Pause high-risk delivery instead of bypassing its required independent review; do not disable authentication, audit retention, deterministic REC, or deployment smoke gates to save cost.
