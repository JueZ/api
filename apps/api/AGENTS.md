# API scope instructions

- Treat `application/operations/registry.ts` as the canonical operation model.
- Add or change a callable route/tool only with a stable operation entry, granular permission, token/environment policy, schemas, and tests.
- Keep provider responses behind normalized services. Never expose raw headers, tokens, credentials, account payloads, private HTML, or unbounded bodies.
- Destructive Bring changes must retain explicit own-list allowlisting, durable operation UUIDs, optimistic concurrency, principal/payload-bound confirmation, sanitized audit, and outcome-unknown replay blocking.
- Application code must not depend on Azure Function, MCP, or infrastructure adapters. Compose infrastructure under `infrastructure/composition/`.
- For REST behavior changes, update both OpenAPI contracts and run API, route-drift, architecture, and agent eval checks. For other changes, select checks for the affected behavior and protected diff classification.
