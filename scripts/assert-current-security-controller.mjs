#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { deploymentHoldDecision } from './enforce-security-deployment-hold.mjs';

export const SECURITY_CONTROLLER_REPOSITORY = 'JueZ/api';
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

function safeSha(value) {
  return typeof value === 'string' && FULL_SHA_PATTERN.test(value) ? value : null;
}

export function localSecurityControllerFindings(
  { repository, ref, runAttempt, workflowSha, checkoutSha },
  liveMainSha,
) {
  const findings = [];
  if (repository !== SECURITY_CONTROLLER_REPOSITORY) findings.push('repository_mismatch');
  if (ref !== 'refs/heads/main') findings.push('not_main_ref');
  if (runAttempt !== '1') findings.push('run_attempt_not_one');
  if (!safeSha(workflowSha)) findings.push('invalid_workflow_sha');
  if (!safeSha(checkoutSha)) findings.push('invalid_checkout_sha');
  if (!safeSha(liveMainSha)) findings.push('invalid_live_main_sha');
  if (safeSha(workflowSha) && safeSha(liveMainSha) && workflowSha !== liveMainSha) {
    findings.push('workflow_sha_not_current_main');
  }
  if (safeSha(checkoutSha) && safeSha(liveMainSha) && checkoutSha !== liveMainSha) {
    findings.push('checkout_sha_not_current_main');
  }
  return findings;
}

export async function verifyCurrentSecurityController({
  repository = process.env.GITHUB_REPOSITORY,
  ref = process.env.GITHUB_REF,
  runAttempt = process.env.GITHUB_RUN_ATTEMPT,
  workflowSha = process.env.GITHUB_WORKFLOW_SHA,
  token = process.env.GH_TOKEN,
  checkoutSha,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const findings = [];
  if (repository !== SECURITY_CONTROLLER_REPOSITORY) findings.push('repository_mismatch');
  if (typeof token !== 'string' || token.length === 0) findings.push('github_token_unavailable');
  if (typeof fetchImpl !== 'function') findings.push('github_api_unavailable');
  if (findings.length > 0) return { ok: false, findings };

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'juez-current-security-controller',
  };
  const request = async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${SECURITY_CONTROLLER_REPOSITORY}${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`github_api_http_${response.status}`);
    return response.json();
  };

  try {
    const mainRef = await request('/git/ref/heads/main');
    const liveMainSha = safeSha(mainRef?.object?.sha);
    findings.push(
      ...localSecurityControllerFindings({ repository, ref, runAttempt, workflowSha, checkoutSha }, liveMainSha),
    );
    if (findings.length > 0) return { ok: false, findings };

    const holdFile = await request(`/contents/.github/security-deployment-hold.json?ref=${liveMainSha}`);
    let hold;
    try {
      if (holdFile?.encoding !== 'base64' || typeof holdFile.content !== 'string') throw new Error();
      hold = JSON.parse(Buffer.from(holdFile.content.replaceAll('\n', ''), 'base64').toString('utf8'));
    } catch {
      return { ok: false, findings: ['invalid_live_hold_document'] };
    }
    const holdDecision = deploymentHoldDecision(hold, { now });
    if (holdDecision.blocked) {
      return {
        ok: false,
        findings: [holdDecision.reason === 'active_incident' ? 'active_security_hold' : 'invalid_live_hold_policy'],
      };
    }
    return { ok: true, findings: [] };
  } catch (error) {
    const code =
      error instanceof Error && /^github_api_http_\d+$/.test(error.message) ? error.message : 'github_api_failure';
    return { ok: false, findings: [code] };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length !== 2) {
    console.error('Usage: assert-current-security-controller.mjs');
    process.exit(2);
  }
  let checkoutSha;
  try {
    checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('Current security controller rejected the run: checkout identity is unavailable.');
    process.exit(1);
  }
  const result = await verifyCurrentSecurityController({ checkoutSha });
  if (!result.ok) {
    console.error(`Current security controller rejected the run: ${result.findings.join(', ')}.`);
    process.exit(1);
  }
  console.log('Current main security controller and deployment hold are verified.');
}
