# willhaben GPT Action (read-only)

Feature-flagged integration for structured read-only willhaben retrieval.

- Disabled by default (`WILLHABEN_ENABLED=false`).
- No buying/contact/reserve/login flows.
- Use only where permitted by willhaben terms/robots; no bypass behavior.
- Structured search only: use `keywords` + typed filters; no `naturalLanguageQuery`.

Workflow: list categories -> get filter schema -> search -> fetch top 3-5 listing details -> show `canonicalUrl`.
