# Quality engineering evidence

This directory is the authoritative, resumable ledger for the JueZ/api Quality 10 program. It separates measured facts from plans and never treats a local pass, merged commit, deployment, or live runtime check as interchangeable evidence.

## Files

- `quality-10-program.md` records the original assessment, current measured baseline, phase status, accepted references, remaining risks, and next exact slice.
- `quality-gates.yml` defines the mandatory machine-evaluated gates for all 15 categories.
- `waivers.yml` is empty by default and contains only narrow, owned, expiring exceptions with linked issue and review evidence.
- `evidence/` contains reproducible local measurements and exact external evidence references.
- `scripts/quality-report.mjs` collects the static baseline or evaluates the gates without an LLM.

## Reproduce the Phase 0 baseline

Use Node.js 22 and the exact source ref recorded in the evidence file:

```bash
npm ci
npm run quality:baseline -- --source-ref 56f4208070ad5777267326f5e2d70e43dd64073c
```

The collector measures production TypeScript, compiler/lint settings, operation schemas, test availability, bundle output, configured supply-chain checks, known operational gaps, and the relevant local deterministic commands. It does not use repository credentials or an LLM.

## Evaluate gates

```bash
npm run quality:check
```

The command writes `.quality-report/quality-report.json` and `.quality-report/quality-report.md`. It exits nonzero while any required gate lacks evidence or fails. This is expected until the ordered program phases supply and accept every mandatory result.

Generated coverage, mutation, browser, accessibility, bundle, benchmark, contract, observability, documentation, and CI-control JSON files are consumed when present at the paths declared in `quality-gates.yml`. Missing files are failures, not implicit skips.

## Evidence levels

1. Local evidence proves only the stated command on the stated source tree.
2. PR evidence proves exact-head CI, policy, security scanning, and review.
3. Main evidence proves the exact merged commit and immutable build.
4. Deployment evidence proves a particular environment accepted a particular artifact.
5. Smoke, telemetry, ledger, and runtime-truth evidence prove the deployed runtime behaved as claimed.

No category is eligible for 10/10 unless all its required assertions pass and no active waiver replaces a failed assertion.
