# Cost note: AI-native hardening

The Bicep design keeps the combined monthly budget target at €25: €10 for test and €15 for production.

Added/expanded cost-bearing capabilities:

- Standard Key Vault for secret references;
- four low-volume StorageV2 accounts per environment to isolate trust boundaries;
- Application Insights/Log Analytics already used for runtime telemetry;
- Azure Monitor action group, scheduled-query alerts, and budget notifications;
- OpenAI API calls for high-risk PR review and optional bounded REC analysis of only `diagnostic_uncertain` runtime failures.

All storage remains standard LRS with lifecycle deletion (mutation 35 days, audit 365 days, releases 180 days). There is no SQL, Cosmos DB, API Management, Front Door, Search, Kubernetes, Cognitive Services, or always-on compute.

Known runtime failures use predefined deterministic REC messages and therefore add no model cost or latency. The runtime analyzer has a bounded timeout, output-token limit, optional sampling, schema/policy gate, and deterministic fallback. `REPAIRABLE_ERRORS_LLM_ENABLED=false` or a lower `REPAIRABLE_ERRORS_LLM_SAMPLE_RATE` disables or reduces this variable cost without weakening the public REC envelope.

Cheaper alternatives considered were one shared storage account, Function settings containing secrets, and no scheduled telemetry alerts. They were rejected because they collapse public/private, deploy/runtime, or detection trust boundaries. Disable the Bring canary, runtime LLM analysis, and autonomous AI review independently if their variable/API costs are not justified; do not disable authentication, audit retention, deterministic REC, or deployment smoke gates to save cost.
