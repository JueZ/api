# Quality evidence archive

Evidence in this directory is public-safe and source-bound. It must not contain secrets, tokens, private URLs, raw environment dumps, private list content, raw upstream bodies, or sensitive identifiers.

Current artifacts:

- `phase-0-baseline.json` — deterministic repository and local-command measurements for protected main `56f4208070ad5777267326f5e2d70e43dd64073c`.
- `protected-main-56f420.json` — exact GitHub PR, branch-protection, CI, review, delivery, smoke, telemetry, and runtime-truth references inspected read-only on 2026-08-02.
- `quality-report.json` and `quality-report.md` — the Phase 0 gate result. Failure is intentional because most mandatory phase evidence does not exist yet.

Later phase evidence must retain exact commit and run provenance. A successful local command must never be relabelled as accepted CI, deployment, telemetry, or runtime evidence.
