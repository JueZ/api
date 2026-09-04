---
name: azure-cli-devops
description: Use for Azure CLI inspection, Bicep validation, Azure resource/configuration work, and cost-aware infrastructure planning in JueZ/api.
---

# Azure CLI operations

Verify the selected account and project resource group before Azure operations. Use narrow queries; never output tokens, credentials, app-setting values, private data, or secret-bearing URLs.

Use [Azure operations](references/azure-operations.md) for account checks, host-specific authentication, RBAC, Bicep validation, cost constraints, and deployment prerequisites. Read only the relevant sections. Use `azure-observability-diagnostics` for runtime failures.

Honor the active task's scope: an investigation is read-only; ordinary repairs during authorized implementation/delivery inherit that authorization. Collect causal evidence before changes. Resource deletion, credential rotation, billing changes, broader RBAC, and production enablement require explicit authorization. Never weaken security or delivery controls.

Production deployment always uses the repository GitHub Actions/OIDC path, never a local shell. Do not enable production merely to unblock delivery. Preserve the documented Codex Cloud authentication exception without creating another credential path.

Report findings, relevant verification, changes and material cost/security implications, and any blocker. Avoid routine command inventories.
