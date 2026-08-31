# System architecture

JueZ/api is a private personal-integration platform with three delivery surfaces over one application core:

- Angular catalogue in Azure Storage static website hosting;
- REST endpoints in Azure Functions;
- a tool-only Streamable HTTP MCP gateway in the same Function App.

All Reddit, Willhaben, Bring, health, and authentication tools are bundled into that single `/mcp` gateway and one `McpServer` instance. Registration helpers may organize code, but they must not create a second server or endpoint; `npm run ops:check-architecture` enforces this invariant.

`apps/api/src/application/operations/registry.ts` is the canonical operation model. REST and MCP adapters select an operation, authenticate the caller, and enforce its permission, token type, environment, idempotency, confirmation, and audit policy before invoking provider code.

Provider clients for Reddit, willhaben, and Bring live behind normalized application-facing services. Provider responses are untrusted. Adapters expose bounded DTOs and repairable error shapes, never raw headers, credentials, tokens, or unrestricted upstream bodies.

Reddit's ordinary overview/thread operations remain lightweight snapshots. The explicit exhaustive comments operation uses the same Reddit service and normalizers but persists an append-only normalized comment snapshot plus a typed traversal frontier in the existing private Azure Blob account. Versioned HMAC-protected cursors contain only snapshot ID and page offset; Function managed identity has contributor access scoped to the dedicated private container, and ETags prevent concurrent writers from silently overwriting one another.

Every service-generated failure crosses one deterministic-first Repairable Error Contract boundary. Predefined mappings handle known failures without model cost. Only `diagnostic_uncertain` failures can send a sanitized shape-only capsule to the OpenAI Responses API, and the returned object must pass the schema and operation/field policy gate. REST uses `application/problem+json`; the single bundled MCP server exposes the same contract at `structuredContent.repairable_problem` while retaining stable MCP error codes.

Azure infrastructure separates Function host storage, immutable release packages, public static content, and private integration state. The Function system identity reads runtime data; the GitHub deployment identity writes artifacts through resource/container-scoped RBAC. Secrets are Key Vault references.

See also:

- [Trust boundaries](trust-boundaries.md)
- [Identity matrix](identity-matrix.md)
- [Environment isolation](environment-isolation.md)
- [Deployment flow](deployment-flow.md)
- [Operation model](operation-model.md)
- [Deterministic-first repairable errors](../adr/0005-deterministic-first-repairable-errors.md)
