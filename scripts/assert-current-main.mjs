#!/usr/bin/env node
import process from 'node:process';

const shaPattern = /^[0-9a-f]{40}$/i;

export function evaluateDirectDagGuard({ deploymentControlRef, githubSha, confirmedMainRef, environmentName }) {
  const errors = [];
  if (!shaPattern.test(deploymentControlRef ?? '')) {
    errors.push('DEPLOYMENT_CONTROL_REF must be a full commit SHA.');
  }
  if (!shaPattern.test(githubSha ?? '')) errors.push('GITHUB_SHA must be a full commit SHA.');
  if (!['test', 'prod'].includes(environmentName)) errors.push('ENVIRONMENT_NAME must be test or prod.');
  if (errors.length > 0) return { ok: false, errors };

  if (deploymentControlRef.toLowerCase() !== githubSha.toLowerCase()) {
    errors.push('The deployment controller must equal the immutable Delivery v2 caller SHA.');
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

export async function assertCurrentMain(env = process.env) {
  const decision = evaluateDirectDagGuard({
    deploymentControlRef: env.DEPLOYMENT_CONTROL_REF,
    githubSha: env.GITHUB_SHA,
    confirmedMainRef: env.CURRENT_MAIN_CONFIRMED_REF,
    environmentName: env.ENVIRONMENT_NAME,
  });
  if (!decision.ok) {
    throw new Error(`Direct-DAG deployment guard rejected the mutation:\n- ${decision.errors.join('\n- ')}`);
  }
  console.log('Deployment is bound to the immutable caller and one-shot production main confirmation.');
  return decision;
}

if (import.meta.url === `file://${process.argv[1]}`) await assertCurrentMain();
