# Cost note: AI-native hardening

The Bicep design keeps the combined monthly budget target at €25: €10 for test and €15 for production.

Added/expanded cost-bearing capabilities:

- Standard Key Vault for secret references;
- four low-volume StorageV2 accounts per environment to isolate trust boundaries;
- one private Reddit snapshot container inside the existing private-integration account; snapshots expire after two days at the storage lifecycle boundary and add only low-volume LRS Blob capacity/transactions;
- Application Insights/Log Analytics already used for runtime telemetry;
- Azure Monitor action group and budget notifications; the six five-minute scheduled-query alerts were retired because their recurring evaluation cost dominated the low-volume workload;
- optional bounded OpenAI API calls only for REC analysis of `diagnostic_uncertain` runtime failures.

All storage remains standard LRS with lifecycle deletion (Reddit snapshots 2 days, mutation 35 days, audit 365 days, releases 180 days). There is no SQL, Cosmos DB, API Management, Front Door, Search, Kubernetes, Cognitive Services, or always-on compute.

Known runtime failures use predefined deterministic REC messages and therefore add no model cost or latency. The runtime analyzer permits only `gpt-5.6-luna` with high reasoning, has a 24,000-byte capsule cap, 700 output-token cap, no SDK retries, bounded timeout, optional sampling, schema/policy gate, and deterministic fallback. An unapproved configured model, oversized capsule, unavailable model, incomplete output, or invalid response returns the deterministic REC fallback. `REPAIRABLE_ERRORS_LLM_ENABLED=false` or a lower `REPAIRABLE_ERRORS_LLM_SAMPLE_RATE` disables or reduces this variable cost without weakening the public REC envelope.

Pull-request governance makes no OpenAI request. Privileged paths receive deterministic broad validation through `PR Gate` and `Security Gate`; no custom controller, model review, check-run writer, historical evidence verifier, or paid provider context is required. Local and protected governance therefore have no provider cost and do not depend on API credit availability.

Configure an OpenAI project hard spend limit and earlier alerts in the Platform as the account-level backstop for the optional runtime analyzer. Proportional path-aware PR jobs and one protected-main build reduce Actions work without weakening runtime gates.

Cheaper alternatives considered were one shared storage account, Function settings containing secrets, and no scheduled telemetry alerts. They were rejected because they collapse public/private, deploy/runtime, or detection trust boundaries. Disable the Bring canary or runtime LLM analysis independently if their variable/API costs are not justified. Do not bypass deterministic protected governance or disable authentication, audit retention, deterministic REC, or deployment smoke gates to save cost.

The Function 5xx, OAuth spike, and Bring protocol scheduled-query alerts are intentionally absent in test and production. Delivery disables and deletes their retired resource names after the incremental Bicep deployment so they cannot survive as unmanaged resources. Application Insights ingestion, deployment telemetry checks, smoke tests, budget notifications, and the action group remain enabled.
