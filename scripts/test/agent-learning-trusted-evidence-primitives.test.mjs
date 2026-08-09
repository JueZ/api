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

test('paginated histories reject short counts, count drift, duplicates, and service-side caps', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  await assert.rejects(
    trustedClient({
      fetchImpl: async () => jsonResponse({ total_count: 101, check_runs: [{ id: 1 }] }),
    }).getCheckRuns(SHA_A),
    /ended before its declared total count/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        url.endsWith('&page=1')
          ? jsonResponse({ total_count: 101, check_runs: firstPage })
          : jsonResponse({ total_count: 102, check_runs: [{ id: 101 }] }),
    }).getCheckRuns(SHA_A),
    /total count changed during pagination/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        url.endsWith('&page=1')
          ? jsonResponse({ total_count: 101, check_runs: firstPage })
          : jsonResponse({ total_count: 101, check_runs: [{ id: 100 }] }),
    }).getCheckRuns(SHA_A),
    /duplicate record ID/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async () => jsonResponse({ total_count: 10_001, check_runs: [] }),
    }).getCheckRuns(SHA_A),
    /total count is invalid/,
  );
});

test('trusted GitHub client exposes only validated evidence endpoints', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/pulls/7')) return jsonResponse({ number: 7, changed_files: 1, commits: 1 });
    if (url.includes('/files?')) return jsonResponse([{ filename: 'reviewed.mjs' }]);
    if (url.includes('/pulls/7/commits?')) return jsonResponse([{ sha: SHA_A }]);
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
  await client.getWorkflowJob(7);
  await client.getWorkflowRuns(SHA_A);
  await client.getWorkflowJobs(7);
  await client.getWorkflowArtifacts(7);
  await client.getProtectedMainRef();
  await client.compareControllerToMain(SHA_A, SHA_B);

  assert.deepEqual(requests, [
    'https://api.github.com/repos/JueZ/api/pulls/7',
    'https://api.github.com/repos/JueZ/api/pulls/7/files?per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/pulls/7',
    'https://api.github.com/repos/JueZ/api/pulls/7/commits?per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/check-runs/7',
    `https://api.github.com/repos/JueZ/api/commits/${SHA_A}/check-runs?filter=all&per_page=100&page=1`,
    `https://api.github.com/repos/JueZ/api/commits/${SHA_A}/statuses?per_page=100&page=1`,
    'https://api.github.com/repos/JueZ/api/actions/runs/7',
    'https://api.github.com/repos/JueZ/api/actions/jobs/7',
    `https://api.github.com/repos/JueZ/api/actions/runs?head_sha=${SHA_A}&per_page=100&page=1`,
    'https://api.github.com/repos/JueZ/api/actions/runs/7/jobs?filter=all&per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/actions/runs/7/artifacts?per_page=100&page=1',
    'https://api.github.com/repos/JueZ/api/git/ref/heads/main',
    `https://api.github.com/repos/JueZ/api/compare/${SHA_A}...${SHA_B}`,
  ]);
  for (const method of ['getPullRequest', 'getCheckRun', 'getWorkflowRun', 'getWorkflowJob', 'getWorkflowJobs']) {
    assert.throws(() => client[method](0), /positive integer/);
  }
  await assert.rejects(client.downloadArtifact(0), /positive integer/);
});

test('pull-request file and commit histories must satisfy authenticated PR counts', async () => {
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        url.endsWith('/pulls/9')
          ? jsonResponse({ number: 9, changed_files: 2, commits: 1 })
          : jsonResponse([{ filename: 'only-one.mjs' }]),
    }).getPullRequestFiles(9),
    /ended before the authenticated file count/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        url.endsWith('/pulls/9')
          ? jsonResponse({ number: 9, changed_files: 1, commits: 2 })
          : jsonResponse([{ sha: SHA_A }]),
    }).getPullRequestCommits(9),
    /ended before the authenticated commit count/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        url.endsWith('/pulls/9')
          ? jsonResponse({ number: 9, changed_files: 2, commits: 1 })
          : jsonResponse([{ filename: 'duplicate.mjs' }, { filename: 'duplicate.mjs' }]),
    }).getPullRequestFiles(9),
    /duplicate filename/,
  );
});

test('artifact downloads validate one redirect and never forward GitHub credentials', async () => {
  const requests = [];
  const signedUrl =
    'https://productionresultssa0.blob.core.windows.net/actions-results/run/artifact.zip?signature=fixture';
  const client = trustedClient({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return new Response(null, { status: 302, headers: { location: signedUrl } });
      }
      return new Response('trusted archive');
    },
  });
  assert.equal((await client.downloadArtifact(73)).toString('utf8'), 'trusted archive');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.github.com/repos/JueZ/api/actions/artifacts/73/zip');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN_FIXTURE}`);
  assert.equal(requests[1].url, signedUrl);
  assert.equal(requests[1].options.redirect, 'error');
  assert.deepEqual(requests[1].options.headers, { Accept: 'application/zip' });
  assert.equal(Object.hasOwn(requests[1].options.headers, 'Authorization'), false);
});

test('artifact downloads reject wrong redirect status, origins, chains, empty files, and overflow', async () => {
  await assert.rejects(
    trustedClient({ fetchImpl: async () => new Response('{}') }).downloadArtifact(73),
    /artifact redirect failed with HTTP 200/,
  );
  for (const location of [
    'https://attacker.example/actions-results/run/artifact.zip?signature=fixture',
    'http://productionresultssa0.blob.core.windows.net/actions-results/run/artifact.zip?signature=fixture',
    'https://productionresultssa0.blob.core.windows.net/other/artifact.zip?signature=fixture',
    'https://productionresultssa0.blob.core.windows.net/actions-results/run/artifact.zip',
  ]) {
    await assert.rejects(
      trustedClient({
        fetchImpl: async () => new Response(null, { status: 302, headers: { location } }),
      }).downloadArtifact(73),
      /redirect location is not allowlisted/,
    );
  }

  const redirectLocation =
    'https://productionresultssa1.blob.core.windows.net/actions-results/run/artifact.zip?signature=fixture';
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        String(url).startsWith('https://api.github.com/')
          ? new Response(null, { status: 302, headers: { location: redirectLocation } })
          : new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }),
    }).downloadArtifact(73),
    /archive download failed with HTTP 302/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        String(url).startsWith('https://api.github.com/')
          ? new Response(null, { status: 302, headers: { location: redirectLocation } })
          : new Response(''),
    }).downloadArtifact(73),
    /artifact archive is empty/,
  );
  await assert.rejects(
    trustedClient({
      fetchImpl: async (url) =>
        String(url).startsWith('https://api.github.com/')
          ? new Response(null, { status: 302, headers: { location: redirectLocation } })
          : new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    }).downloadArtifact(73),
    /artifact archive exceeds the byte limit/,
  );
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
