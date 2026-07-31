# ADR 0005: Deterministic-first Repairable Error Contracts

## Status

Accepted for the 2026-07 AI-native remediation.

## Decision

All service-generated REST failures and all bundled MCP tool failures use the Repairable Error Contract (REC) envelope. Known input, authorization, policy, resource, rate-limit, provider, and mutation failures are classified by predefined deterministic builders before any model call.

Only a deterministic result classified as `diagnostic_uncertain` may be sent to the OpenAI Responses API. The analyzer receives an allowlisted, shape-only `DiagnosticCapsule`; raw request values, authorization headers, tokens, environment values, stack traces, and raw upstream bodies are excluded. Analyzer output is untrusted until it passes the local schema validator and operation/field policy gate. Model-produced `repair_patch` values are rejected because they are not mechanically verified; the model must use `repair_plan`.

REST returns REC as `application/problem+json`. MCP keeps the existing stable tool error code and includes the full contract at `structuredContent.repairable_problem`, with the recovery instruction and diagnostic ID also present in text content. JSON-RPC parse failures retain the JSON-RPC envelope and place REC in `error.data.repairable_problem`.

The gateway remains one `/mcp` route and one `McpServer` instance. REC support must not create another MCP service.

## Configuration and cost

`REPAIRABLE_ERRORS_LLM_ENABLED`, `REPAIRABLE_ERRORS_LLM_MODEL`, timeout, and sample-rate settings control the optional analyzer. Test and production intentionally reuse the repository `OPENAI_API_KEY`; deployments store it in Key Vault and expose only the managed application setting reference. Deterministic handling avoids model cost and latency for expected failures.

## Consequences

- Agents receive explicit retry and request-mutation guidance across REST and MCP.
- Authentication and suspicious-origin failures remain deterministic and never reach the analyzer.
- Missing, disabled, timed-out, invalid, or policy-rejected OpenAI results fall back safely.
- The public response never depends on an LLM being available.
