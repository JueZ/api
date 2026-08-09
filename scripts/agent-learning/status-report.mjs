import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAutonomousPolicy } from '../lib/autonomous-policy.mjs';
import { DEFAULT_RESULTS_DIRECTORY } from '../agent-task-evals/definitions.mjs';
import {
  learningCandidateMarker,
  learningSourceMarker,
  parseLearningMarkers,
  validateExplicitDisposition,
} from './failure-triage.mjs';
import { artifactStatusCounts, ARTIFACT_STATES, validateArtifactRepository } from './validate-artifacts.mjs';
import {
  buildMemoryFreshnessReport,
  createGitHubMemoryClient,
  memoryFreshnessMarkdown,
} from './check-memory-freshness.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTEXT_VARIANTS = Object.freeze(['historical', 'current-agent-context', 'current-without-skills']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_AUTOMATION = new Set(['github-actions', 'github-actions[bot]']);

export function taskEvaluationSummary(resultsDirectory = DEFAULT_RESULTS_DIRECTORY) {
  const directory = resolve(resultsDirectory);
  const records = [];
  try {
    for (const name of readdirSync(directory)
      .filter((value) => value.endsWith('.json'))
      .sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (
          record?.schemaVersion === 1 &&
          typeof record.taskId === 'string' &&
          CONTEXT_VARIANTS.includes(record.contextVariant) &&
          typeof record.passed === 'boolean'
        )
          records.push(record);
      } catch {
        // A malformed local report is excluded and represented as missing evidence.
      }
    }
  } catch {
    // The results directory is optional local state.
  }
  const byContext = Object.fromEntries(
    CONTEXT_VARIANTS.map((context) => [context, { passed: 0, total: 0, rate: null }]),
  );
  for (const record of records) {
    byContext[record.contextVariant].total += 1;
    if (record.passed === true) byContext[record.contextVariant].passed += 1;
  }
  for (const context of CONTEXT_VARIANTS) {
    const group = byContext[context];
    group.rate = group.total === 0 ? null : group.passed / group.total;
  }
  return { resultCount: records.length, byContext };
}

function issueUrl(repository, number) {
  return `https://github.com/${repository}/issues/${number}`;
}

function isIssue(value) {
  return Number.isInteger(value?.number) && !value?.pull_request;
}

function trustedComment(comment) {
  return (
    TRUSTED_ASSOCIATIONS.has(String(comment?.author_association ?? '').toUpperCase()) ||
    TRUSTED_AUTOMATION.has(String(comment?.user?.login ?? ''))
  );
}

