import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createTrustedGithubClient,
  readSingleJsonArchive,
  TRUSTED_EVIDENCE_REPOSITORY,
  verifyArtifactArchiveDigest,
} from './agent-learning/trusted-evidence-primitives.mjs';
import {
  AUTONOMOUS_GOVERNANCE_EVALUATOR,
  validateAutonomousGovernanceEvidence,
} from './lib/autonomous-governance-evidence.mjs';
import { classifyDeploymentImpact, RUNTIME_NEUTRAL_DEPLOYMENT_PATHS } from './lib/deployment-impact.mjs';

const EXACT_SHA = /^[0-9a-f]{40}$/;
const EXACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GOVERNANCE_WORKFLOW_PATH = '.github/workflows/codex-automerge.yml';
const GOVERNANCE_WORKFLOW_NAME = 'Codex Auto-Merge';
const GOVERNANCE_ARTIFACT_ENTRY = 'autonomous-governance.json';
const DEFAULT_REUSE_POLICY = Object.freeze({
  autonomousGovernance: Object.freeze({ evaluator: AUTONOMOUS_GOVERNANCE_EVALUATOR }),
  deployment: Object.freeze({ runtimeNeutralPaths: RUNTIME_NEUTRAL_DEPLOYMENT_PATHS }),
});

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function exactSha(value, label) {
  if (!EXACT_SHA.test(value || '')) throw new Error(`${label} must be an exact lowercase SHA`);
  return value;
}

function exactTree(record, sha, label) {
  if (record?.sha !== sha || !EXACT_SHA.test(record?.tree?.sha || '')) {
    throw new Error(`${label} commit tree identity is invalid`);
  }
  return record.tree.sha;
}

function validateWorkflowRun(run, { repository, governanceRunId, prHeadSha }) {
  const valid =
    run?.id === governanceRunId &&
    run?.repository?.full_name === repository &&
    run?.path === GOVERNANCE_WORKFLOW_PATH &&
    run?.name === GOVERNANCE_WORKFLOW_NAME &&
    run?.event === 'pull_request_target' &&
    run?.status === 'completed' &&
    run?.conclusion === 'success' &&
    run?.head_sha === prHeadSha &&
    run?.run_attempt === 1;
  if (!valid) throw new Error('governance workflow run identity is invalid');
}

function validatePullRequest(pullRequest, { repository, prNumber, prHeadSha, mainSha }) {
  const valid =
    pullRequest?.number === prNumber &&
    pullRequest?.state === 'closed' &&
    pullRequest?.merged === true &&
    pullRequest?.merge_commit_sha === mainSha &&
    pullRequest?.head?.sha === prHeadSha &&
    pullRequest?.head?.repo?.full_name === repository &&
    pullRequest?.base?.repo?.full_name === repository &&
    pullRequest?.base?.ref === 'main' &&
    EXACT_SHA.test(pullRequest?.base?.sha || '') &&
    Number.isSafeInteger(pullRequest?.changed_files) &&
    pullRequest.changed_files > 0 &&
    pullRequest.changed_files <= 3000;
  if (!valid) throw new Error('merged pull-request identity is invalid');
}

async function readGovernanceEvidence(github, { governanceRunId, prHeadSha }, runtime = {}) {
  const expectedName = `autonomous-governance-${prHeadSha}`;
  const artifacts = await github.getWorkflowArtifacts(governanceRunId);
  const matches = artifacts.filter((artifact) => artifact?.name === expectedName);
  if (matches.length !== 1) throw new Error('expected exactly one exact-head governance artifact');
  const artifact = matches[0];
  if (
    artifact.expired !== false ||
    !EXACT_DIGEST.test(artifact.digest || '') ||
    artifact?.workflow_run?.id !== governanceRunId ||
    artifact?.workflow_run?.head_sha !== prHeadSha
  ) {
    throw new Error('governance artifact identity is invalid');
  }
  const archive = await github.downloadArtifact(artifact.id);
  const verifyDigest = runtime.verifyArtifactArchiveDigest ?? verifyArtifactArchiveDigest;
  const readArchive = runtime.readSingleJsonArchive ?? readSingleJsonArchive;
  verifyDigest(archive, artifact.digest, artifact.digest, 'governance artifact');
  return readArchive(archive, GOVERNANCE_ARTIFACT_ENTRY, { label: 'governance artifact' });
}

