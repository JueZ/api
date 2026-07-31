#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateReleaseLedger } from './validate-release-ledger.mjs';
import { fetchJson } from './lib/smoke-utils.mjs';

const SHA_RE = /\b[0-9a-f]{40}\b/gi;
const RUN_URL_RE = /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/actions\/runs\/(\d+)/g;

export function parseRepairIssueBody(body = '') {
  const prNumbers = [...body.matchAll(/(?:PR|pull request|pull\/)(?:\s*#|\/)?(\d+)/gi)].map((m) => Number(m[1]));
  const workflowRunMatches = [...body.matchAll(RUN_URL_RE)];
  const workflowRunUrls = workflowRunMatches.map((m) => m[0]);
  const workflowRunIds = workflowRunMatches.map((m) => m[3]);
  const commitShas = [...body.matchAll(SHA_RE)].map((m) => m[0].toLowerCase());
  const lower = body.toLowerCase();
  const environment =
    lower.includes('production') || lower.includes('prod') ? 'prod' : lower.includes('test') ? 'test' : '';
  const productionFailure = /production|prod|promote-production|smoke|\/health|runtime|deploy/i.test(body);
  return {
    prNumbers: [...new Set(prNumbers)],
    workflowRunUrls: [...new Set(workflowRunUrls)],
    workflowRunIds: [...new Set(workflowRunIds)],
    commitShas: [...new Set(commitShas)],
    environment,
    productionFailure,
  };
}

export function classifyRepairIssue(issue, parsed = parseRepairIssueBody(issue?.body || '')) {
  const labels = (issue?.labels || [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean)
    .map((label) => label.toLowerCase());
  const text = `${issue?.title || ''}\n${issue?.body || ''}\n${labels.join(' ')}`.toLowerCase();
  if (/production|prod|promote-production|smoke|\/health|runtime/.test(text) || labels.includes('production-failure'))
    return 'production_failure';
  if (/deploy|deployment|deploy-test|azure/.test(text)) return 'deployment_failure';
  if (/ci|check|policy|lint|test|workflow/.test(text) || parsed.prNumbers.length > 0) return 'pr_check_failure';
  return 'unknown_codex_repair';
}

export function triageMarker(issueNumber, decisionKind) {
  return `<!-- codex-repair-triage:${issueNumber}:${decisionKind} -->`;
}

export function hasDuplicateTriageComment(comments = [], issueNumber, decisionKind, reason = '') {
  const marker = triageMarker(issueNumber, decisionKind);
  return comments.some(
    (comment) =>
      String(comment.body || '').includes(marker) && (!reason || String(comment.body || '').includes(reason)),
  );
}

function prEvidenceComplete(prStates = []) {
  return (
    prStates.some((pr) => pr.merged === true || pr.state === 'MERGED') &&
    prStates.some(
      (pr) => pr.checksPassed === true || pr.statusCheckRollup?.some?.((check) => check.conclusion === 'SUCCESS'),
    )
  );
}

export function productionVerificationPassed(verification = {}, options = {}) {
  const ledger = verification.ledger;
  if (!ledger) return { ok: false, reason: 'missing production release ledger evidence' };
  const validationErrors =
    verification.validationErrors ||
    validateReleaseLedger(ledger, {
      expectedDeliveryCorrelation: verification.expectedDeliveryCorrelation,
    });
  if (validationErrors.length > 0)
    return { ok: false, reason: `release ledger validation failed: ${validationErrors.join('; ')}` };
  if (verification.workflowConclusion && verification.workflowConclusion !== 'success')
    return { ok: false, reason: `Promote Production run conclusion is ${verification.workflowConclusion}` };
  if (verification.workflowRunId && ledger.workflowRunId !== verification.workflowRunId)
    return { ok: false, reason: 'release ledger workflowRunId does not match the inspected production run' };
  if (
    verification.workflowHeadSha &&
    (ledger.deployedCommit !== verification.workflowHeadSha || ledger.sourceRef !== verification.workflowHeadSha)
  ) {
    return { ok: false, reason: 'release ledger source does not match the inspected production run head SHA' };
  }
  if (
    verification.expectedDeliveryCorrelation &&
    ledger.deliveryCorrelation !== verification.expectedDeliveryCorrelation
  ) {
    return { ok: false, reason: 'release ledger deliveryCorrelation does not match the inspected production run' };
  }
  if (ledger.environment !== 'prod')
    return { ok: false, reason: `release ledger environment is ${ledger.environment}` };
  if (ledger.smokeResults?.status !== 'passed')
    return { ok: false, reason: `runtime smoke status is ${ledger.smokeResults?.status || '<missing>'}` };
  if (ledger.authenticatedSmokeResults?.status !== 'passed')
    return {
      ok: false,
      reason: `authenticated smoke status is ${ledger.authenticatedSmokeResults?.status || '<missing>'}`,
    };
  if (
    ledger.telemetryCheckResult?.status !== 'passed' &&
    !(options.acceptBlockedTelemetry === true && ledger.telemetryCheckResult?.status === 'blocked_telemetry')
  )
    return { ok: false, reason: `telemetry status is ${ledger.telemetryCheckResult?.status || '<missing>'}` };
  if (verification.liveHealth?.deployedCommitSha && verification.liveHealth.deployedCommitSha !== ledger.deployedCommit)
    return {
      ok: false,
      reason: `live /health SHA ${verification.liveHealth.deployedCommitSha} does not match ledger ${ledger.deployedCommit}`,
    };
  return { ok: true, reason: `production verified for ${ledger.deployedCommit}` };
}

export function decideRepairIssueAction(issue, evidence = {}) {
  const parsed = evidence.parsed || parseRepairIssueBody(issue?.body || '');
  const issueType = evidence.issueType || classifyRepairIssue(issue, parsed);
  if (issueType === 'pr_check_failure') {
    if (prEvidenceComplete(evidence.prStates || []) && !evidence.laterProductionFailure)
      return {
        action: 'close',
        decisionKind: 'resolved-pr-check',
        issueType,
        reason: 'referenced PR merged and CI/policy evidence succeeded with no later linked production failure',
      };
    return {
      action: 'comment',
      decisionKind: 'evidence-needed',
      issueType,
      reason: 'PR-check repair evidence is incomplete or a later production failure is linked',
    };
  }
  if (issueType === 'production_failure' || issueType === 'deployment_failure') {
    const verified = productionVerificationPassed(evidence.productionVerification || {}, {
      acceptBlockedTelemetry: evidence.acceptBlockedTelemetry,
    });
    if (verified.ok)
      return { action: 'close', decisionKind: 'resolved-production-verification', issueType, reason: verified.reason };
    return { action: 'comment', decisionKind: 'production-evidence-needed', issueType, reason: verified.reason };
  }
  return {
    action: 'comment',
    decisionKind: 'unknown-evidence-needed',
    issueType,
    reason: 'codex-repair issue type is unknown; leaving open until resolution evidence is explicit',
  };
}

function gh(args) {
  const completed = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${completed.stderr}`);
  return completed.stdout;
}

async function findJsonFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findJsonFile(path);
      if (nested) return nested;
    } else if (entry.name.endsWith('.json')) return path;
  }
  return '';
}

async function collectLatestProductionVerification({ repo, apiBaseUrl = '', requireLedger = true }) {
  const runs = JSON.parse(
    gh([
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      'promote-production.yml',
      '--branch',
      'main',
      '--status',
      'success',
      '--limit',
      '20',
      '--json',
      'databaseId,headSha,conclusion,status,displayTitle,attempt',
    ]),
  );
  for (const run of runs) {
    const sha = String(run.headSha || '').toLowerCase();
    if (!sha) continue;
    if (run.attempt !== 1) continue;
    const titleMatch = String(run.displayTitle || '').match(
      /^Promote Production ([0-9a-f]{40}) ([A-Za-z0-9][A-Za-z0-9._-]{7,127})$/,
    );
    const expectedDeliveryCorrelation = titleMatch?.[2] || '';
    if (!expectedDeliveryCorrelation || titleMatch?.[1] !== sha) continue;
    const artifactName = `release-ledger-prod-${sha}-${expectedDeliveryCorrelation}`;
    const dir = await mkdtemp(join(tmpdir(), 'repair-triage-ledger-'));
    try {
      gh(['run', 'download', String(run.databaseId), '--repo', repo, '--name', artifactName, '--dir', dir]);
      const ledgerPath = await findJsonFile(dir);
      if (!ledgerPath) continue;
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      const validationErrors = [...validateReleaseLedger(ledger, { expectedDeliveryCorrelation })];
      let liveHealth;
      if (apiBaseUrl) {
        try {
          const health = await fetchJson(`${apiBaseUrl.replace(/\/$/, '')}/health`);
          liveHealth = health.json || undefined;
        } catch {
          /* best effort */
        }
      }
      return {
        workflowRunId: String(run.databaseId),
        workflowConclusion: run.conclusion,
        workflowHeadSha: sha,
        expectedDeliveryCorrelation,
        artifactName,
        ledger,
        validationErrors,
        liveHealth,
      };
    } catch {
      if (!requireLedger) return { workflowRunId: String(run.databaseId), workflowConclusion: run.conclusion };
    }
  }
  return { missing: true };
}

async function collectPrStates(parsed, repo) {
  const states = [];
  for (const number of parsed.prNumbers) {
    try {
      const pr = JSON.parse(
        gh([
          'pr',
          'view',
          String(number),
          '--repo',
          repo,
          '--json',
          'number,state,merged,mergeCommit,statusCheckRollup,url',
        ]),
      );
      pr.checksPassed =
        (pr.statusCheckRollup || []).length > 0 &&
        (pr.statusCheckRollup || []).every((check) => check.conclusion === 'SUCCESS' || check.conclusion === 'SKIPPED');
      states.push(pr);
    } catch {
      /* best effort */
    }
  }
  return states;
}

function commentBody(issue, decision, evidence) {
  return `${triageMarker(issue.number, decision.decisionKind)}\nCodex repair triage: ${decision.reason}.\n\nEvidence summary:\n- Issue type: ${decision.issueType}\n- PRs referenced: ${(evidence.parsed.prNumbers || []).join(', ') || 'none'}\n- Workflow runs referenced: ${(evidence.parsed.workflowRunIds || []).join(', ') || 'none'}\n- Commits referenced: ${(evidence.parsed.commitShas || []).join(', ') || 'none'}\n- Production verification run: ${evidence.productionVerification?.workflowRunId || 'not found'}\n- Release ledger artifact: ${evidence.productionVerification?.artifactName || 'not found'}\n- Dry run: ${evidence.dryRun}\nChecked ${new Date().toISOString()}.`;
}

export async function runRepairTriage({ env = process.env } = {}) {
  const repo = env.GITHUB_REPOSITORY || 'JueZ/api';
  const dryRun = env.DRY_RUN !== 'false';
  const closeResolved = env.REPAIR_TRIAGE_CLOSE_RESOLVED === 'true';
  const requireLedger = env.REPAIR_TRIAGE_REQUIRE_LEDGER_FOR_PROD !== 'false';
  const apiBaseUrl = env.API_BASE_URL || '';
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      'codex-repair',
      '--state',
      'open',
      '--json',
      'number,title,body,url,labels',
    ]),
  );
  const productionVerification = await collectLatestProductionVerification({ repo, apiBaseUrl, requireLedger });
  const results = [];
  for (const issue of issues) {
    const parsed = parseRepairIssueBody(issue.body || '');
    const prStates = await collectPrStates(parsed, repo);
    const evidence = {
      parsed,
      issueType: classifyRepairIssue(issue, parsed),
      prStates,
      productionVerification,
      dryRun,
    };
    const decision = decideRepairIssueAction(issue, evidence);
    const body = commentBody(issue, decision, evidence);
    console.log(`${dryRun ? '[dry-run] ' : ''}#${issue.number}: ${decision.action} (${decision.reason})`);
    if (!dryRun) {
      const comments =
        JSON.parse(gh(['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments'])).comments || [];
      if (!hasDuplicateTriageComment(comments, issue.number, decision.decisionKind, decision.reason))
        gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', body]);
      if (decision.action === 'close' && closeResolved)
        gh([
          'issue',
          'close',
          String(issue.number),
          '--repo',
          repo,
          '--comment',
          `Closing after evidence-based Codex repair triage: ${decision.reason}.`,
        ]);
    }
    results.push({ issue: issue.number, decision });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runRepairTriage();
}
