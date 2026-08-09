import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  allowedRuntimeOrigin,
  createTrustedGithubClient,
  fetchAllowedRuntimeHealth,
  parseStrictJson,
  protectedMainControllerFindings,
  readBoundedResponseText,
  readSingleJsonArchive,
  TRUSTED_EVIDENCE_REPOSITORY,
  TRUSTED_RUNTIME_HOSTS,
  verifyArtifactArchiveDigest,
} from '../agent-learning/trusted-evidence-primitives.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TOKEN_FIXTURE = ['synthetic', 'github', 'token'].join('-');

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function trustedClient(overrides = {}) {
  return createTrustedGithubClient({
    repository: TRUSTED_EVIDENCE_REPOSITORY,
    token: TOKEN_FIXTURE,
    fetchImpl: async () => jsonResponse({}),
    spawn: () => ({ status: 0, stdout: Buffer.from('zip') }),
    ...overrides,
  });
}

test('strict JSON rejects malformed and duplicate-key documents', () => {
  assert.deepEqual(parseStrictJson('{"ok":true}', 'fixture'), { ok: true });
  assert.throws(() => parseStrictJson('{broken', 'fixture'), /fixture must be strict JSON/);
  assert.throws(
    () => parseStrictJson('{"same":true,"same":false}', 'fixture'),
    /fixture contains duplicate or invalid keys/,
  );
});

test('bounded response reads reject invalid declarations and streamed overflow', async () => {
  assert.equal(await readBoundedResponseText(new Response('safe'), 4, 'fixture'), 'safe');
  await assert.rejects(
    readBoundedResponseText(new Response('safe', { headers: { 'content-length': '5' } }), 4, 'fixture'),
    /exceeds the byte limit/,
  );
  await assert.rejects(
    readBoundedResponseText(new Response('safe', { headers: { 'content-length': 'invalid' } }), 4, 'fixture'),
    /invalid content length/,
  );
  await assert.rejects(readBoundedResponseText(new Response('overflow'), 4, 'fixture'), /exceeds the byte limit/);
});

test('trusted GitHub client is repository-bound and requires an explicit token', () => {
  assert.throws(
    () => createTrustedGithubClient({ repository: 'attacker/repository', token: TOKEN_FIXTURE }),
    /repository-bound to JueZ\/api/,
  );
  assert.throws(
    () => createTrustedGithubClient({ repository: TRUSTED_EVIDENCE_REPOSITORY }),
    /require the built-in GitHub token/,
  );
  assert.equal(Object.hasOwn(trustedClient(), 'getJson'), false, 'unrestricted authenticated reads must stay private');
});

test('trusted GitHub reads use fixed repository paths, no redirects, and bounded methods', async () => {
  const requests = [];
  const content = Buffer.from('reviewed workflow bytes\n');
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/contents/')) {
      return jsonResponse({
        type: 'file',
        path: '.github/workflows/ci.yml',
        encoding: 'base64',
        size: content.length,
        content: content.toString('base64'),
      });
    }
    return jsonResponse({ id: 41 });
  };
  const client = trustedClient({ fetchImpl });

  assert.deepEqual(await client.getPullRequest(41), { id: 41 });
  assert.equal(
    await client.getFile('.github/workflows/ci.yml', SHA_A, ['.github/workflows/ci.yml']),
    content.toString('utf8'),
  );
  assert.deepEqual(await client.getFileDigest('.github/workflows/ci.yml', SHA_A, ['.github/workflows/ci.yml']), {
    path: '.github/workflows/ci.yml',
    ref: SHA_A,
    sha256: createHash('sha256').update(content).digest('hex'),
  });

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      'https://api.github.com/repos/JueZ/api/pulls/41',
      `https://api.github.com/repos/JueZ/api/contents/.github/workflows/ci.yml?ref=${SHA_A}`,
      `https://api.github.com/repos/JueZ/api/contents/.github/workflows/ci.yml?ref=${SHA_A}`,
    ],
  );
  for (const request of requests) {
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN_FIXTURE}`);
    assert.ok(request.options.signal instanceof AbortSignal);
  }
});

test('repository files fail closed on mutable refs, traversal, wrong identity, and decoded-size mismatch', async () => {
  const allowedPaths = ['docs/agent-learning/program.md'];
  await assert.rejects(trustedClient().getFile('../program.md', SHA_A, allowedPaths), /path is not allowlisted/);
  await assert.rejects(trustedClient().getFile('../program.md', SHA_A, ['../program.md']), /path is not allowlisted/);
  await assert.rejects(
    trustedClient().getFile('docs\\program.md', SHA_A, ['docs\\program.md']),
    /path is not allowlisted/,
  );
  await assert.rejects(
    trustedClient().getFile(allowedPaths[0], 'main', allowedPaths),
    /ref must be an exact lowercase SHA/,
  );

  const wrongIdentity = trustedClient({
    fetchImpl: async () =>
      jsonResponse({ type: 'file', path: 'other.md', encoding: 'base64', size: 4, content: 'c2FmZQ==' }),
  });
  await assert.rejects(wrongIdentity.getFile(allowedPaths[0], SHA_A, allowedPaths), /identity is invalid/);

  const wrongSize = trustedClient({
    fetchImpl: async () =>
      jsonResponse({
        type: 'file',
        path: allowedPaths[0],
        encoding: 'base64',
        size: 3,
        content: 'c2FmZQ==',
      }),
  });
  await assert.rejects(wrongSize.getFile(allowedPaths[0], SHA_A, allowedPaths), /content size does not match/);
});

test('complete GitHub histories paginate and remain exact-SHA bound', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('&page=1')) return jsonResponse({ total_count: 101, check_runs: firstPage });
    return jsonResponse({ total_count: 101, check_runs: [{ id: 101 }] });
  };
  const client = trustedClient({ fetchImpl });

  assert.equal((await client.getCheckRuns(SHA_A)).length, 101);
  assert.deepEqual(requests, [
    `https://api.github.com/repos/JueZ/api/commits/${SHA_A}/check-runs?filter=all&per_page=100&page=1`,
    `https://api.github.com/repos/JueZ/api/commits/${SHA_A}/check-runs?filter=all&per_page=100&page=2`,
  ]);
  assert.throws(() => client.getCheckRuns('main'), /must be an exact lowercase SHA/);
  assert.throws(() => client.getWorkflowRuns(`${SHA_A.toUpperCase()}`), /must be an exact lowercase SHA/);
});

