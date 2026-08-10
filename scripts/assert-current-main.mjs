#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/i;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function evaluateCurrentMain({ deploymentControlRef, currentMainSha, environmentName }) {
  const errors = [];
  if (!shaPattern.test(deploymentControlRef ?? '')) {
    errors.push('DEPLOYMENT_CONTROL_REF must be a full commit SHA.');
  }
  if (!shaPattern.test(currentMainSha ?? '')) errors.push('Current main did not resolve to a full commit SHA.');
  if (!['test', 'prod'].includes(environmentName)) errors.push('ENVIRONMENT_NAME must be test or prod.');
  if (errors.length > 0) return { ok: false, errors };

  if (deploymentControlRef.toLowerCase() !== currentMainSha.toLowerCase()) {
    errors.push(
      `Deployment controller ${deploymentControlRef.toLowerCase()} is not current main ${currentMainSha.toLowerCase()}.`,
    );
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateDirectDagGuard({ deploymentControlRef, githubSha, confirmedMainRef, environmentName }) {
  const errors = [];
  if (!shaPattern.test(deploymentControlRef ?? '')) {
    errors.push('DEPLOYMENT_CONTROL_REF must be a full commit SHA.');
  }
  if (!shaPattern.test(githubSha ?? '')) errors.push('GITHUB_SHA must be a full commit SHA.');
  if (!['test', 'prod'].includes(environmentName)) errors.push('ENVIRONMENT_NAME must be test or prod.');
  if (errors.length > 0) return { ok: false, errors };

  if (deploymentControlRef.toLowerCase() !== githubSha.toLowerCase()) {
    errors.push('The direct delivery controller must equal the immutable caller SHA.');
  }
  if (environmentName === 'prod') {
    if (!shaPattern.test(confirmedMainRef ?? '')) {
      errors.push('CURRENT_MAIN_CONFIRMED_REF must be a full commit SHA for production.');
    } else if (confirmedMainRef.toLowerCase() !== deploymentControlRef.toLowerCase()) {
      errors.push('The one-shot current-main confirmation does not match the delivery controller.');
    }
  } else if (confirmedMainRef && confirmedMainRef.toLowerCase() !== deploymentControlRef.toLowerCase()) {
    errors.push('A supplied current-main confirmation must match the delivery controller.');
  }
  return { ok: errors.length === 0, errors };
}

export async function assertCurrentMain(env = process.env, run = execFileAsync) {
  if (env.DELIVERY_MODE === 'direct') {
    const decision = evaluateDirectDagGuard({
      deploymentControlRef: env.DEPLOYMENT_CONTROL_REF,
      githubSha: env.GITHUB_SHA,
      confirmedMainRef: env.CURRENT_MAIN_CONFIRMED_REF,
      environmentName: env.ENVIRONMENT_NAME,
    });
    if (!decision.ok) {
      throw new Error(`Direct-DAG deployment guard rejected the mutation:\n- ${decision.errors.join('\n- ')}`);
    }
    console.log('Direct DAG is bound to the immutable caller and its one-shot production main confirmation.');
    return decision;
  }

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

  const decision = evaluateCurrentMain({
    deploymentControlRef: env.DEPLOYMENT_CONTROL_REF,
    currentMainSha,
    environmentName: env.ENVIRONMENT_NAME,
  });
  if (!decision.ok) {
    throw new Error(`Current-main deployment guard rejected the mutation:\n- ${decision.errors.join('\n- ')}`);
  }
  console.log('Deployment controller is the authoritative current main SHA.');
  return decision;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertCurrentMain();
}
