# Infrastructure scope instructions

- Test and production must deploy with authentication enabled, exact non-wildcard CORS, and a canonical HTTPS MCP origin.
- Preserve separate Function-host, release, static-public, and private-integration storage boundaries with shared keys disabled.
- Use managed identity/OIDC and narrow data-plane RBAC. Do not add long-lived Azure client secrets.
- Keep secrets in Key Vault references and never output secret values.
- Preserve €10 test, €15 production, and €25 combined budget intent plus alerting and lifecycle retention.
- Infrastructure changes require Bicep build, policy guardrails, a cost note when applicable, and staged runtime verification after delivery.
