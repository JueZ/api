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

Bring registers separate prepare and apply entries for complete and remove, with distinct `bring.complete` and `bring.remove` permissions even though the operations share REST routes. The handler authenticates the caller before reading the bounded body, parses the requested/confirmed operation, then authorizes the matching registry entry.

MCP exposes Bring reads, `bring_add_item`, `bring_complete_item`, and `bring_remove_item`. Add requires `bring.write` and supports authorized user or service tokens. Complete/remove require delegated user tokens and their respective destructive permission. Each destructive MCP tool prepares on the first call and selects its apply registry entry when the caller repeats the identical request with the returned confirmation token. Both phases authorize their selected registry entry and use the shared Bring mutation service, preserving writable-list restrictions, exact-item checks, version validation, durable operation UUIDs, and principal/payload binding. Writes are allowed only in local and production environments; test remains read-only. The catalogue names destructive MCP tools on their prepare entries; this does not mean the tools lack an apply phase.

The generated [operation catalogue](operation-catalogue.md) must stay synchronized through `npm run docs:check-operations`.
