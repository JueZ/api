#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { classifyRisk, isAutomergeCandidate, loadAutonomousPolicy } from './lib/autonomous-policy.mjs';

const CONTROLLER_WORKFLOW = 'codex-automerge.yml';
const CONTROLLER_CHECK_WRITER_JOBS = new Set(['resolve', 'publish-governance-check']);
const BUILTIN_GITHUB_TOKEN_EXPRESSIONS = new Set(['${{ github.token }}', '${{ secrets.GITHUB_TOKEN }}']);
const GITHUB_AUTH_KEYS = new Set(['authorization', 'gh_token', 'github_token', 'github-token', 'github_pat', 'token']);
const GITHUB_TOKEN_MINTING_ACTION = /(?:github.*(?:app-)?token|(?:app-)?token.*github|create.*app.*token)/i;
const GITHUB_TOKEN_MINTING_SHELL =
  /(?:gh\s+auth\s+login|\/app\/installations\/|app\/installations\/[^\s"']*\/access_tokens|openssl[^\n]*(?:jwt|private[-_ ]key))/i;
const DEFAULT_WORKFLOW_DIRECTORY = new URL('../.github/workflows/', import.meta.url);
const ALLOWED_WORKFLOW_SECRET_NAMES = new Set([
  'GITHUB_TOKEN',
  // Runtime repairable-error classification is the repository's only OpenAI API use.
  'OPENAI_API_KEY',
  'REDDIT_CLIENT_SECRET',
  'WLH_BASE_URL',
  'BRING_EMAIL',
  'BRING_PASSWORD',
  'BRING_CLIENT_API_KEY',
  'BRING_CONFIRMATION_HMAC_KEY',
  'BRING_MUTATION_ENCRYPTION_KEY',
]);
const OPENAI_RUNTIME_WORKFLOWS = new Set([
  'deploy-environment.yml',
  'deploy-test.yml',
  'prepare-production-private-storage.yml',
  'promote-production.yml',
  'rollback-production.yml',
]);
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export function evaluateRequiredChecks(checkRuns, headSha, requiredChecks) {
  const failures = [];
  const pending = [];
  const passed = [];

  for (const required of requiredChecks) {
    const named = checkRuns.filter((run) => run.name === required.name);
    const exactHead = named.filter((run) => run.head_sha === headSha);
    if (named.some((run) => run.head_sha !== headSha)) {
      failures.push({ check: required.name, reason: 'wrong_head_sha' });
    }
    if (exactHead.length === 0) {
      pending.push({ check: required.name, reason: 'missing' });
      continue;
    }
    if (exactHead.some((run) => run.app?.slug !== required.appSlug)) {
      failures.push({ check: required.name, reason: 'wrong_app' });
      continue;
    }
    const latest = [...exactHead]
      .filter((run) => run.app?.slug === required.appSlug)
      .sort((left, right) => Number(right.id) - Number(left.id))[0];
    if (!latest || latest.status !== 'completed') {
      pending.push({ check: required.name, reason: latest?.status ?? 'missing' });
      continue;
    }
    if (latest.conclusion !== 'success') {
      failures.push({ check: required.name, reason: latest.conclusion ?? 'no_conclusion' });
      continue;
    }
    passed.push(required.name);
  }

  return { ok: failures.length === 0 && pending.length === 0, failures, pending, passed };
}

function workflowRunIdFromCheck(checkRun, expectedRepository) {
  if (typeof checkRun?.details_url !== 'string') return undefined;
  try {
    const url = new URL(checkRun.details_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/\d+)?\/?$/);
    if (!match || match[1].toLowerCase() !== expectedRepository.toLowerCase()) return undefined;
    const runId = Number(match[2]);
    return Number.isSafeInteger(runId) && runId > 0 ? runId : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateCompleteCheckRollup(checkRuns, commitStatuses, headSha, currentRunId, repository) {
  const latestByIdentity = new Map();
  for (const checkRun of checkRuns) {
    if (checkRun.head_sha !== headSha) continue;
    const identity = `${checkRun.app?.id ?? checkRun.app?.slug ?? 'unknown'}:${checkRun.name}`;
    const previous = latestByIdentity.get(identity);
    if (!previous || Number(checkRun.id) > Number(previous.id)) latestByIdentity.set(identity, checkRun);
  }

  const failures = [];
  const pending = [];
  const currentControllerChecks = [];
  for (const checkRun of latestByIdentity.values()) {
    if (checkRun.status !== 'completed') {
      const isCurrentMergeJob =
        checkRun.name === 'merge exact PR head' &&
        checkRun.app?.slug === 'github-actions' &&
        workflowRunIdFromCheck(checkRun, repository) === currentRunId;
      if (isCurrentMergeJob) currentControllerChecks.push(checkRun.name);
      else pending.push({ check: checkRun.name, reason: checkRun.status ?? 'missing_status' });
      continue;
    }
    if (!PASSING_CHECK_CONCLUSIONS.has(checkRun.conclusion)) {
      failures.push({ check: checkRun.name, reason: checkRun.conclusion ?? 'no_conclusion' });
    }
  }

  const latestStatusByContext = new Map();
  for (const status of commitStatuses) {
    if (status.sha !== headSha) continue;
    const previous = latestStatusByContext.get(status.context);
    if (!previous || Number(status.id) > Number(previous.id)) latestStatusByContext.set(status.context, status);
  }
  for (const status of latestStatusByContext.values()) {
    if (status.state === 'success') continue;
    if (status.state === 'pending') pending.push({ check: status.context, reason: 'pending_status' });
    else failures.push({ check: status.context, reason: status.state ?? 'missing_state' });
  }

  return {
    ok: failures.length === 0 && pending.length === 0,
    explainsControllerUnstable: currentControllerChecks.length === 1,
    failures,
    pending,
    currentControllerChecks,
  };
}

export function validateAutonomousGovernance(evidence, expectedHeadSha, policy) {
  const errors = [];
  if (!isRecord(evidence)) return { ok: false, errors: ['governance evidence must be an object'] };
  const expectedKeys = new Set(['decision', 'verifiedHeadSha', 'summary', 'findings', 'risk', 'evaluator']);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(evidence, key)) errors.push(`governance evidence is missing ${key}`);
  }
  for (const key of Object.keys(evidence)) {
    if (!expectedKeys.has(key)) errors.push(`governance evidence contains unsupported field ${key}`);
  }
  if (evidence.decision !== 'approve') errors.push('autonomous governance did not approve the exact head');
  if (evidence.verifiedHeadSha !== expectedHeadSha) errors.push('governance evidence does not match expected head SHA');
  if (!isBoundedString(evidence.summary, 2000)) errors.push('governance evidence summary is invalid');
  if (!Array.isArray(evidence.findings) || evidence.findings.length !== 0) {
    errors.push('successful deterministic governance evidence must contain no findings');
  }
  if (!validRiskClassification(evidence.risk)) errors.push('governance risk classification is invalid');
  if (evidence.evaluator !== policy.autonomousGovernance.evaluator) {
    errors.push('governance evaluator identity is invalid');
  }
  return { ok: errors.length === 0, errors };
}

function validRiskClassification(risk) {
  return (
    isRecord(risk) &&
    typeof risk.highRisk === 'boolean' &&
    Array.isArray(risk.highRiskPaths) &&
    risk.highRiskPaths.every((path) => typeof path === 'string' && path.length > 0) &&
    isRecord(risk.classes)
  );
}

export function evaluatePullRequestState(
  pullRequest,
  expectedHeadSha,
  policy,
  { allowBlockedBeforeOwnReview = false, allowExpectedControllerUnstable = false } = {},
) {
  const errors = [];
  const allowedMergeableStates = new Set([
    'clean',
    ...(allowBlockedBeforeOwnReview || allowExpectedControllerUnstable ? ['unstable'] : []),
    ...(allowBlockedBeforeOwnReview ? ['blocked'] : []),
  ]);
  if (!isAutomergeCandidate(pullRequest, policy)) errors.push('pull request is not an auto-merge candidate');
  if (pullRequest.state !== 'open') errors.push('pull request is not open');
  if (pullRequest.head?.sha !== expectedHeadSha) errors.push('pull request head changed');
  if (pullRequest.base?.ref !== 'main') errors.push('pull request base must be main');
  if (!policy.merge.allowForks && pullRequest.head?.repo?.full_name !== pullRequest.base?.repo?.full_name) {
    errors.push('fork pull requests are not eligible');
  }
  if (policy.merge.requireUpToDate && pullRequest.mergeable_state === 'behind') {
    errors.push('pull request branch is behind main');
  }
  if (pullRequest.mergeable !== true || !allowedMergeableStates.has(pullRequest.mergeable_state)) {
    errors.push(`pull request is not mergeable (${pullRequest.mergeable_state ?? 'unknown'})`);
  }
  return { ok: errors.length === 0, errors };
}

export function mergeGateDecision({
  pullRequest,
  expectedHeadSha,
  checkEvaluation,
  aggregateCheckEvaluation,
  governance,
  policy,
}) {
  const pullRequestState = evaluatePullRequestState(pullRequest, expectedHeadSha, policy, {
    allowExpectedControllerUnstable:
      pullRequest.mergeable_state === 'unstable' &&
      aggregateCheckEvaluation?.ok === true &&
      aggregateCheckEvaluation.explainsControllerUnstable === true,
  });
  const governanceState = validateAutonomousGovernance(governance, expectedHeadSha, policy);
  const errors = [
    ...pullRequestState.errors,
    ...checkEvaluation.failures.map((failure) => `${failure.check}: ${failure.reason}`),
    ...checkEvaluation.pending.map((pending) => `${pending.check}: ${pending.reason}`),
    ...(aggregateCheckEvaluation?.failures ?? []).map(
      (failure) => `aggregate check ${failure.check}: ${failure.reason}`,
    ),
    ...(aggregateCheckEvaluation?.pending ?? []).map(
      (pending) => `aggregate check ${pending.check}: ${pending.reason}`,
    ),
    ...governanceState.errors,
  ];
  return {
    ok: errors.length === 0,
    errors,
    pullRequestState,
    checkEvaluation,
    aggregateCheckEvaluation,
    governanceState,
  };
}

export async function runGovernance(options, policy, github, runtime = {}) {
  await assertExclusiveWorkflowCheckWriter(runtime);
  assertRuntimeWorkflowIdentity(options, runtime);
  const pullRequest = await github.getPullRequest(options.prNumber);
  assertExpectedHead(pullRequest, options.headSha);
  const files = await github.getPullRequestFiles(options.prNumber);
  assertExpectedHead(await github.getPullRequest(options.prNumber), options.headSha);
  await assertFreeExactHeadChecks(options, policy, github, 'deterministic governance boundary', {
    allowBlockedBeforeOwnReview: true,
  });
  const risk = classifyRisk(
    files.map((file) => file.filename),
    policy,
  );
  const evidence = {
    decision: 'approve',
    verifiedHeadSha: options.headSha,
    summary:
      'The protected controller verified workflow integrity, exact-head identity, pull-request eligibility, and every free required aggregate without invoking a model.',
    findings: [],
    risk,
    evaluator: policy.autonomousGovernance.evaluator,
  };
  const validation = validateAutonomousGovernance(evidence, options.headSha, policy);
  if (!validation.ok) throw new Error(`Autonomous governance evidence is invalid: ${validation.errors.join('; ')}`);
  await publishGovernance(evidence, options);
  return evidence;
}

export async function runRequiredCheckPreflight(options, policy, github) {
  const requiredChecks = freeRequiredChecks(policy);
  const deadline = Date.now() + options.waitSeconds * 1000;
  let evaluation;
  do {
    const pullRequest = await github.getPullRequest(options.prNumber);
    assertExpectedHead(pullRequest, options.headSha);
    const pullRequestState = evaluatePullRequestState(pullRequest, options.headSha, policy, {
      allowBlockedBeforeOwnReview: true,
    });
    if (!pullRequestState.ok) {
      throw new Error(
        `Autonomous governance preflight rejected the pull request:\n- ${pullRequestState.errors.join('\n- ')}`,
      );
    }
    evaluation = evaluateRequiredChecks(await github.getCheckRuns(options.headSha), options.headSha, requiredChecks);
    if (evaluation.failures.length > 0 || evaluation.pending.length === 0) break;
    await delay(options.pollSeconds * 1000);
  } while (Date.now() < deadline);
  if (!evaluation?.ok) {
    const errors = [
      ...(evaluation?.failures ?? []).map((failure) => `${failure.check}: ${failure.reason}`),
      ...(evaluation?.pending ?? []).map((pending) => `${pending.check}: ${pending.reason}`),
    ];
    throw new Error(
      `Autonomous governance is blocked until deterministic exact-head checks pass:\n- ${errors.join('\n- ')}`,
    );
  }
  return evaluation;
}

async function runGate(options, policy, github) {
  let lastEvaluation;
  let aggregateCheckEvaluation;
  const deadline = Date.now() + options.waitSeconds * 1000;
  do {
    const pullRequest = await github.getPullRequest(options.prNumber);
    assertExpectedHead(pullRequest, options.headSha);
    const [checkRuns, commitStatuses] = await Promise.all([
      github.getCheckRuns(options.headSha),
      github.getCommitStatuses(options.headSha),
    ]);
    lastEvaluation = evaluateRequiredChecks(checkRuns, options.headSha, policy.requiredChecks);
    aggregateCheckEvaluation = evaluateCompleteCheckRollup(
      checkRuns,
      commitStatuses,
      options.headSha,
      options.runId,
      options.repository,
    );
    if (lastEvaluation.failures.length > 0 || aggregateCheckEvaluation.failures.length > 0) break;
    if (lastEvaluation.pending.length === 0 && aggregateCheckEvaluation.pending.length === 0) break;
    await delay(options.pollSeconds * 1000);
  } while (Date.now() < deadline);

  const pullRequest = await github.getPullRequest(options.prNumber);
  assertExpectedHead(pullRequest, options.headSha);
  const [finalCheckRuns, finalCommitStatuses] = await Promise.all([
    github.getCheckRuns(options.headSha),
    github.getCommitStatuses(options.headSha),
  ]);
  lastEvaluation = evaluateRequiredChecks(finalCheckRuns, options.headSha, policy.requiredChecks);
  aggregateCheckEvaluation = evaluateCompleteCheckRollup(
    finalCheckRuns,
    finalCommitStatuses,
    options.headSha,
    options.runId,
    options.repository,
  );
  const governance = JSON.parse(await readFile(options.governanceFile, 'utf8'));
  const decision = mergeGateDecision({
    pullRequest,
    expectedHeadSha: options.headSha,
    checkEvaluation: lastEvaluation,
    aggregateCheckEvaluation,
    governance,
    policy,
  });
  if (!decision.ok)
    throw new Error(`Exact-head merge gate rejected the pull request:\n- ${decision.errors.join('\n- ')}`);
  if (!options.merge) return decision;
  const mergeResult = await github.mergePullRequest(options.prNumber, options.headSha, policy.merge.method);
  if (!mergeResult.merged) {
    throw new Error(`GitHub refused the exact-head merge: ${mergeResult.message ?? 'unknown reason'}`);
  }
  return { ...decision, mergeResult };
}

function createGithubClient(repository, token) {
  if (!token) throw new Error('GH_TOKEN is required.');
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('repository must use owner/name format.');
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'juez-autonomous-merge-controller',
  };
  async function request(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} failed with ${response.status}.`);
    return response;
  }
  return {
    async getPullRequest(prNumber) {
      return (await request(`/pulls/${prNumber}`)).json();
    },
    async getPullRequestFiles(prNumber) {
      const all = [];
      for (let page = 1; page <= 30; page += 1) {
        const rows = await (await request(`/pulls/${prNumber}/files?per_page=100&page=${page}`)).json();
        all.push(...rows);
        if (rows.length < 100) return all;
      }
      throw new Error('Pull request contains more than 3000 changed files.');
    },
    async getCheckRuns(headSha) {
      const all = [];
      for (let page = 1; page <= 100; page += 1) {
        const response = await (
          await request(`/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`)
        ).json();
        const rows = response.check_runs ?? [];
        all.push(...rows);
        if (all.length >= (response.total_count ?? all.length) || rows.length < 100) return all;
      }
      throw new Error('Commit contains more than 10000 check runs.');
    },
    async getCommitStatuses(headSha) {
      const all = [];
      for (let page = 1; page <= 100; page += 1) {
        const rows = await (await request(`/commits/${headSha}/statuses?per_page=100&page=${page}`)).json();
        all.push(...rows);
        if (rows.length < 100) return all;
      }
      throw new Error('Commit contains more than 10000 status contexts.');
    },
    async mergePullRequest(prNumber, headSha, mergeMethod) {
      return (
        await request(`/pulls/${prNumber}/merge`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: headSha, merge_method: mergeMethod }),
        })
      ).json();
    },
  };
}

async function publishGovernance(evidence, options) {
  await writeFile(options.governanceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeGithubOutput({
    decision: evidence.decision,
    verified_head_sha: evidence.verifiedHeadSha,
    high_risk: String(evidence.risk.highRisk),
    evaluator: evidence.evaluator,
  });
}

async function writeGithubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await appendFile(process.env.GITHUB_OUTPUT, `${lines}\n`);
}

function parseOptions(argv) {
  const command = argv[2];
  const values = new Map();
  for (let index = 3; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const repository = values.get('--repository') ?? process.env.GITHUB_REPOSITORY;
  const prNumber = Number(values.get('--pr') ?? process.env.PR_NUMBER);
  const headSha = values.get('--head-sha') ?? process.env.HEAD_SHA;
  if (!['preflight', 'governance', 'gate'].includes(command)) {
    throw new Error('command must be preflight, governance, or gate');
  }
  if (!repository) throw new Error('--repository is required');
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('--pr must be a positive integer');
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) throw new Error('--head-sha must be a full commit SHA');
  const runId = Number(values.get('--run-id') ?? process.env.GITHUB_RUN_ID);
  if (['governance', 'gate'].includes(command) && (!Number.isSafeInteger(runId) || runId < 1)) {
    throw new Error('--run-id must be a positive workflow run ID for governance and gate commands');
  }
  return {
    command,
    repository,
    prNumber,
    headSha: headSha.toLowerCase(),
    governanceFile: values.get('--governance-file') ?? 'autonomous-governance.json',
    waitSeconds: Number(values.get('--wait-seconds') ?? 3600),
    pollSeconds: Number(values.get('--poll-seconds') ?? 15),
    runId,
    merge: values.get('--merge') === 'true',
  };
}

function assertExpectedHead(pullRequest, expectedHeadSha) {
  if (pullRequest.head?.sha !== expectedHeadSha) {
    throw new Error(`Pull request head changed from ${expectedHeadSha} to ${pullRequest.head?.sha ?? 'unknown'}.`);
  }
}

export async function exclusiveWorkflowCheckWriteFindings(
  directory = DEFAULT_WORKFLOW_DIRECTORY,
  expectedWorkflowHashes = directory === DEFAULT_WORKFLOW_DIRECTORY
    ? loadAutonomousPolicy().trustedWorkflowSha256
    : undefined,
) {
  const findings = [];
  const writers = [];
  const workflowContents = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const workflowPath = typeof directory === 'string' ? join(directory, entry.name) : new URL(entry.name, directory);
    const workflowSource = await readFile(workflowPath, 'utf8');
    workflowContents[entry.name] = workflowSource;
    const workflow = parseYaml(workflowSource);
    if (!isRecord(workflow)) {
      findings.push(`${entry.name}: workflow must be a YAML mapping`);
      continue;
    }
    if (!isExplicitPermissionMap(workflow.permissions)) {
      findings.push(`${entry.name}: top-level permissions must be an explicit mapping`);
    }
    const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
    if (!isRecord(workflow.jobs)) findings.push(`${entry.name}: jobs must be a mapping`);
    for (const [jobName, candidate] of Object.entries(jobs)) {
      if (!isRecord(candidate)) {
        findings.push(`${entry.name}:${jobName}: job must be a mapping`);
        continue;
      }
      if (candidate.permissions !== undefined && !isExplicitPermissionMap(candidate.permissions)) {
        findings.push(`${entry.name}:${jobName}: job permissions must be an explicit mapping`);
        continue;
      }
      const effectivePermissions = candidate.permissions ?? workflow.permissions;
      if (isExplicitPermissionMap(effectivePermissions) && effectivePermissions.checks === 'write') {
        writers.push(`${entry.name}:${jobName}`);
      }
    }
    collectUnsafeGithubTokenFindings(workflow, entry.name, findings);
  }
  if (expectedWorkflowHashes !== undefined) {
    findings.push(...trustedWorkflowHashFindings(workflowContents, expectedWorkflowHashes));
  }
  const expectedWriters = [...CONTROLLER_CHECK_WRITER_JOBS].map((job) => `${CONTROLLER_WORKFLOW}:${job}`).sort();
  const actualWriters = [...writers].sort();
  if (
    actualWriters.length !== expectedWriters.length ||
    actualWriters.some((writer, index) => writer !== expectedWriters[index])
  ) {
    findings.push(
      `checks:write must be exclusive to the approved controller jobs; expected: ${expectedWriters.join(', ')}; found: ${actualWriters.join(', ') || 'none'}`,
    );
  }
  return findings;
}

async function assertExclusiveWorkflowCheckWriter(runtime = {}) {
  const inspect = runtime.workflowCheckWriteFindings ?? exclusiveWorkflowCheckWriteFindings;
  const findings = await inspect();
  if (findings.length > 0) throw new Error(`Autonomous governance permission policy failed: ${findings.join('; ')}`);
}

function isExplicitPermissionMap(permissions) {
  return isRecord(permissions);
}

function collectUnsafeGithubTokenFindings(value, workflowName, findings, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUnsafeGithubTokenFindings(item, workflowName, findings, [...path, String(index)]),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (key === 'uses' && typeof child === 'string' && GITHUB_TOKEN_MINTING_ACTION.test(child)) {
      findings.push(`${workflowName}:${childPath.join('.')}: GitHub App/PAT token minting actions are not allowed`);
    }
    if (key.toLowerCase() === 'secrets' && child === 'inherit') {
      findings.push(`${workflowName}:${childPath.join('.')}: reusable workflows must not inherit all secrets`);
    }
    if (GITHUB_AUTH_KEYS.has(key.toLowerCase()) && typeof child === 'string') {
      const normalized = child.trim();
      const allowed =
        BUILTIN_GITHUB_TOKEN_EXPRESSIONS.has(normalized) ||
        [...BUILTIN_GITHUB_TOKEN_EXPRESSIONS].some(
          (expression) => normalized.toLowerCase() === `bearer ${expression}`.toLowerCase(),
        );
      if (!allowed) {
        findings.push(`${workflowName}:${childPath.join('.')}: GitHub authentication must use the built-in job token`);
      }
    }
    if (typeof child === 'string') {
      collectSecretExpressionFindings(child, workflowName, childPath, findings);
      if (GITHUB_TOKEN_MINTING_SHELL.test(child)) {
        findings.push(`${workflowName}:${childPath.join('.')}: shell-based GitHub token minting is not allowed`);
      }
      if (workflowName !== CONTROLLER_WORKFLOW && /(?:^|[\s/"'])check-runs(?:$|[\s/?"'])/i.test(child)) {
        findings.push(`${workflowName}:${childPath.join('.')}: raw GitHub check-run access is controller-only`);
      }
    }
    collectUnsafeGithubTokenFindings(child, workflowName, findings, childPath);
  }
}

export function trustedWorkflowHashFindings(workflowContents, expectedWorkflowHashes) {
  if (!isRecord(workflowContents) || !isRecord(expectedWorkflowHashes)) {
    return ['trusted workflow hash policy requires workflow-content and expected-hash mappings'];
  }
  const findings = [];
  const actualNames = Object.keys(workflowContents).sort();
  const expectedNames = Object.keys(expectedWorkflowHashes).sort();
  for (const workflowName of actualNames.filter((name) => !expectedNames.includes(name))) {
    findings.push(`${workflowName}: trusted workflow hash is missing`);
  }
  for (const workflowName of expectedNames.filter((name) => !actualNames.includes(name))) {
    findings.push(`${workflowName}: trusted workflow file is missing`);
  }
  for (const workflowName of actualNames.filter((name) => expectedNames.includes(name))) {
    const actualDigest = createHash('sha256').update(workflowContents[workflowName]).digest('hex');
    if (actualDigest !== expectedWorkflowHashes[workflowName]) {
      findings.push(`${workflowName}: content does not match the trusted workflow hash`);
    }
  }
  return findings;
}

function collectSecretExpressionFindings(value, workflowName, path, findings) {
  for (const expressionMatch of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const expression = expressionMatch[1];
    if (!/\bsecrets\b/.test(expression)) continue;
    const names = [...expression.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((match) => match[1]);
    const withoutStaticReferences = expression.replace(/\bsecrets\.[A-Za-z_][A-Za-z0-9_]*\b/g, '');
    if (/\bsecrets\b/.test(withoutStaticReferences)) {
      findings.push(`${workflowName}:${path.join('.')}: dynamic or bracket workflow secret access is not allowed`);
    }
    for (const secretName of names) {
      if (!ALLOWED_WORKFLOW_SECRET_NAMES.has(secretName)) {
        findings.push(`${workflowName}:${path.join('.')}: workflow secret ${secretName} is not allowlisted`);
      }
      if (secretName === 'OPENAI_API_KEY' && !OPENAI_RUNTIME_WORKFLOWS.has(workflowName)) {
        findings.push(
          `${workflowName}:${path.join('.')}: OPENAI_API_KEY is restricted to repairable-error runtime deployment`,
        );
      }
    }
  }
}

function assertRuntimeWorkflowIdentity(options, { enforceGitHubActions = true } = {}) {
  if (!Number.isSafeInteger(options.runId) || options.runId < 1) {
    throw new Error('Autonomous governance requires a positive trusted workflow run ID.');
  }
  if (!enforceGitHubActions) return;
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Live autonomous governance must execute in the trusted GitHub Actions workflow.');
  }
  if (process.env.GITHUB_REPOSITORY !== options.repository) {
    throw new Error('Autonomous governance repository does not match the current GitHub Actions run.');
  }
  if (Number(process.env.GITHUB_RUN_ID) !== options.runId) {
    throw new Error('Autonomous governance run ID does not match GITHUB_RUN_ID.');
  }
  if (process.env.GITHUB_WORKFLOW !== 'Codex Auto-Merge') {
    throw new Error('Autonomous governance must execute only from the Codex Auto-Merge workflow.');
  }
}

async function assertFreeExactHeadChecks(
  options,
  policy,
  github,
  boundary,
  { allowBlockedBeforeOwnReview = false } = {},
) {
  const pullRequest = await github.getPullRequest(options.prNumber);
  assertExpectedHead(pullRequest, options.headSha);
  const pullRequestState = evaluatePullRequestState(pullRequest, options.headSha, policy, {
    allowBlockedBeforeOwnReview,
  });
  if (!pullRequestState.ok) {
    throw new Error(`Free exact-head checks failed at ${boundary}: ${pullRequestState.errors.join('; ')}`);
  }
  const checkRuns = await github.getCheckRuns(options.headSha);
  const evaluation = evaluateRequiredChecks(checkRuns, options.headSha, freeRequiredChecks(policy));
  if (!evaluation.ok) {
    const errors = [
      ...evaluation.failures.map((failure) => `${failure.check}: ${failure.reason}`),
      ...evaluation.pending.map((pending) => `${pending.check}: ${pending.reason}`),
    ];
    throw new Error(`Free exact-head checks failed at ${boundary}: ${errors.join('; ')}`);
  }
  return checkRuns;
}

function freeRequiredChecks(policy) {
  return policy.requiredChecks.filter((required) => required.name !== policy.autonomousGovernance.checkName);
}

function isBoundedString(value, maximumLength) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximumLength;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseOptions(process.argv);
  const policy = loadAutonomousPolicy();
  const github = createGithubClient(options.repository, process.env.GH_TOKEN);
  const result =
    options.command === 'preflight'
      ? await runRequiredCheckPreflight(options, policy, github)
      : options.command === 'governance'
        ? await runGovernance(options, policy, github)
        : await runGate(options, policy, github);
  console.log(JSON.stringify(result, null, 2));
}