test('trusted GitHub client exposes only validated evidence endpoints', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes('/files?') || url.includes('/commits?')) return jsonResponse([]);
    if (url.includes('/check-runs?')) return jsonResponse({ check_runs: [] });
    if (url.includes('/statuses?')) return jsonResponse([]);
    if (url.includes('/actions/runs?')) return jsonResponse({ workflow_runs: [] });
    if (url.includes('/jobs?')) return jsonResponse({ jobs: [] });
    if (url.includes('/artifacts?')) return jsonResponse({ artifacts: [] });
    return jsonResponse({ id: 7 });
  };
  const client = trustedClient({ fetchImpl });
  await client.getPullRequestFiles(7);
  await client.getPullRequestCommits(7);
  await client.getCheckRun(7);
  await client.getCheckRuns(SHA_A);
  await client.getCommitStatuses(SHA_A);
  await client.getWorkflowRun(7);
  await client.getWorkflowRuns(SHA_A);
  await client.getWorkflowJobs(7);
  await client.getWorkflowArtifacts(7);
  await client.getProtectedMainRef();
  await client.compareControllerToMain(SHA_A, SHA_B);

  assert.deepEqual(requests, [
    'https://api.github.com/repos/JueZ/api/pulls/7/files?per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/pulls/7/commits?per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/check-runs/7',
    `https://api.github.com/repos/JueZ/api/commits/${SHA_A}/check-runs?filter=all&per_page=100&page=1`,
    `https://api.github.com/repos/JueZ/api/commits/${SHA_A}/statuses?per_page=100&page=1`,
    'https://api.github.com/repos/JueZ/api/actions/runs/7',
    `https://api.github.com/repos/JueZ/api/actions/runs?head_sha=${SHA_A}&per_page=100&page=1`,
    'https://api.github.com/repos/JueZ/api/actions/runs/7/jobs?filter=all&per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/actions/runs/7/artifacts?per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/git/ref/heads/main',
    `https://api.github.com/repos/JueZ/api/compare/${SHA_A}...${SHA_B}`,
  ]);
  for (const method of ['getPullRequest', 'getCheckRun', 'getWorkflowRun', 'getWorkflowJobs', 'downloadArtifact']) {
    assert.throws(() => client[method](0), /positive integer/);
  }
});

