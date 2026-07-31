# Environment isolation

Test and production deploy the same immutable release artifacts into separate resource groups and resource names. Each deployment has separate Function host, release, static-site, private integration storage, Key Vault, Application Insights, and lifecycle policy.

Both environments validate JWTs and exact CORS/MCP origins. `environmentName` is mandatory and `AUTH_ENABLED` is compile-time constrained to true in Bicep.

Bring deliberately uses the same technical account for contract fidelity, with asymmetric policy:

- test: readable allowlisted lists only; add/destructive feature flags must be false;
- production: writes require an explicit UUID in the writable subset, and shared/unlisted lists are denied;
- canary: separate app identity with only `bring.read`; workflow has no mutation call.

No environment shares storage state or Key Vault secrets. Existing WLH reference data must be copied into the environment's private reference container before switching the Function to the split-storage deployment.
