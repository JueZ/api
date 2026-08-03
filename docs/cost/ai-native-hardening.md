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

High-risk PR review remains isolated from runtime REC. Free deterministic CI, policy, and CodeQL checks must pass before the OpenAI request and are revalidated before the permanent repository/PR/head-SHA marker is created and immediately before generation. The completed neutral marker is created once, is never patched or released, and permanently consumes that exact head's review opportunity; approvals are not reused. Repository policy and runtime validation make `checks: write` exclusive to the immutable controller workflow. Reruns and repeated PR/label/manual events therefore fail closed without another request. The trusted controller retains the `gpt-5.6-sol` reviewer with medium reasoning, explicitly reserves capacity for final structured JSON, and permits at most one generation with up to 3,500 output tokens and no SDK retries. The complete contextual capsule has no repository-configured byte or per-head dollar ceiling, and the separate exact input-token count request has been removed. Returned token usage and its estimated cost remain sanitized audit metadata only; they do not gate generation or merge. A missing, malformed, incomplete, or transiently failed review requires a new repaired commit rather than an automatic paid retry. Local/unit/API tests use injected fakes and do not enable the live OpenAI request.

Each changed exact high-risk head can still produce one model-generation charge after the free checks pass. Batch locally validated changes before pushing because the permanent exact-head claim deliberately prevents a free retry of a consumed review.

Cheaper alternatives considered were one shared storage account, Function settings containing secrets, and no scheduled telemetry alerts. They were rejected because they collapse public/private, deploy/runtime, or detection trust boundaries. Disable the Bring canary or runtime LLM analysis independently if their variable/API costs are not justified. Pause high-risk delivery instead of bypassing its required independent review; do not disable authentication, audit retention, deterministic REC, or deployment smoke gates to save cost.