export async function resolveTrustedMainCiProfile(input, github, policy = DEFAULT_REUSE_POLICY, runtime = {}) {
  const repository = input?.repository;
  if (repository !== TRUSTED_EVIDENCE_REPOSITORY) {
    throw new Error(`main CI reuse is repository-bound to ${TRUSTED_EVIDENCE_REPOSITORY}`);
  }
  const mainSha = exactSha(input?.mainSha, 'main SHA');
  const prHeadSha = exactSha(input?.prHeadSha, 'pull-request head SHA');
  const prNumber = positiveInteger(input?.prNumber, 'pull-request number');
  const governanceRunId = positiveInteger(input?.governanceRunId, 'governance run ID');

  const mainBefore = await github.getProtectedMainRef();
  if (
    mainBefore?.ref !== 'refs/heads/main' ||
    mainBefore?.object?.type !== 'commit' ||
    mainBefore?.object?.sha !== mainSha
  ) {
    throw new Error('requested source is not the current protected main head');
  }

  const pullRequest = await github.getPullRequest(prNumber);
  validatePullRequest(pullRequest, { repository, prNumber, prHeadSha, mainSha });

  const workflowRun = await github.getWorkflowRun(governanceRunId);
  validateWorkflowRun(workflowRun, { repository, governanceRunId, prHeadSha });
  const evidence = await readGovernanceEvidence(github, { governanceRunId, prHeadSha }, runtime);
  const governance = validateAutonomousGovernanceEvidence(evidence, prHeadSha, policy?.autonomousGovernance?.evaluator);
  if (!governance.ok) {
    throw new Error(`exact-head governance artifact is invalid: ${governance.errors.join('; ')}`);
  }

  const files = await github.getPullRequestFiles(prNumber, prHeadSha, pullRequest.base.sha);
  if (files.length !== pullRequest.changed_files) throw new Error('authenticated pull-request file count changed');
  const impact = classifyDeploymentImpact(files, policy?.deployment?.runtimeNeutralPaths);
  if (!impact.valid || impact.deploymentRequired || impact.reason !== 'runtime-neutral-only') {
    throw new Error(`pull request is not eligible for runtime-neutral validation reuse: ${impact.reason}`);
  }

  const [headCommit, mainCommit] = await Promise.all([github.getGitCommit(prHeadSha), github.getGitCommit(mainSha)]);
  const headTree = exactTree(headCommit, prHeadSha, 'pull-request head');
  const mainTree = exactTree(mainCommit, mainSha, 'protected main');
  if (headTree !== mainTree) throw new Error('squash-merge tree differs from the fully validated pull-request head');

  const mainAfter = await github.getProtectedMainRef();
  if (
    mainAfter?.ref !== 'refs/heads/main' ||
    mainAfter?.object?.type !== 'commit' ||
    mainAfter?.object?.sha !== mainSha
  ) {
    throw new Error('protected main changed during validation-reuse verification');
  }

  return Object.freeze({
    profile: 'runtime-neutral-reuse',
    reason: 'trusted-identical-runtime-neutral-tree',
    repository,
    mainSha,
    prNumber,
    prHeadSha,
    governanceRunId,
    treeSha: mainTree,
    fileCount: files.length,
  });
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return {
    repository: values.get('--repository'),
    mainSha: values.get('--main-sha'),
    prNumber: values.get('--pr'),
    prHeadSha: values.get('--pr-head-sha'),
    governanceRunId: values.get('--governance-run-id'),
  };
}

async function runCli() {
  const options = parseOptions(process.argv);
  const github = createTrustedGithubClient({
    repository: options.repository,
    token: process.env.GH_TOKEN,
  });
  const result = await resolveTrustedMainCiProfile(options, github);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `profile=${result.profile}\nreason=${result.reason}\nfile_count=${result.fileCount}\n`,
  );
  console.log(
    `Verified exact-main validation reuse for PR #${result.prNumber}: ${result.fileCount} runtime-neutral file(s), identical tree ${result.treeSha}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : 'main CI profile verification failed');
    process.exitCode = 1;
  });
}