function explicitDispositionFromComments(comments) {
  for (const comment of [...comments].reverse()) {
    if (!trustedComment(comment)) continue;
    const parsed = parseLearningMarkers(comment?.body ?? '');
    if (parsed.dispositions.length !== 1 || parsed.malformed.length > 0) continue;
    const disposition = parsed.dispositions[0];
    const validation = validateExplicitDisposition(disposition, {
      fingerprint: disposition?.recurrenceFingerprint,
      asOf: new Date().toISOString().slice(0, 10),
    });
    if (validation.valid) return true;
  }
  return false;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function liveLearningStatus(client, rolloutTimestamp) {
  try {
    const [repairResponse, learningResponse] = await Promise.all([
      client.listIssues({ state: 'all', labels: ['codex-repair'], since: rolloutTimestamp }),
      client.listIssues({ state: 'all', labels: ['agent-learning'], since: rolloutTimestamp }),
    ]);
    const repairs = repairResponse
      .filter(isIssue)
      .filter((issue) => Date.parse(issue.created_at) >= Date.parse(rolloutTimestamp));
    const allLearningIssues = learningResponse
      .filter(isIssue)
      .filter((issue) => Date.parse(issue.created_at) >= Date.parse(rolloutTimestamp));
    const learningIssues = allLearningIssues.filter((issue) => issue.state === 'open');
    const coverage = await mapWithConcurrency(repairs, 6, async (issue) => {
      const comments = await client.listComments(issue.number);
      const markers = parseLearningMarkers(
        comments
          .filter(trustedComment)
          .map((comment) => comment.body ?? '')
          .join('\n'),
      );
      return markers.links.length > 0 || explicitDispositionFromComments(comments);
    });
    const covered = coverage.filter(Boolean).length;
    const recurrence = new Map();
    const significantSources = new Set(repairs.map((issue) => `repair_issue:${issue.number}`));
    for (const issue of allLearningIssues) {
      const markers = parseLearningMarkers(issue.body ?? '');
      for (const source of markers.sources) significantSources.add(source.key);
      for (const fingerprint of markers.candidates) {
        const current = recurrence.get(fingerprint) ?? { fingerprint, recurrenceCount: 0, issueNumber: issue.number };
        current.recurrenceCount = Math.max(current.recurrenceCount, markers.sources.length);
        recurrence.set(fingerprint, current);
      }
    }
    return {
      status: 'available',
      significantFailuresSinceRollout: significantSources.size,
      dispositionCoverage: {
        covered,
        total: repairs.length,
        rate: repairs.length === 0 ? null : covered / repairs.length,
      },
      learningCandidateCount: learningIssues.length,
      openLearningIssues: learningIssues
        .map((issue) => ({ number: issue.number, url: issue.html_url ?? issueUrl(client.repository, issue.number) }))
        .sort((left, right) => left.number - right.number),
      recurringFingerprints: [...recurrence.values()]
        .filter((entry) => entry.recurrenceCount >= 2)
        .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
      blocker: null,
      candidateBodies: learningIssues.map((issue) => ({ number: issue.number, body: issue.body ?? '' })),
    };
  } catch (error) {
    return {
      status: 'blocked',
      significantFailuresSinceRollout: null,
      dispositionCoverage: { covered: null, total: null, rate: null },
      learningCandidateCount: null,
      openLearningIssues: [],
      recurringFingerprints: [],
      blocker: error instanceof Error ? error.message : String(error),
      candidateBodies: [],
    };
  }
}

function unavailableLiveStatus() {
  return {
    status: 'not_requested',
    significantFailuresSinceRollout: null,
    dispositionCoverage: { covered: null, total: null, rate: null },
    learningCandidateCount: null,
    openLearningIssues: [],
    recurringFingerprints: [],
    blocker: null,
    candidateBodies: [],
  };
}

function staleFingerprint(contradiction) {
  return `project-memory.stale.${contradiction.kind === 'pull_request' ? 'pr' : 'run'}.${contradiction.id}`;
}

export async function createStaleMemoryIssue({ client, contradiction, openCandidates }) {
  if (!contradiction) return { status: 'not_applicable', issue: null };
  const fingerprint = staleFingerprint(contradiction);
  const marker = learningCandidateMarker(fingerprint);
  const existing = openCandidates.find((candidate) => candidate.body.includes(marker));
  if (existing) {
    return {
      status: 'deduplicated',
      issue: { number: existing.number, url: issueUrl(client.repository, existing.number) },
    };
  }
  const sourceIdentifier = `memory-${contradiction.kind === 'pull_request' ? 'pr' : 'run'}-${contradiction.id}`;
  const created = await client.createIssue({
    title: `Learning: stale project-memory ${contradiction.kind.replace('_', ' ')} reference`,
    labels: ['agent-learning', 'learning-required'],
    body: `${marker}\n${learningSourceMarker('repository_audit', sourceIdentifier)}\n\nA deterministic live-state check found a stale project-memory reference.\n\n- Recurrence fingerprint: \`${fingerprint}\`\n- Memory location: \`${contradiction.path}:${contradiction.line}\`\n- Reference: ${contradiction.kind} \`${contradiction.id}\`\n- Declared state: \`${contradiction.declaredState}\`\n- Observed state: \`${contradiction.observedState}\`\n\nImplement the smallest durable correction through an ordinary protected PR. Do not copy issue bodies, logs, credentials, or provider content into the artifact.`,
  });
  return {
    status: 'created',
    issue: { number: created.number, url: created.html_url ?? issueUrl(client.repository, created.number) },
  };
}

export async function buildLearningStatusReport(options = {}) {
  const repository = options.repository ?? 'JueZ/api';
  const policy = loadAutonomousPolicy(options.policyPath);
  const validation = validateArtifactRepository({ repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT });
  const artifactCounts =
    validation.errors.length === 0
      ? artifactStatusCounts(validation.artifacts)
      : Object.fromEntries(ARTIFACT_STATES.map((state) => [state, null]));
  const memory = await buildMemoryFreshnessReport({ ...options, repository });
  const taskEvaluations = taskEvaluationSummary(options.resultsDirectory);
  let client = options.client;
  let live = unavailableLiveStatus();
  if (options.live === true) {
    try {
      client ??= createGitHubMemoryClient({
        repository,
        token: options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
      });
      live = await liveLearningStatus(client, policy.agentLearning.rolloutTimestamp);
    } catch (error) {
      live = {
        ...unavailableLiveStatus(),
        status: 'blocked',
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let staleMemoryIssue = { status: 'not_requested', issue: null };
  if (options.createStaleMemoryIssue === true) {
    if (memory.live.status === 'blocked' || live.status === 'blocked' || !client) {
      staleMemoryIssue = { status: 'blocked', issue: null };
    } else {
      const contradiction = [...memory.live.contradictions].sort(
        (left, right) => left.path.localeCompare(right.path) || left.line - right.line,
      )[0];
      staleMemoryIssue = await createStaleMemoryIssue({ client, contradiction, openCandidates: live.candidateBodies });
    }
  }
  const missingOrStaleEvidence = [];
  if (validation.errors.length > 0)
    missingOrStaleEvidence.push(`${validation.errors.length} learning artifact validation error(s)`);
  if (memory.offline.findings.length > 0)
    missingOrStaleEvidence.push(`${memory.offline.findings.length} offline project-memory finding(s)`);
  if (memory.live.status === 'blocked') missingOrStaleEvidence.push('live project-memory evidence blocked');
  if (memory.live.contradictions.length > 0)
    missingOrStaleEvidence.push(`${memory.live.contradictions.length} stale project-memory contradiction(s)`);
  if (live.status === 'blocked') missingOrStaleEvidence.push('live learning-issue evidence blocked');
  if (options.live !== true) missingOrStaleEvidence.push('live GitHub learning status not requested');
  if (taskEvaluations.resultCount === 0) missingOrStaleEvidence.push('no local historical agent-task result records');
  const status =
    validation.errors.length > 0 || memory.status === 'failing'
      ? 'failing'
      : memory.status === 'blocked' || live.status === 'blocked' || staleMemoryIssue.status === 'blocked'
        ? 'blocked'
        : 'passing';
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    repository,
    rolloutTimestamp: policy.agentLearning.rolloutTimestamp,
    status,
    significantFailuresSinceRollout: live.significantFailuresSinceRollout,
    learningCandidateCount: live.learningCandidateCount,
    dispositionCoverage: live.dispositionCoverage,
    verifiedArtifactCount: artifactCounts.verified,
    waivedArtifactCount: artifactCounts.waived,
    artifactCounts,
    recurringFingerprints: live.recurringFingerprints,
    openLearningIssues: live.openLearningIssues,
    historicalTaskPassRateByContext: taskEvaluations.byContext,
    taskEvaluationResultCount: taskEvaluations.resultCount,
    memoryFreshness: memory,
    liveEvidenceStatus: live.status,
    staleMemoryIssue,
    missingOrStaleEvidence,
    invokedModel: false,
    rewroteMemory: false,
  };
}

function percentage(value) {
  return value === null ? 'n/a' : `${(100 * value).toFixed(1)}%`;
}

export function learningStatusMarkdown(report) {
  const lines = [
    '# Agent-learning status',
    '',
    `Status: **${report.status}**`,
    '',
    `- Significant failures since rollout: ${report.significantFailuresSinceRollout ?? 'unavailable'}`,
    `- Open learning candidates: ${report.learningCandidateCount ?? 'unavailable'}`,
    `- Disposition coverage: ${report.dispositionCoverage.covered ?? 'unavailable'}/${report.dispositionCoverage.total ?? 'unavailable'} (${percentage(report.dispositionCoverage.rate)})`,
    `- Verified artifacts: ${report.verifiedArtifactCount ?? 'unavailable'}`,
    `- Waived artifacts: ${report.waivedArtifactCount ?? 'unavailable'}`,
    `- Recurring fingerprints: ${report.recurringFingerprints.length}`,
    `- Open learning issues: ${report.openLearningIssues.length}`,
    '',
    '## Historical task pass rate',
    '',
    '| Context | Passed | Total | Rate |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const context of CONTEXT_VARIANTS) {
    const group = report.historicalTaskPassRateByContext[context];
    lines.push(`| ${context} | ${group.passed} | ${group.total} | ${percentage(group.rate)} |`);
  }
  lines.push('', '## Missing or stale evidence', '');
  if (report.missingOrStaleEvidence.length === 0) lines.push('- None detected.');
  else for (const item of report.missingOrStaleEvidence) lines.push(`- ${item}`);
  lines.push(
    '',
    memoryFreshnessMarkdown(report.memoryFreshness),
    'No model was invoked and project memory was not rewritten.',
    '',
  );
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { live: false, createStaleMemoryIssue: false, repository: 'JueZ/api' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--create-stale-memory-issue') options.createStaleMemoryIssue = true;
    else if (['--repository', '--json', '--markdown', '--results-directory'].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg === '--results-directory' ? 'resultsDirectory' : arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unsupported argument: ${arg}`);
  }
  if (options.createStaleMemoryIssue && !options.live) throw new Error('--create-stale-memory-issue requires --live.');
  return options;
}

function writeOutput(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, { encoding: 'utf8', mode: 0o600 });
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildLearningStatusReport(options);
  if (options.json) writeOutput(options.json, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdown) writeOutput(options.markdown, learningStatusMarkdown(report));
  console.log(
    `Agent learning: ${report.status}; verified=${report.verifiedArtifactCount ?? 'unavailable'}; candidates=${report.learningCandidateCount ?? 'unavailable'}; task results=${report.taskEvaluationResultCount}; live evidence=${report.liveEvidenceStatus}.`,
  );
  if (report.status !== 'passing') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
