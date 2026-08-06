# Operation model

Every callable capability declares:

- stable operation ID and provider;
- read, write, or destructive effect;
- required granular permission;
- allowed user/service token types;
- allowed environments;
- input/output schema ownership;
- idempotency and confirmation policy;
- audit metadata policy;
- optional REST and MCP transport names.

The registry is consumed by REST authorization, MCP OAuth descriptors/challenges, deterministic agent evals, documentation generation, and architecture checks. Provider or transport names are not authorization policy.

Bring uses two logical registry entries for each destructive operation because complete/remove require different permissions even though they share REST routes. The handler authenticates the caller before reading the bounded body, parses the requested/confirmed operation, then authorizes the matching registry entry. MCP exposes Bring reads and idempotent add only; complete/remove remain on the operator-reviewed REST/web path.

The generated [operation catalogue](operation-catalogue.md) must stay synchronized through `npm run docs:check-operations`.