test('artifact downloads pass only an explicit environment allowlist and enforce byte bounds', () => {
  let invocation;
  const client = trustedClient({
    spawn: (...args) => {
      invocation = args;
      return { status: 0, signal: null, stdout: Buffer.from('trusted archive') };
    },
  });
  assert.equal(client.downloadArtifact(73).toString('utf8'), 'trusted archive');
  assert.deepEqual(invocation[0], 'gh');
  assert.deepEqual(invocation[1], ['api', 'repos/JueZ/api/actions/artifacts/73/zip']);
  assert.equal(invocation[2].encoding, null);
  assert.equal(invocation[2].env.GH_TOKEN, TOKEN_FIXTURE);
  const allowedEnvironmentKeys = new Set(['GH_HOST', 'GH_TOKEN', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME']);
  assert.ok(Object.keys(invocation[2].env).every((key) => allowedEnvironmentKeys.has(key)));

  const failed = trustedClient({ spawn: () => ({ status: 1, signal: null, stdout: Buffer.alloc(0) }) });
  assert.throws(() => failed.downloadArtifact(73), /authenticated artifact download failed/);
  const oversized = trustedClient({
    spawn: () => ({ status: 0, signal: null, stdout: Buffer.alloc(2 * 1024 * 1024 + 1) }),
  });
  assert.throws(() => oversized.downloadArtifact(73), /archive size is invalid/);
});

test('runtime origins are fixed and reject credentials, paths, query data, ports, and aliases', () => {
  const testOrigin = `https://${TRUSTED_RUNTIME_HOSTS.test}`;
  assert.equal(allowedRuntimeOrigin('test', testOrigin), testOrigin);
  assert.equal(allowedRuntimeOrigin('test', `${testOrigin}/`), testOrigin);
  for (const value of [
    'http://func-api-catalogue-test-iwt54bovfzvrc.azurewebsites.net',
    'https://attacker.example',
    `${testOrigin}/health`,
    `${testOrigin}?target=attacker`,
    `${testOrigin}#fragment`,
    `https://user:password@${TRUSTED_RUNTIME_HOSTS.test}`,
    `https://${TRUSTED_RUNTIME_HOSTS.test}:443`,
  ]) {
    assert.equal(allowedRuntimeOrigin('test', value), '', value);
  }
  assert.equal(allowedRuntimeOrigin('preview', testOrigin), '');
});

test('runtime health uses the fixed endpoint, disables redirects, and bounds JSON', async () => {
  const requests = [];
  const origin = `https://${TRUSTED_RUNTIME_HOSTS.prod}`;
  const health = await fetchAllowedRuntimeHealth('prod', origin, async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({ status: 'ok' });
  });
  assert.deepEqual(health, { status: 'ok' });
  assert.equal(requests[0].url, `${origin}/health`);
  assert.equal(requests[0].options.redirect, 'error');

  await assert.rejects(
    fetchAllowedRuntimeHealth('prod', 'https://attacker.example', async () => jsonResponse({})),
    /origin is not allowlisted/,
  );
  await assert.rejects(
    fetchAllowedRuntimeHealth('prod', origin, async () => jsonResponse({}, { status: 302 })),
    /returned HTTP 302/,
  );
  await assert.rejects(
    fetchAllowedRuntimeHealth('prod', origin, async () => new Response('x'.repeat(64 * 1024 + 1))),
    /exceeds the byte limit/,
  );
});

test('artifact digest proof binds authenticated metadata, recorded evidence, and exact bytes', () => {
  const archive = Buffer.from('trusted archive fixture');
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  assert.equal(verifyArtifactArchiveDigest(archive, digest, digest), digest);
  assert.throws(
    () => verifyArtifactArchiveDigest(archive, digest, `sha256:${'0'.repeat(64)}`),
    /authenticated and recorded digests differ/,
  );
  assert.throws(
    () => verifyArtifactArchiveDigest(Buffer.from('different'), digest, digest),
    /does not match exact bytes/,
  );
  assert.throws(() => verifyArtifactArchiveDigest(archive, 'mutable', 'mutable'), /digest is invalid/);
});

test('single-JSON artifact extraction rejects extra entries and cleans its temporary directory', async () => {
  const archive = Buffer.from('synthetic zip bytes');
  let archivePath;
  const spawn = (_command, args) => {
    archivePath = args[1];
    if (args[0] === '-Z1') return { status: 0, stdout: 'release-ledger-test.json\n' };
    return { status: 0, stdout: '{"status":"passed"}' };
  };
  assert.deepEqual(await readSingleJsonArchive(archive, 'release-ledger-test.json', { spawn, label: 'test ledger' }), {
    status: 'passed',
  });
  assert.equal(existsSync(archivePath), false);

  await assert.rejects(
    readSingleJsonArchive(archive, '../ledger.json', { spawn, label: 'test ledger' }),
    /expected entry is invalid/,
  );
  await assert.rejects(
    readSingleJsonArchive(archive, 'release-ledger-test.json', {
      spawn: (_command, args) =>
        args[0] === '-Z1'
          ? { status: 0, stdout: 'release-ledger-test.json\nuntrusted.json\n' }
          : { status: 0, stdout: '{}' },
      label: 'test ledger',
    }),
    /must contain only release-ledger-test.json/,
  );
});

test('controller workflow ancestry requires stable protected main and exact comparison identity', () => {
  const main = { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_B } };
  const comparison = {
    status: 'ahead',
    base_commit: { sha: SHA_A },
    merge_base_commit: { sha: SHA_A },
    head_commit: { sha: SHA_B },
    behind_by: 0,
    ahead_by: 7,
    url: `https://api.github.com/repos/JueZ/api/compare/${SHA_A}...${SHA_B}`,
  };
  assert.deepEqual(
    protectedMainControllerFindings(main, structuredClone(main), comparison, { controllerSha: SHA_A }),
    [],
  );

  const changedMain = structuredClone(main);
  changedMain.object.sha = 'c'.repeat(40);
  const findings = protectedMainControllerFindings(
    main,
    changedMain,
    { ...comparison, status: 'diverged' },
    {
      controllerSha: SHA_A,
    },
  );
  assert.ok(findings.includes('protected main changed during trusted verification'));
  assert.ok(findings.includes('controller workflow SHA is not an ancestor of protected main'));
});
