# Project memory

Project memory contains only current durable facts, active risks, and actionable next steps. It is not the agent rulebook, a secret store, or a workflow history ledger.

For non-trivial work, read `current-state.md` first. Read `known-issues.md` or `next-steps.md` only when relevant. Read the focused ADR when architectural rationale matters. Query live GitHub, Azure, and runtime state before making a current claim.

Update these files in the substantive protected PR when architecture, security, delivery behavior, cloud configuration, a durable blocker, or the next action materially changes. Remove superseded facts instead of appending chronology. Git history, PRs, issues, Actions runs, deployments, and bounded workflow artifacts retain execution history.

Never store secrets, tokens, authorization headers, SAS URLs, connection strings, private keys, full settings/environment dumps, raw logs, model transcripts, or private provider content here. Never open a follow-up PR solely to copy workflow IDs or terminal evidence.
