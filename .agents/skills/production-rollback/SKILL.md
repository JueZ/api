---
name: production-rollback
description: Use when inspecting, operating, or explaining JueZ/api's bounded automatic rollback inside Delivery v2 after a just-deployed production release fails verification.
---

# Production rollback

Production recovery is part of `.github/workflows/delivery-v2.yml`; there is no separate normal-path rollback workflow.

## Safety contract

- Recovery runs only after the current Delivery v2 release mutated production and then failed verification.
- Before promotion, verify the previous accepted release against its trusted ledger, immutable Function blob version/content, and exact rendered frontend inventory. Download and verify the complete recovery bundle before the first production write. Missing or expired evidence blocks promotion.
- The original bundle must come from a successful first-attempt `Delivery v2` run on protected `main`. Preserve exact repository, source SHA, correlation, artifact, and ledger identities. Track the actual mutation/recovery run separately: restored old bytes do not inherit successful acceptance from their original run.
- Use `/health` as corroboration. When unavailable, resolve installed identity through Azure and immutable package evidence; conflicting identities block mutation.
- After acquiring `production-deployment`, reread installed production state and validate the failed attempt's durable mutation intent. Never replace a newer installed release. Newer main alone does not prohibit restoring the failed package still installed.
- Record `production-unchanged` only when exact package/frontend evidence and mutation history support it. Partial or uncertain configuration changes remain incomplete, even when package restoration verifies successfully.
- If source identity, artifact availability, or candidate selection is missing or ambiguous, stop. Never guess.
- Redeploy once through the same reusable environment workflow, the `production` GitHub environment, Azure OIDC, and `production-deployment` concurrency group.
- Verify exact source and digests, public smoke, authenticated smoke, telemetry correlation, and release ledger after rollback.
- Preserve prewrite intent and phase evidence so a missing final runner receipt does not erase knowledge of possible mutation. Missing or ambiguous phase identity blocks recovery rather than authorizing a guessed restore.
- Never loop between releases, rerun an unchanged failed deployment, execute Bicep during package rollback, or roll back a destructive data migration automatically.
- Never expose credentials, bypass protection, weaken verification, or deploy from a local shell.

## Inspection

Verify live configuration and inspect only the relevant Delivery v2 run:

```bash
gh variable get DEPLOY_PRODUCTION_ENABLED --repo JueZ/api
gh run view <delivery-run-id> --repo JueZ/api \
  --json url,status,conclusion,headSha,jobs
gh run view <delivery-run-id> --repo JueZ/api --log-failed
```

Confirm these jobs and outcomes in the workflow summary:

- `resolve bounded recovery` selected one prior trusted release or intentionally stopped;
- `rollback production once` ran at most once and used the production concurrency group;
- rollback source SHA and Function/frontend/SBOM digests match the selected retained release;
- public and authenticated smoke, telemetry, and release identity passed;
- the repair queue created or updated one sanitized issue for the failed release.

If automatic rollback is blocked or fails, keep the urgent repair issue open and identify the exact blocker before any further mutation. For a proven failed promotion with retained accepted artifacts and the exact failed receipt still installed, Delivery v2 provides an explicit configuration reconciliation mode on current protected main:

```bash
gh workflow run delivery-v2.yml --repo JueZ/api --ref main \
  -f mode=recover-production -f failedRunId=<exact-failed-delivery-run-id>
```

This mode validates the prior run and evidence, acquires the same production lock, checks current main and the exact failed mutation, then reapplies current Bicep and validates runtime policy before restoring and verifying the accepted bundle. It is distinct from automatic package rollback. Configuration becomes accepted only after reconciliation, public/authenticated smoke, telemetry, and the recovery ledger pass. A newer or ambiguous installed mutation blocks this path. Recovery acceptance of an older bundle is not completion of the current feature: subsequently run full Delivery v2 for current main. Do not create an ad hoc standalone rollback controller or retry unchanged failed reconciliation.

## Report

Report the failed delivery SHA and run, whether production was mutated, selected known-good SHA and digest identity, rollback job/result, runtime verification, repair issue, and any ambiguity or unexercised path.
