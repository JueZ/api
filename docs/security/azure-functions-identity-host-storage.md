# Azure Functions identity-based host storage migration

## Status

Feasible and validated for this repository's current Azure Functions host. PR #246 deployed successfully through the normal test and production workflow gates for merge commit `677b1adfbe551c48525ef8b11a0722f5515d9989` on 2026-06-09.

This note evaluates migration away from an account-key-based `AzureWebJobsStorage` connection string. The target state is an identity-based Azure Functions host-storage connection using the Function App's system-assigned managed identity and storage-account-scoped Azure RBAC.

## Current runtime and deployment shape

`infra/main.bicep` deploys:

- Azure Functions runtime `~4`.
- Linux Consumption hosting on the Node.js 22 stack.
- A system-assigned managed identity on the Function App.
- A dedicated general-purpose `StorageV2` host account plus separate immutable-release, public-static, and private-integration accounts. The repository target enforces HTTPS-only traffic, TLS 1.2 minimum, disabled blob public access, and disabled shared-key access on every account.
- External run-from-package deployment from the immutable-release account using a private blob URL plus `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`, rather than Linux Consumption server-side build artifacts stored through `AzureWebJobsStorage`.

The API currently registers HTTP-triggered functions only; it does not use Blob, Queue, Event Hubs, Timer, or Durable triggers that would add host-storage role requirements beyond host coordination and diagnostic events.

## Microsoft support baseline

Official Microsoft Azure Functions documentation says:

- Identity-based connections are supported by Azure Functions, with support depending on the runtime and extension. The host-required storage connection, `AzureWebJobsStorage`, supports identity-based configuration.
- `AzureWebJobsStorage` is used by the Functions host for core behaviors such as singleton/timer coordination and default app-key storage, so all runtime and extension uses of that connection must support the identity format before migration.
- For identity-based `AzureWebJobsStorage`, configure either service URIs (`AzureWebJobsStorage__blobServiceUri`, `AzureWebJobsStorage__queueServiceUri`, and `AzureWebJobsStorage__tableServiceUri`) or, in public Azure without custom DNS, the shorthand `AzureWebJobsStorage__accountName`.
- In Azure-hosted Functions, managed identity is used; the system-assigned identity is the default when a user-assigned identity is not specified.
- Linux Consumption apps that use identity-based `AzureWebJobsStorage` must deploy through an external package if server-side build/deployment artifacts would otherwise use `AzureWebJobsStorage`.
- Management roles such as Owner are not sufficient for storage data access.
- The minimum host-only role is `Storage Blob Data Owner`; adding `Storage Table Data Contributor` enables Functions diagnostic events to be persisted to table storage.
- Blob triggers, Durable Functions, and other extensions add extra blob/queue/table or account-management role requirements. Those extra roles are not required for the current HTTP-only app shape.

Primary references:

- Microsoft Learn, Azure Functions developer guide, "Connecting to host storage with an identity": <https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity>
- Microsoft Learn, Azure Functions app settings reference for `AzureWebJobsStorage__*`: <https://learn.microsoft.com/en-us/azure/azure-functions/functions-app-settings#azurewebjobsstorage>
- Microsoft Learn, identity-based connection tutorial: <https://learn.microsoft.com/en-us/azure/azure-functions/functions-identity-based-connections-tutorial>
- Microsoft Learn, Azure built-in roles: <https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles>

## Target app settings

Use explicit service URIs instead of `AzureWebJobsStorage__accountName` so the template remains independent of hard-coded `core.windows.net` suffixes:

| Setting                                | Target value                                                |
| -------------------------------------- | ----------------------------------------------------------- |
| `AzureWebJobsStorage__blobServiceUri`  | `https://<storage-account>.blob.<storage-endpoint-suffix>`  |
| `AzureWebJobsStorage__queueServiceUri` | `https://<storage-account>.queue.<storage-endpoint-suffix>` |
| `AzureWebJobsStorage__tableServiceUri` | `https://<storage-account>.table.<storage-endpoint-suffix>` |
| `AzureWebJobsStorage__credential`      | `managedidentity`                                           |

Do not set the legacy `AzureWebJobsStorage` connection string in the target state.

## Target managed identity roles

Assign the Function App system-assigned managed identity at storage account scope:

| Role                             | Role definition ID                     | Why it is needed                                                                                                                                     |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Storage Blob Data Owner`        | `b7e6dc6d-f1e8-4753-8033-0f276bb0955b` | Required by Azure Functions host storage for blob read/write access and host container creation.                                                     |
| `Storage Queue Data Contributor` | `974c5e8b-45b9-4653-ba55-5f855dd0fb88` | Supports the explicitly configured host queue service endpoint and keeps host coordination compatible with current Azure Functions runtime behavior. |
| `Storage Table Data Contributor` | `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3` | Enables Functions diagnostic events to be written to table storage when startup or host-storage issues occur.                                        |

No `Storage Account Contributor` or Durable-specific management role is included. Future trigger or binding changes must be reviewed against the extension's exact blob, queue, table, and management-plane requirements.

## Storage account configuration

The existing storage account settings are compatible with the migration:

- `kind: StorageV2` satisfies Functions host storage's general-purpose storage requirement.
- `supportsHttpsTrafficOnly: true` and `minimumTlsVersion: TLS1_2` should remain enforced.
- `allowBlobPublicAccess: false` should remain enforced.
- `allowSharedKeyAccess: false` and `defaultToOAuthAuthentication: true` should remain enforced on all Bicep-managed storage accounts.

The current repository target uses Microsoft Entra/RBAC for host, package, static-web, private-state, diagnostic, operator, and recovery paths. Live environments can lag repository intent, so verify the deployed storage properties and role assignments before treating this document as runtime evidence.

## Feasibility conclusion

Migration is currently feasible because:

1. The Function App runs Azure Functions runtime `~4`, which supports identity-based host storage.
2. The app already has a system-assigned managed identity.
3. The deployment workflow already uses external run-from-package deployment and managed-identity package reads, satisfying the Linux Consumption caution for identity-based host storage.
4. The Function App only registers HTTP triggers; the repository grants the host blob, queue, and diagnostic table data roles without broader storage management access.
5. Existing application code that reads WLH category blobs uses `DefaultAzureCredential` and `WLH_STORAGE_ACCOUNT_NAME`, not the `AzureWebJobsStorage` connection string.

## Rollout and validation evidence

PR #246 completed the migration through the normal protected delivery flow for merge commit `677b1adfbe551c48525ef8b11a0722f5515d9989`:

1. PR CI, Policy Check, and Codex Auto-Merge passed.
2. Post-merge `main` CI passed for `677b1adfbe551c48525ef8b11a0722f5515d9989`.
3. `Deploy Test` run `27229870948` succeeded for `677b1adfbe551c48525ef8b11a0722f5515d9989`, including Bicep deployment, Function package deployment, runtime smoke, authenticated smoke, telemetry gate, and release-ledger upload.
4. `Promote Production` run `27229866903` succeeded for `677b1adfbe551c48525ef8b11a0722f5515d9989`, including Bicep deployment, Function package deployment, runtime smoke, authenticated smoke, telemetry gate, and release-ledger upload.

Subsequent repository hardening split storage by purpose, added the host queue role, and disabled shared-key access in Bicep. Those later repository changes are design intent, not proof of current production state. Future validation must confirm deployed app-setting names, storage properties, and managed-identity role assignments without printing secret values. Run authenticated smoke against `GET /api/hello` and `POST /api/reddit/thread` whenever this storage identity path changes.

## Recovery and rollback

- Treat deployment identity role-assignment permissions as a bootstrap prerequisite: the deployment identity must be able to create or update the Bicep-managed Function App storage role assignments, or the assignments must be pre-provisioned safely.
- Application-package rollback uses the protected rollback workflow and must not run Bicep or change storage authentication, identity, RBAC, or safety settings.
- Infrastructure recovery is a reviewed forward fix through the normal staged Bicep workflow. Preserve identity-based settings and `allowSharedKeyAccess: false`; do not restore an `AzureWebJobsStorage` connection string or manually copy storage keys into app settings.
- If a platform limitation ever requires reconsidering shared-key access, treat that as a new security architecture decision with test evidence and an explicit ADR, not an emergency package rollback step.

## Revisit triggers

Revisit this design if any of the following changes occur:

- The app adds Blob, Queue, Event Hubs, Timer, or Durable triggers/bindings.
- The deployment workflow changes away from external run-from-package packages.
- A deployment, diagnostic, operator, or recovery path can no longer use Microsoft Entra/RBAC while shared-key access remains disabled.
- The app moves to a sovereign cloud, custom storage DNS, Flex Consumption, Premium, or Dedicated App Service plan.
- Azure Functions changes the documented role requirements for identity-based `AzureWebJobsStorage`.
