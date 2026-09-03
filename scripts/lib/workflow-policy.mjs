import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { loadAutonomousPolicy } from './autonomous-policy.mjs';

export const DEFAULT_WORKFLOW_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');

const APPROVED_SECRETS = new Set([
  'BRING_CLIENT_API_KEY',
  'GOOGLE_WEATHER_API_KEY',
  'BRING_CONFIRMATION_HMAC_KEY',
  'BRING_EMAIL',
  'BRING_MUTATION_ENCRYPTION_KEY',
  'BRING_PASSWORD',
  'OPENAI_API_KEY',
  'REDDIT_CLIENT_SECRET',
  'WLH_BASE_URL',
]);
const OPENAI_RUNTIME_WORKFLOWS = new Set(['delivery-v2.yml', 'deploy-environment.yml']);
const REPOSITORY_DISPATCH_WORKFLOWS = new Set(['bring-readonly-canary.yml']);
const WORKFLOW_RUN_WORKFLOWS = new Set(['repair-triage.yml']);
const SAFE_EVENTS = new Set([
  'pull_request',
  'push',
  'schedule',
  'workflow_call',
  'workflow_dispatch',
  'workflow_run',
  'repository_dispatch',
]);
const BUILTIN_GITHUB_TOKENS = new Set(['${{ github.token }}', '${{ secrets.GITHUB_TOKEN }}']);
const GITHUB_AUTH_KEYS = new Set(['authorization', 'github_token', 'gh_token']);
const TOKEN_MINTING_ACTION =
  /(?:actions\/create-github-app-token|tibdex\/github-app-token|peter-murray\/workflow-application-token)@/i;

export async function workflowPolicyFindings(directory = DEFAULT_WORKFLOW_DIRECTORY, policy = loadAutonomousPolicy()) {
  const findings = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const source = await readFile(join(directory, entry.name), 'utf8');
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) {
      findings.push(...document.errors.map((error) => `${entry.name}: invalid YAML: ${error.message}`));
      continue;
    }
    const workflow = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(workflow)) {
      findings.push(`${entry.name}: workflow must be a YAML mapping`);
      continue;
    }
    if (!isRecord(workflow.permissions)) {
      findings.push(`${entry.name}: top-level permissions must be an explicit mapping`);
    }
    const events = workflowEvents(workflow.on);
    if (events.length === 0) findings.push(`${entry.name}: workflow must declare an event`);
    for (const event of events) {
      if (!SAFE_EVENTS.has(event)) findings.push(`${entry.name}: unsupported workflow event ${event}`);
    }
    if (events.includes('pull_request_target')) {
      findings.push(`${entry.name}: pull_request_target is forbidden`);
    }
    if (events.includes('repository_dispatch') && !REPOSITORY_DISPATCH_WORKFLOWS.has(entry.name)) {
      findings.push(`${entry.name}: repository_dispatch is not approved for this workflow`);
    }
    if (events.includes('workflow_run') && !WORKFLOW_RUN_WORKFLOWS.has(entry.name)) {
      findings.push(`${entry.name}: workflow_run is reserved for the repair queue`);
    }

    const jobs = workflow.jobs;
    if (!isRecord(jobs)) {
      findings.push(`${entry.name}: jobs must be a mapping`);
      continue;
    }
    for (const [jobName, job] of Object.entries(jobs)) {
      if (!isRecord(job)) {
        findings.push(`${entry.name}:${jobName}: job must be a mapping`);
        continue;
      }
      if (job.permissions !== undefined && !isRecord(job.permissions)) {
        findings.push(`${entry.name}:${jobName}: job permissions must be an explicit mapping`);
      }
      const permissions = isRecord(job.permissions) ? job.permissions : workflow.permissions;
      if (permissions === 'write-all' || Object.values(permissions ?? {}).includes('write-all')) {
        findings.push(`${entry.name}:${jobName}: write-all permissions are forbidden`);
      }
      if (permissions?.checks === 'write') {
        findings.push(`${entry.name}:${jobName}: raw check-run writers are forbidden`);
      }
      if (events.includes('pull_request') && hasWritePermission(permissions) && hasRunStep(job)) {
        findings.push(`${entry.name}:${jobName}: untrusted pull-request code must not run with write credentials`);
      }
    }
    inspectValue(workflow, entry.name, [], findings);
  }

  if (policy.workflowSecurity?.actionsPinnedToFullSha !== true) {
    findings.push('workflow policy must require full-SHA action pins');
  }
  return findings;
}

function workflowEvents(value) {
  if (typeof value === 'string') return [value];
  return isRecord(value) ? Object.keys(value) : [];
}

function hasWritePermission(permissions) {
  return isRecord(permissions) && Object.values(permissions).some((value) => value === 'write');
}

function hasRunStep(job) {
  return Array.isArray(job.steps) && job.steps.some((step) => isRecord(step) && typeof step.run === 'string');
}

function inspectValue(value, workflowName, path, findings) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectValue(entry, workflowName, [...path, String(index)], findings));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const location = `${workflowName}:${childPath.join('.')}`;
    if (key === 'uses' && typeof child === 'string') {
      if (TOKEN_MINTING_ACTION.test(child)) findings.push(`${location}: GitHub token minting actions are forbidden`);
      if (!child.startsWith('./') && !/^[^\s@]+@[0-9a-f]{40}$/.test(child)) {
        findings.push(`${location}: external actions must be pinned to a full commit SHA`);
      }
    }
    if (key.toLowerCase() === 'secrets' && child === 'inherit') {
      findings.push(`${location}: reusable workflows must not inherit all secrets`);
    }
    if (GITHUB_AUTH_KEYS.has(key.toLowerCase()) && typeof child === 'string') {
      const token = child.trim();
      const allowed =
        BUILTIN_GITHUB_TOKENS.has(token) ||
        [...BUILTIN_GITHUB_TOKENS].some((candidate) => token.toLowerCase() === `bearer ${candidate}`.toLowerCase());
      if (!allowed) findings.push(`${location}: GitHub authentication must use the built-in job token`);
    }
    if (typeof child === 'string') {
      inspectSecretExpressions(child, workflowName, location, findings);
      if (/(?:^|[\s/"'])check-runs(?:$|[\s/?"'])/i.test(child)) {
        findings.push(`${location}: raw check-run API access is forbidden`);
      }
      if (/gh\s+(?:auth|api)[^\n]*(?:app installation|access[_ -]?token)|jwt[^\n]*github/i.test(child)) {
        findings.push(`${location}: shell-based GitHub token minting is forbidden`);
      }
    }
    inspectValue(child, workflowName, childPath, findings);
  }
}

function inspectSecretExpressions(value, workflowName, location, findings) {
  for (const match of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const expression = match[1];
    if (!/\bsecrets\b/.test(expression)) continue;
    const names = [...expression.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((secret) => secret[1]);
    if (/\bsecrets\b/.test(expression.replace(/\bsecrets\.[A-Za-z_][A-Za-z0-9_]*\b/g, ''))) {
      findings.push(`${location}: dynamic or bracket workflow secret access is forbidden`);
    }
    for (const name of names) {
      if (name === 'GITHUB_TOKEN') continue;
      if (!APPROVED_SECRETS.has(name)) findings.push(`${location}: workflow secret ${name} is not approved`);
      if (name === 'OPENAI_API_KEY' && !OPENAI_RUNTIME_WORKFLOWS.has(workflowName)) {
        findings.push(`${location}: OPENAI_API_KEY is restricted to runtime deployment`);
      }
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
