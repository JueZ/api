# ADR 0004: Single bundled MCP gateway

- Status: accepted locally; not yet deployed
- Date: 2026-07-31

## Decision

Expose health, authentication, Reddit, Willhaben, and Bring tools through one `/mcp` Azure Function route and one `McpServer` instance. Registration helpers may organize implementation details, but they must register into that instance and must not create a second MCP server, route, deployment, or client configuration.

## Consequences

Clients configure one MCP endpoint and receive one coherent tool catalogue and OAuth resource. The architecture checker enforces the single-server/single-route invariant, while operation-registry drift checks enforce the exact bundled tool set.
