# Identity and permission matrix

| Identity                    | Trust mechanism                                           | Allowed capability                                                                                                        |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Delegated operator          | Entra JWT plus tenant/client/user allowlists              | All explicitly granted read permissions; Bring destructive permissions only when granted and confirmed                    |
| Service API client          | Entra app-only JWT plus explicit client/object allowlists | Granted reads and non-destructive writes; never `bring.complete` or `bring.remove`                                        |
| Bring canary client         | GitHub OIDC federated to dedicated Entra app              | `bring.read` only in test                                                                                                 |
| GitHub deployment identity  | GitHub OIDC to Azure                                      | Resource-group deployment plus narrowly scoped artifact/static/reference writes and documented role assignments           |
| Function system identity    | Azure managed identity                                    | Host runtime storage, release reads, WLH reference reads, Bring session/mutation/audit containers, Key Vault secret reads |
| Autonomous merge controller | Trusted `pull_request_target` workflow and `GITHUB_TOKEN` | Read PR/check state, publish exact-head review check, squash exact reviewed SHA after all gates                           |

Standing Azure access must be resource-group or resource/container scoped. No long-lived Azure client secret is part of the normal design.
