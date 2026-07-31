# Azure Functions identity-based host storage migration

## Status

Feasible and validated for this repository's current Azure Functions host. PR #246 deployed successfully through the normal test and production workflow gates for merge commit `677b1adfbe551c48525ef8b11a0722f5515d9989` on 2026-06-09.

This note evaluates migration away from an account-key-based `AzureWebJobsStorage` connection string. The target state is an identity-based Azure Functions host-storage connection using the Function App's system-assigned managed identity and storage-account-scoped Azure RBAC.

## Current runtime and deployment shape

`infra/main.bicep` deploys:

- Azure Functions runtime `~4`.
- Linux Consumption hosting on the Node.js 22 stack.
- A system-assigned managed identity on the Function App.
- A general-purpose `StorageV2` storage account with HTTPS-only traffic, TLS 1.2 minimum, and blob public access disabled.
- External run-from-package deployment using a private blob URL plus `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned` in the deployment workflow, rather than Linux Consumption server-side build artifacts stored through `AzureWebJobsStorage`.

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

| Role                             | Role definition ID                     | Why it is needed                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Storage Blob Data Owner`        | `b7e6dc6d-f1e8-4753-8033-0f276bb0955b` | Required by Azure Functions host storage for blob read/write access and host container creation; also covers package blob read access that was previously granted by `Storage Blob Data Reader`. |
| `Storage Table Data Contributor` | `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3` | Enables Functions diagnostic events to be written to table storage when startup or host-storage issues occur.                                                                                    |

No `Storage Queue Data Contributor`, `Storage Account Contributor`, or Durable-specific roles are included because the current app has no Blob triggers, Queue triggers, Event Hubs triggers, Timer triggers, or Durable Functions. Add those roles only with a future trigger/binding change that requires them.

## Storage account configuration

The existing storage account settings are compatible with the migration:

- `kind: StorageV2` satisfies Functions host storage's general-purpose storage requirement.
- `supportsHttpsTrafficOnly: true` and `minimumTlsVersion: TLS1_2` should remain enforced.
- `allowBlobPublicAccess: false` should remain enforced.

This migration does not disable storage account shared-key access yet. Disabling shared key is a separate hardening step that should happen only after validating every deployment, static web, diagnostic, operator, and recovery path uses Microsoft Entra/RBAC rather than account keys or connection strings.

## Feasibility conclusion

Migration is currently feasible because:

1. The Function App runs Azure Functions runtime `~4`, which supports identity-based host storage.
2. The app already has a system-assigned managed identity.
3. The deployment workflow already uses external run-from-package deployment and managed-identity package reads, satisfying the Linux Consumption caution for identity-based host storage.
4. The Function App only registers HTTP triggers, so host-only storage roles plus diagnostic table support are sufficient.
5. Existing application code that reads WLH category blobs uses `DefaultAzureCredential` and `WLH_STORAGE_ACCOUNT_NAME`, not the `AzureWebJobsStorage` connection string.

## Rollout and validation evidence

PR #246 completed the migration through the normal protected delivery flow for merge commit `677b1adfbe551c48525ef8b11a0722f5515d9989`:

1. PR CI, Policy Check, and Codex Auto-Merge passed.
2. Post-merge `main` CI passed for `677b1adfbe551c48525ef8b11a0722f5515d9989`.
3. `Deploy Test` run `27229870948` succeeded for `677b1adfbe551c48525ef8b11a0722f5515d9989`, including Bicep deployment, Function package deployment, runtime smoke, authenticated smoke, telemetry gate, and release-ledger upload.
4. `Promote Production` run `27229866903` succeeded for `677b1adfbe551c48525ef8b11a0722f5515d9989`, including Bicep deployment, Function package deployment, runtime smoke, authenticated smoke, telemetry gate, and release-ledger upload.

Future validation should still confirm app-setting names and managed-identity role assignments without printing values if an operator changes storage, identity, or hosting configuration manually. Run authenticated smoke against `GET /api/hello` and `POST /api/reddit/thread` whenever this storage identity path is changed again.

## Compensating controls and rollback

- Keep shared-key disablement out of this migration to avoid combining two storage-authentication changes.
- Treat deployment identity role-assignment permissions as a known bootstrap prerequisite: the deployment identity must be able to create/update the Bicep-managed Function App storage role assignments, or the assignments must be pre-provisioned safely.

Rollback is straightforward: restore the `AzureWebJobsStorage` connection string app setting in `infra/main.bicep` and redeploy. Do not roll back by manually pasting storage keys into logs, PRs, issues, or project memory.

## Revisit triggers

Revisit this design if any of the following changes occur:

- The app adds Blob, Queue, Event Hubs, Timer, or Durable triggers/bindings.
- The deployment workflow changes away from external run-from-package packages.
- The project decides to disable storage-account shared-key access.
- The app moves to a sovereign cloud, custom storage DNS, Flex Consumption, Premium, or Dedicated App Service plan.
- Azure Functions changes the documented role requirements for identity-based `AzureWebJobsStorage`.
