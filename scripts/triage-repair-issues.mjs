#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateReleaseLedger } from './validate-release-ledger.mjs';
import { fetchJson } from './lib/smoke-utils.mjs';
import { loadAutonomousPolicy, STABLE_REQUIRED_CHECKS } from './lib/autonomous-policy.mjs';
import {
  LEARNING_LABELS,
  buildLearningLinkComment,
  createFailureFingerprint,
  gateRepairClosure,
  learningCandidateMarker,
  learningLinkMarker,
  planLearningCandidate,
  requiresLearningDisposition,
} from './agent-learning/failure-triage.mjs';

const SHA_RE = /\b[0-9a-f]{40}\b/gi;
const RUN_URL_RE = /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/actions\/runs\/(\d+)/g;
const MAX_UNTRUSTED_BODY_CHARACTERS = 65_536;
const MAX_EXTRACTED_REFERENCES = 20;

export function parseRepairIssueBody(body = '') {
  const input = String(body || '');
  const boundedBody = input.slice(0, MAX_UNTRUSTED_BODY_CHARACTERS);
  const prNumbers = [...boundedBody.matchAll(/(?:PR|pull request|pull\/)(?:\s*#|\/)?(\d+)/gi)].map((m) => Number(m[1]));
  const workflowRunMatches = [...boundedBody.matchAll(RUN_URL_RE)];
  const workflowRunUrls = workflowRunMatches.map((m) => m[0]);
  const workflowRunIds = workflowRunMatches.map((m) => m[3]);
  const commitShas = [...boundedBody.matchAll(SHA_RE)].map((m) => m[0].toLowerCase());
  const lower = boundedBody.toLowerCase();
  const environment =
    lower.includes('production') || lower.includes('prod') ? 'prod' : lower.includes('test') ? 'test' : '';
  const productionFailure = /production|prod|promote-production|smoke|\/health|runtime|deploy/i.test(boundedBody);
  return {
    prNumbers: [...new Set(prNumbers)].slice(0, MAX_EXTRACTED_REFERENCES),
    workflowRunUrls: [...new Set(workflowRunUrls)].slice(0, MAX_EXTRACTED_REFERENCES),
    workflowRunIds: [...new Set(workflowRunIds)].slice(0, MAX_EXTRACTED_REFERENCES),
    commitShas: [...new Set(commitShas)].slice(0, MAX_EXTRACTED_REFERENCES),
    environment,
    productionFailure,
    truncated: input.length > boundedBody.length,
  };
}

export function classifyRepairIssue(issue, parsed = parseRepairIssueBody(issue?.body || '')) {
  const labels = (issue?.labels || [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean)
    .map((label) => label.toLowerCase());
  const text =
    `${issue?.title || ''}\n${String(issue?.body || '').slice(0, MAX_UNTRUSTED_BODY_CHARACTERS)}\n${labels.join(' ')}`.toLowerCase();
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
  return prStates.some((pr) => (pr.merged === true || pr.state === 'MERGED') && pr.checksPassed === true);
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
  if (parsed.truncated) {
    return {
      action: 'comment',
      decisionKind: 'untrusted-input-bounds',
      issueType,
      reason: 'issue body exceeds the bounded triage input size and requires explicit maintainer evidence',
    };
  }
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

function defaultGh(args) {
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

async function collectLatestProductionVerification({ repo, apiBaseUrl = '', requireLedger = true, ghCommand }) {
  const runs = JSON.parse(
    ghCommand([
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
      ghCommand(['run', 'download', String(run.databaseId), '--repo', repo, '--name', artifactName, '--dir', dir]);
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { missing: true };
}

async function collectPrStates(parsed, repo, ghCommand) {
  const states = [];
  for (const number of parsed.prNumbers) {
    try {
      const pr = JSON.parse(
        ghCommand([
          'pr',
          'view',
          String(number),
          '--repo',
          repo,
          '--json',
          'number,state,merged,mergeCommit,statusCheckRollup,url',
        ]),
      );
      const successfulCheckNames = new Set(
        (pr.statusCheckRollup || [])
          .filter((check) => check.conclusion === 'SUCCESS')
          .map((check) => check.name || check.context)
          .filter(Boolean),
      );
      pr.checksPassed = STABLE_REQUIRED_CHECKS.every((check) => successfulCheckNames.has(check.name));
      states.push(pr);
    } catch {
      /* best effort */
    }
  }
  return states;
}

function commentBody(issue, decision, evidence, checkedAt) {
  return `${triageMarker(issue.number, decision.decisionKind)}\nCodex repair triage: ${decision.reason}.\n\nEvidence summary:\n- Issue type: ${decision.issueType}\n- PRs referenced: ${(evidence.parsed.prNumbers || []).join(', ') || 'none'}\n- Workflow runs referenced: ${(evidence.parsed.workflowRunIds || []).join(', ') || 'none'}\n- Commits referenced: ${(evidence.parsed.commitShas || []).join(', ') || 'none'}\n- Production verification run: ${evidence.productionVerification?.workflowRunId || 'not found'}\n- Release ledger artifact: ${evidence.productionVerification?.artifactName || 'not found'}\n- Learning coverage: ${evidence.learningCoverage?.kind || 'not established'}\n- Dry run: ${evidence.dryRun}\nChecked ${checkedAt}.`;
}

function positiveIssueNumber(value) {
  return /^\d+$/.test(String(value || '')) && Number(value) > 0 && Number.isSafeInteger(Number(value));
}

export function parseBackfillRange(startValue, endValue) {
  if (!positiveIssueNumber(startValue) || !positiveIssueNumber(endValue)) {
    throw new Error(
      'Backfill requires exact positive AGENT_LEARNING_BACKFILL_START and AGENT_LEARNING_BACKFILL_END values.',
    );
  }
  const start = Number(startValue);
  const end = Number(endValue);
  if (start > end) throw new Error('Backfill issue range start must not exceed the end.');
  if (end - start + 1 > 100) throw new Error('Backfill issue range may contain at most 100 exact issue numbers.');
  return { start, end };
}

export function issueAfterRollout(issue, rolloutTimestamp) {
  const rolloutTime = Date.parse(rolloutTimestamp);
  const issueTime = Date.parse(issue?.createdAt || '');
  if (!Number.isFinite(rolloutTime)) throw new Error('agentLearning.rolloutTimestamp must be a valid timestamp.');
  return Number.isFinite(issueTime) && issueTime >= rolloutTime;
}

function hasLabel(issue, name) {
  return (issue?.labels || []).some((label) => (typeof label === 'string' ? label : label?.name) === name);
}

function learningCommentIsTrusted(comment) {
  const association = String(comment?.authorAssociation || '').toUpperCase();
  const login = String(comment?.author?.login || '');
  return (
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association) ||
    ['github-actions', 'github-actions[bot]'].includes(login)
  );
}

function loadIssueComments(issueNumber, repo, ghCommand) {
  const pages = JSON.parse(
    ghCommand(['api', '--paginate', '--slurp', `repos/${repo}/issues/${Number(issueNumber)}/comments?per_page=100`]),
  );
  return pages.flat().map((comment) => ({
    body: comment.body,
    createdAt: comment.created_at,
    authorAssociation: comment.author_association,
    author: { login: comment.user?.login || '' },
  }));
}

function listCandidateIssues(repo, ghCommand) {
  return JSON.parse(
    ghCommand([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,title,body,url,labels,author',
    ]),
  ).filter(
    (issue) =>
      hasLabel(issue, 'agent-learning') && String(issue.body || '').includes('<!-- agent-learning-candidate:v1:'),
  );
}

function hydrateCandidateComments(candidateIssues, fingerprint, repo, ghCommand) {
  const marker = learningCandidateMarker(fingerprint);
  for (const issue of candidateIssues) {
    if (!String(issue.body || '').includes(marker) || Array.isArray(issue.comments)) continue;
    issue.comments = loadIssueComments(issue.number, repo, ghCommand);
  }
}

function listRepairIssues({ repo, backfillRange, rolloutTimestamp, ghCommand }) {
  if (backfillRange) {
    const issues = [];
    for (let number = backfillRange.start; number <= backfillRange.end; number += 1) {
      const apiIssue = JSON.parse(ghCommand(['api', `repos/${repo}/issues/${number}`]));
      if (apiIssue.pull_request) continue;
      const issue = {
        number: apiIssue.number,
        title: apiIssue.title,
        body: apiIssue.body,
        url: apiIssue.html_url,
        labels: apiIssue.labels,
        createdAt: apiIssue.created_at,
        state: String(apiIssue.state || '').toUpperCase(),
      };
      if (hasLabel(issue, 'codex-repair')) issues.push(issue);
    }
    return issues;
  }

  return JSON.parse(
    ghCommand([
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      'codex-repair',
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,title,body,url,labels,createdAt,state',
    ]),
  ).filter((issue) => issueAfterRollout(issue, rolloutTimestamp));
}

function ensureLearningLabels(repo, ghCommand) {
  const existing = new Set(
    JSON.parse(ghCommand(['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name'])).map(
      (label) => label.name,
    ),
  );
  for (const label of LEARNING_LABELS) {
    if (existing.has(label.name)) continue;
    ghCommand([
      'label',
      'create',
      label.name,
      '--repo',
      repo,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
    existing.add(label.name);
  }
}

function addMissingLabels(issue, labels, repo, ghCommand) {
  const existing = new Set(
    (issue?.labels || []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean),
  );
  const missing = labels.filter((label) => !existing.has(label));
  if (missing.length === 0) return;
  const args = ['issue', 'edit', String(issue.number), '--repo', repo];
  for (const label of missing) args.push('--add-label', label);
  ghCommand(args);
  issue.labels = [...existing, ...missing];
}

function createdIssueNumber(output) {
  const match = String(output || '')
    .trim()
    .match(/\/issues\/(\d+)$/);
  if (!match) throw new Error('GitHub did not return the created learning issue URL.');
  return Number(match[1]);
}

function linkAlreadyPresent(comments, fingerprint, candidateNumber) {
  const marker = learningLinkMarker(fingerprint, candidateNumber);
  return comments.some((comment) => learningCommentIsTrusted(comment) && String(comment.body || '').includes(marker));
}

function applyLearningPlan({ plan, issue, comments, candidateIssues, repo, dryRun, ghCommand, ensureLabels }) {
  if (plan.action === 'blocked') return { coverage: plan.coverage, plan };
  if (plan.action === 'disposition') {
    if (!dryRun) {
      ensureLabels();
      addMissingLabels(issue, plan.labels, repo, ghCommand);
    }
    return { coverage: plan.coverage, plan };
  }

  let candidateNumber = plan.coverage?.candidateNumber;
  let candidateIssue = candidateIssues.find((candidate) => Number(candidate.number) === Number(candidateNumber));
  if (plan.action === 'create') {
    if (dryRun) {
      candidateNumber = Number.MAX_SAFE_INTEGER - candidateIssues.length;
      candidateIssue = {
        number: candidateNumber,
        url: '',
        body: plan.body,
        labels: [...plan.labels],
        comments: [],
        dryRun: true,
      };
      candidateIssues.push(candidateIssue);
    } else {
      ensureLabels();
      const args = ['issue', 'create', '--repo', repo, '--title', plan.title, '--body', plan.body];
      for (const label of plan.labels) args.push('--label', label);
      const output = ghCommand(args);
      candidateNumber = createdIssueNumber(output);
      candidateIssue = {
        number: candidateNumber,
        url: `https://github.com/${repo}/issues/${candidateNumber}`,
        body: plan.body,
        labels: [...plan.labels],
        comments: [],
      };
      candidateIssues.push(candidateIssue);
    }
  } else if (plan.action === 'append') {
    if (dryRun) {
      candidateIssue.comments ||= [];
      candidateIssue.comments.push({
        body: plan.comment,
        author: { login: 'github-actions[bot]' },
        authorAssociation: 'NONE',
      });
    } else {
      ensureLabels();
      ghCommand(['issue', 'comment', String(candidateNumber), '--repo', repo, '--body', plan.comment]);
      candidateIssue.comments ||= [];
      candidateIssue.comments.push({
        body: plan.comment,
        author: { login: 'github-actions[bot]' },
        authorAssociation: 'NONE',
      });
      addMissingLabels(candidateIssue, plan.labels, repo, ghCommand);
    }
  } else if (plan.action === 'existing' && !dryRun) {
    ensureLabels();
    addMissingLabels(candidateIssue, plan.labels, repo, ghCommand);
  }

  if (dryRun) {
    return {
      coverage: { valid: true, kind: 'planned-candidate', fingerprint: plan.fingerprint },
      plan: { ...plan, candidateNumber: undefined },
    };
  }

  if (candidateNumber && !linkAlreadyPresent(comments, plan.fingerprint, candidateNumber)) {
    const link = buildLearningLinkComment({ repository: repo, fingerprint: plan.fingerprint, candidateNumber });
    ghCommand(['issue', 'comment', String(issue.number), '--repo', repo, '--body', link]);
    comments.push({ body: link, author: { login: 'github-actions[bot]' }, authorAssociation: 'NONE' });
  }
  return {
    coverage: candidateNumber
      ? { valid: true, kind: 'candidate', fingerprint: plan.fingerprint, candidateNumber }
      : plan.coverage,
    plan: { ...plan, candidateNumber },
  };
}

export async function runRepairTriage({
  env = process.env,
  ghCommand = defaultGh,
  now = new Date(),
  policy = loadAutonomousPolicy(),
  productionVerificationProvider = collectLatestProductionVerification,
  logger = console,
} = {}) {
  const repo = env.GITHUB_REPOSITORY || 'JueZ/api';
  const dryRun = env.DRY_RUN !== 'false';
  const closeResolved = env.REPAIR_TRIAGE_CLOSE_RESOLVED === 'true';
  const requireLedger = env.REPAIR_TRIAGE_REQUIRE_LEDGER_FOR_PROD !== 'false';
  const apiBaseUrl = env.API_BASE_URL || '';
  const backfillRange =
    env.AGENT_LEARNING_BACKFILL === 'true'
      ? parseBackfillRange(env.AGENT_LEARNING_BACKFILL_START, env.AGENT_LEARNING_BACKFILL_END)
      : undefined;
  const rolloutTimestamp = policy.agentLearning?.rolloutTimestamp;
  let labelsEnsured = false;
  const ensureLabels = () => {
    if (labelsEnsured) return;
    ensureLearningLabels(repo, ghCommand);
    labelsEnsured = true;
  };
  const issues = listRepairIssues({ repo, backfillRange, rolloutTimestamp, ghCommand });
  if (!dryRun) ensureLabels();
  if (issues.length === 0) return [];

  const issueClassifications = new Map(
    issues.map((issue) => {
      const parsed = parseRepairIssueBody(issue.body || '');
      return [issue.number, { parsed, issueType: classifyRepairIssue(issue, parsed) }];
    }),
  );
  const needsProductionEvidence = [...issueClassifications.values()].some(({ issueType }) =>
    ['production_failure', 'deployment_failure'].includes(issueType),
  );
  const productionVerification = needsProductionEvidence
    ? await productionVerificationProvider({ repo, apiBaseUrl, requireLedger, ghCommand })
    : { notApplicable: true };
  const candidateIssues = listCandidateIssues(repo, ghCommand);

  const results = [];
  for (const issue of issues) {
    const { parsed, issueType } = issueClassifications.get(issue.number);
    const prStates = await collectPrStates(parsed, repo, ghCommand);
    const evidence = { parsed, issueType, prStates, productionVerification, dryRun };
    const operationalDecision = decideRepairIssueAction(issue, evidence);
    const comments = loadIssueComments(issue.number, repo, ghCommand);
    let learningResult = { coverage: { valid: false, kind: 'not-required-yet' } };
    const significant = requiresLearningDisposition({
      sourceType: 'repair_issue',
      classification: issueType,
      labels: issue.labels,
    });

    if (operationalDecision.action === 'close' && significant.required) {
      const fingerprint = createFailureFingerprint({ sourceType: 'repair_issue', classification: issueType });
      hydrateCandidateComments(candidateIssues, fingerprint, repo, ghCommand);
      const plan = planLearningCandidate({
        repository: repo,
        sourceIssue: issue,
        classification: issueType,
        candidateIssues,
        comments,
        asOf: now.toISOString().slice(0, 10),
      });
      learningResult = applyLearningPlan({
        plan,
        issue,
        comments,
        candidateIssues,
        repo,
        dryRun,
        ghCommand,
        ensureLabels,
      });
    }

    evidence.learningCoverage = learningResult.coverage;
    const decision = gateRepairClosure(operationalDecision, learningResult.coverage);
    const body = commentBody(issue, decision, evidence, now.toISOString());
    logger.log(
      `${dryRun ? '[dry-run] ' : ''}#${issue.number}: ${decision.action} (${decision.reason}); learning=${learningResult.plan?.action || learningResult.coverage.kind}`,
    );
    if (!dryRun) {
      if (!hasDuplicateTriageComment(comments, issue.number, decision.decisionKind, decision.reason)) {
        ghCommand(['issue', 'comment', String(issue.number), '--repo', repo, '--body', body]);
      }
      if (decision.action === 'close' && closeResolved && issue.state !== 'CLOSED') {
        ghCommand([
          'issue',
          'close',
          String(issue.number),
          '--repo',
          repo,
          '--comment',
          `Closing after evidence-based Codex repair triage: ${decision.reason}.`,
        ]);
      }
    }
    results.push({
      issue: issue.number,
      decision,
      operationalDecision,
      learning: learningResult.plan,
      learningCoverage: learningResult.coverage,
    });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runRepairTriage();
}
