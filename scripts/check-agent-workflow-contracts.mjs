#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const documentPaths = {
  agents: 'AGENTS.md',
  quality: '.agents/skills/change-quality-gate/SKILL.md',
  delivery: '.agents/skills/autonomous-pr-delivery/SKILL.md',
  github: '.agents/skills/github-cli-devops/SKILL.md',
  azure: '.agents/skills/azure-observability-diagnostics/SKILL.md',
  rollback: '.agents/skills/production-rollback/SKILL.md',
  pullRequest: '.github/pull_request_template.md',
};

const contracts = [
  ['agents', /Bug fixes include a regression test/, 'root instructions require regression tests'],
  ['agents', /ops:preflight-change/, 'root instructions require repository hygiene preflight'],
  ['quality', /A skipped or unavailable check is a limitation, never a pass/, 'quality gate rejects false passes'],
  ['quality', /project-memory-maintainer/, 'quality gate preserves durable project memory'],
  ['delivery', /ops:policy-guardrails:branch/, 'delivery checks the full branch diff'],
  ['github', /Exact-head review procedure/, 'GitHub workflow binds review to the exact head'],
  ['github', /reviewThreads\(first:100\)/, 'GitHub workflow inspects unresolved review threads'],
  ['azure', /aggregate[\s\S]{0,120}(?:health )?counts/i, 'Azure diagnostics includes aggregate runtime metrics'],
  ['rollback', /test "\$hello_status" = "401"/, 'production rollback preserves authentication'],
  ['pullRequest', /Test and validation evidence/, 'pull requests record test evidence'],
  ['pullRequest', /Deployment and rollback/, 'pull requests record deployment and rollback impact'],
];

export function loadAgentWorkflowDocuments() {
  return Object.fromEntries(
    Object.entries(documentPaths).map(([name, path]) => [
      name,
      readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    ]),
  );
}

export function agentWorkflowContractFindings(documents = loadAgentWorkflowDocuments()) {
  return contracts
    .filter(([document, pattern]) => !pattern.test(documents[document] ?? ''))
    .map(([, , message]) => message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = agentWorkflowContractFindings();
  if (findings.length > 0) {
    console.error(`Agent workflow contracts failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Agent workflow contracts passed (${contracts.length} durable behaviors).`);
}
