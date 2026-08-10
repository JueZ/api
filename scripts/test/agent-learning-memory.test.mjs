import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import {
  checkLiveMemoryClaims,
  createGitHubMemoryClient,
  inspectMemoryText,
} from '../agent-learning/check-memory-freshness.mjs';

function codes(text, options) {
  return inspectMemoryText(text, options).findings.map((finding) => finding.code);
}

test('offline memory validation rejects malformed dates, duplicate state, and contradictions', () => {
  const text = `# Current state

## 2026-02-31 Impossible date

<!-- project-memory-state id="delivery" status="active" asOf="2026-08-09" -->
<!-- project-memory-state id="delivery" status="active" asOf="2026-08-09" -->
<!-- project-memory-state id="delivery" status="superseded" asOf="2026-08-09" -->
`;
  assert.deepEqual(codes(text, { activeStatusFile: false }), [
    'malformed-dated-heading',
    'duplicate-active-state',
    'contradictory-state',
  ]);
});

test('offline memory validation requires asOf and exact live references', () => {
  assert.ok(codes('# Known issues\n\nStatus: open\n').includes('status-without-as-of'));
  const findings = codes(`<!-- project-memory-asOf: 2026-08-09 -->
# Current state

PR #invalid remains open.
Actions run \`pending\` remains queued.
Exact head \`abc1234\` passed.
`);
  assert.deepEqual(findings, ['invalid-pr-reference', 'invalid-run-reference', 'invalid-sha-reference']);
});

test('live memory validation reports contradictions and unavailable evidence truthfully', async () => {
  const pullRequestClaims = inspectMemoryText('PR #42 remains open.').claims;
  const contradiction = await checkLiveMemoryClaims(pullRequestClaims, {
    getPullRequest: async () => ({ state: 'closed', merged_at: '2026-08-09T00:00:00Z' }),
  });
  assert.equal(contradiction.status, 'failing');
  assert.equal(contradiction.contradictions[0].observedState, 'merged');

  const workflowClaims = inspectMemoryText('Workflow run `42` remains queued.').claims;
  const blocked = await checkLiveMemoryClaims(workflowClaims, {
    getWorkflowRun: async () => {
      throw new Error('GitHub metadata request failed with HTTP 503.');
    },
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blocker, /HTTP 503/);
});

test('GitHub memory reads are repository-bound, authenticated, bounded, and redirect-denying', async () => {
  const requests = [];
  const fixtureToken = ['fixture', 'token'].join('-');
  const authorizationHeader = ['Author', 'ization'].join('');
  const client = createGitHubMemoryClient({
    repository: 'JueZ/api',
    token: fixtureToken,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response('[]', { status: 200, headers: { 'content-length': '2' } });
    },
  });
  assert.deepEqual(await client.listIssues({ state: 'open', labels: ['codex-repair'] }), []);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.github\.com\/repos\/JueZ\/api\/issues\?/);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers[authorizationHeader], `Bearer ${fixtureToken}`);
});

test('legacy learning validation is manual, read-only, deterministic, and non-required', async () => {
  const source = await readFile('.github/workflows/agent-learning-status.yml', 'utf8');
  const workflow = parse(source);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.match(source, /ref: main/);
  assert.match(source, /npm run agent:learning:validate/);
  assert.doesNotMatch(source, /issues: write|status-report|verify-program-evidence|OPENAI_API_KEY|codex\s+exec/i);
});
