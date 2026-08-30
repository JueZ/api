<!-- project-memory-asOf: 2026-08-30 -->
# Known issues and unresolved risks

- The official Codex GitHub integration supports review triggers but not an unattended implementation callback. The initiating task monitors and repairs while it can; unfinished requirements remain deduplicated active `codex-repair` continuations carrying the next discriminating action and resume condition. Later applicable unblocked repository work resumes them, while external blockers remain open without freezing unrelated safe work.
- GitHub Actions records `30663819848` and `30693764586` are obsolete queued zero-job remnants that GitHub returned server errors when asked to cancel. They cannot execute repository code; leave them alone unless GitHub provides a safe cleanup path.
- Test Bring remains disabled pending reviewed private/session-data inventory, backup, migration, digest/access verification, and rollback readiness. The optional canary must remain GET-only with a dedicated `bring.read` identity and allowlisted list.
- Any Bring mutation record created before integrity format v2 is intentionally non-replayable because its principal pseudonym was not tenant-bound. Keep it for lifecycle/audit retention; after a legacy rejection, re-read the list and use a fresh operation ID only after explicitly confirming that another mutation is still needed.
- The Angular production bundle still exceeds its warning threshold. This is a non-fatal optimization item.
- Reddit short-share retrieval can be provider-blocked, and large threads are intentionally bounded/partial. Add distributed quota or asynchronous export only if telemetry demonstrates a need.
- Automatic rollback has deterministic and test-environment coverage. A deliberate live production-failure rollback canary has not been exercised and must not be manufactured merely for evidence.
