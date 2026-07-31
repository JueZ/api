#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/i;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function evaluateCurrentMain({
  sourceRef,
  currentMainSha,
  environmentName,
  allowRollback = false,
  rollbackWorkflowTrusted = false,
  rollbackProvenanceVerified = false,
  sourceIsAncestor = false,
}) {
  const errors = [];
  if (!shaPattern.test(sourceRef ?? '')) errors.push('SOURCE_REF must be a full commit SHA.');
  if (!shaPattern.test(currentMainSha ?? '')) errors.push('Current main did not resolve to a full commit SHA.');
  if (!['test', 'prod'].includes(environmentName)) errors.push('ENVIRONMENT_NAME must be test or prod.');
  if (errors.length > 0) return { ok: false, errors };

  if (environmentName === 'prod' && allowRollback) {
    if (!rollbackWorkflowTrusted) errors.push('Rollback was not invoked from the dedicated main-branch workflow.');
    if (!rollbackProvenanceVerified) errors.push('Rollback release provenance was not verified.');
    if (!sourceIsAncestor) errors.push('Rollback source must be an ancestor of current main.');
    return { ok: errors.length === 0, errors, rollbackException: errors.length === 0 };
  }
  if (sourceRef.toLowerCase() !== currentMainSha.toLowerCase()) {
    errors.push(`Deployment source ${sourceRef.toLowerCase()} is not current main ${currentMainSha.toLowerCase()}.`);
  }
  return { ok: errors.length === 0, errors, rollbackException: false };
}

export async function assertCurrentMain(env = process.env, run = execFileAsync) {
  const repository = env.GITHUB_REPOSITORY;
  if (!repositoryPattern.test(repository ?? '')) {
    throw new Error('GITHUB_REPOSITORY must use owner/name format.');
  }
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required to verify current main.');

  const { stdout } = await run('gh', ['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha'], {
    env,
    timeout: 30_000,
  });
  const currentMainSha = stdout.trim();
  const allowRollback = env.ALLOW_ROLLBACK === 'true';
  const expectedRollbackWorkflowRef = `${repository}/.github/workflows/rollback-production.yml@refs/heads/main`;
  const rollbackWorkflowTrusted =
    env.GITHUB_WORKFLOW_REF === expectedRollbackWorkflowRef &&
    env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  let sourceIsAncestor = false;
  if (allowRollback && env.ENVIRONMENT_NAME === 'prod' && shaPattern.test(env.SOURCE_REF ?? '')) {
    const comparison = await run(
      'gh',
      ['api', `repos/${repository}/compare/${env.SOURCE_REF}...${currentMainSha}`, '--jq', '.merge_base_commit.sha'],
      { env, timeout: 30_000 },
    );
    sourceIsAncestor = comparison.stdout.trim().toLowerCase() === env.SOURCE_REF.toLowerCase();
  }

  const decision = evaluateCurrentMain({
    sourceRef: env.SOURCE_REF,
    currentMainSha,
    environmentName: env.ENVIRONMENT_NAME,
    allowRollback,
    rollbackWorkflowTrusted,
    rollbackProvenanceVerified: env.ROLLBACK_PROVENANCE_VERIFIED === 'true',
    sourceIsAncestor,
  });
  if (!decision.ok) {
    throw new Error(`Current-main deployment guard rejected the mutation:\n- ${decision.errors.join('\n- ')}`);
  }
  if (decision.rollbackException) {
    console.log('Current-main equality guard skipped for the dedicated production rollback workflow.');
  } else {
    console.log('Deployment source is the authoritative current main SHA.');
  }
  return decision;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertCurrentMain();
}
