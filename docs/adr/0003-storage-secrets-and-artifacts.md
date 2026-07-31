# ADR 0003: Split storage, Key Vault references, and immutable artifacts

- Status: accepted locally; not yet deployed
- Date: 2026-07-30

## Decision

Use separate Azure Storage accounts for Function host state, immutable release packages, public static content, and private integration state. Disable shared-key authorization and assign data-plane access at the narrowest practical resource/container scope.

Store provider/OpenAI secrets in Key Vault and expose only Key Vault references to the Function App. Build Function/frontend/SBOM artifacts once, hash and attest them, deploy the exact test-proven digests to production, and record them in the release ledger.

## Consequences

Public static access cannot expose private state, deployment writers do not receive broad private-data access, and production provenance becomes test-verifiable. Migration must copy existing private WLH/session data into the new private account before cutover.
