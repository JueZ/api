# Identity and permission matrix

| Identity                   | Trust mechanism                                           | Allowed capability                                                                                                                    |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Delegated operator         | Entra JWT plus tenant/client/user allowlists              | All explicitly granted read permissions; Bring destructive permissions only when granted and confirmed                                |
| Service API client         | Entra app-only JWT plus explicit client/object allowlists | Granted reads and non-destructive writes; never `bring.complete` or `bring.remove`                                                    |
| Bring canary client        | GitHub OIDC federated to dedicated Entra app              | `bring.read` only in test                                                                                                             |
| GitHub deployment identity | GitHub OIDC to Azure                                      | Resource-group deployment plus narrowly scoped artifact/static/reference writes and documented role assignments                       |
| Function system identity   | Azure managed identity                                    | Host runtime storage, release reads, WLH reference reads, Bring session/mutation/audit containers, Key Vault secret reads             |
| GitHub native auto-merge   | Protected branch rules and exact-head squash auto-merge   | Merge the approved candidate only after required `PR Gate` and `Security Gate` checks from GitHub Actions and branch protections pass |

Standing Azure access must be resource-group or resource/container scoped. No long-lived Azure client secret is part of the normal design.

The repository uses native auto-merge; no custom merge controller, check-run writer, or required model review participates. See [autonomous delivery](../autonomous-delivery.md) for the protected delivery contract. This matrix describes repository policy; inspect live GitHub settings before claiming its current enforcement.
