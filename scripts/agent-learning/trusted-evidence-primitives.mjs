import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

export const TRUSTED_EVIDENCE_REPOSITORY = 'JueZ/api';
export const TRUSTED_RUNTIME_HOSTS = Object.freeze({
  test: 'func-api-catalogue-test-iwt54bovfzvrc.azurewebsites.net',
  prod: 'func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net',
});

const EXACT_SHA = /^[0-9a-f]{40}$/;
const EXACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ARCHIVE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/;
const TRUSTED_ARTIFACT_DOWNLOAD_HOST = /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;
const MAX_GITHUB_JSON_BYTES = 10 * 1024 * 1024;
const MAX_REPOSITORY_FILE_BYTES = 512 * 1024;
const MAX_ARTIFACT_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_HEALTH_BYTES = 64 * 1024;

function exactPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requireExactPositiveInteger(value, label) {
  if (!exactPositiveInteger(value)) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireExactSha(value, label) {
  if (!EXACT_SHA.test(value || '')) throw new Error(`${label} must be an exact lowercase SHA`);
  return value;
}

function requireAllowlistedPath(path, allowedPaths, label) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new Error(`${label} allowlist must be non-empty`);
  }
  const segments = typeof path === 'string' ? path.split('/') : [];
  const hasControlCharacter =
    typeof path === 'string' &&
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const safePath =
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !hasControlCharacter &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  if (!safePath || !allowedPaths.includes(path)) {
    throw new Error(`${label} path is not allowlisted for trusted verification`);
  }
  return path;
}

function encodedRepositoryPath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function parseStrictJson(source, label = 'JSON document') {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be strict JSON`);
  }
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${label} contains duplicate or invalid keys`);
  return value;
}

export async function readBoundedResponseText(response, maximumBytes, label) {
  return (await readBoundedResponseBuffer(response, maximumBytes, label)).toString('utf8');
}

export async function readBoundedResponseBuffer(response, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`${label} byte limit is invalid`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error(`${label} has an invalid content length`);
    if (declared > maximumBytes) throw new Error(`${label} exceeds the byte limit`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) throw new Error(`${label} exceeds the byte limit`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) throw new Error(`${label} exceeds the byte limit`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, received);
}

export function createTrustedGithubClient({ repository, token, fetchImpl = fetch } = {}) {
  if (repository !== TRUSTED_EVIDENCE_REPOSITORY) {
    throw new Error(`trusted evidence reads are repository-bound to ${TRUSTED_EVIDENCE_REPOSITORY}`);
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('trusted evidence reads require the built-in GitHub token');
  }

  const base = `https://api.github.com/repos/${repository}`;
  const headers = Object.freeze({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'JueZ-api-trusted-evidence',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  async function getJson(path) {
    const response = await fetchImpl(`${base}${path}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`authenticated GitHub request failed with HTTP ${response.status}`);
    return parseStrictJson(
      await readBoundedResponseText(response, MAX_GITHUB_JSON_BYTES, 'GitHub response'),
      'GitHub response',
    );
  }

  async function getPaginatedCollection(path, key, label) {
    const records = [];
    const recordIds = new Set();
    let countMode;
    let declaredTotal;
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await getJson(`${path}${separator}per_page=100&page=${page}`);
      const rows = key ? response?.[key] : response;
      if (!Array.isArray(rows)) throw new Error(`${label} response is invalid`);

      const hasTotal = key !== undefined && Object.hasOwn(response, 'total_count');
      if (page === 1) countMode = hasTotal;
      if (hasTotal !== countMode) throw new Error(`${label} total-count presence changed during pagination`);
      if (hasTotal) {
        const total = response.total_count;
        if (!Number.isSafeInteger(total) || total < 0 || total > 10_000) {
          throw new Error(`${label} total count is invalid`);
        }
        if (declaredTotal === undefined) declaredTotal = total;
        if (total !== declaredTotal) throw new Error(`${label} total count changed during pagination`);
      }

      for (const row of rows) {
        if (!exactPositiveInteger(row?.id)) throw new Error(`${label} contains a record without an exact ID`);
        if (recordIds.has(row.id)) throw new Error(`${label} contains a duplicate record ID`);
        recordIds.add(row.id);
        records.push(row);
      }

      if (countMode) {
        if (records.length > declaredTotal) throw new Error(`${label} contains more records than its total count`);
        if (records.length === declaredTotal) return records;
        if (rows.length < 100) throw new Error(`${label} ended before its declared total count`);
      } else if (rows.length < 100) {
        return records;
      }
    }
    throw new Error(`${label} exceeds the 10000-record verification limit`);
  }

  async function getBoundFile(path, ref, allowedPaths) {
    requireAllowlistedPath(path, allowedPaths, 'repository file');
    requireExactSha(ref, 'repository file ref');
    const record = await getJson(`/contents/${encodedRepositoryPath(path)}?ref=${ref}`);
    if (record?.type !== 'file' || record?.path !== path || record?.encoding !== 'base64') {
      throw new Error(`repository file identity is invalid: ${path}`);
    }
    if (!Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_REPOSITORY_FILE_BYTES) {
      throw new Error(`repository file size is invalid: ${path}`);
    }
    const content = Buffer.from(String(record.content || '').replaceAll('\n', ''), 'base64');
    if (content.length !== record.size || content.length > MAX_REPOSITORY_FILE_BYTES) {
      throw new Error(`repository file content size does not match: ${path}`);
    }
    return content;
  }

  async function getPullRequestFiles(number, headSha, baseSha) {
    requireExactPositiveInteger(number, 'pull-request number');
    requireExactSha(headSha, 'pull-request file-history SHA');
    requireExactSha(baseSha, 'pull-request file-history base SHA');
    const pullRequest = await getJson(`/pulls/${number}`);
    if (
      pullRequest?.number !== number ||
      pullRequest?.head?.sha !== headSha ||
      pullRequest?.base?.sha !== baseSha ||
      !Number.isSafeInteger(pullRequest?.changed_files)
    ) {
      throw new Error('pull-request file count is invalid');
    }
    if (pullRequest.changed_files < 0 || pullRequest.changed_files > 3000) {
      throw new Error('pull request contains more than 3000 changed files');
    }
    const files = [];
    const fileNames = new Set();
    const finish = async () => {
      const finalPullRequest = await getJson(`/pulls/${number}`);
      if (
        finalPullRequest?.number !== number ||
        finalPullRequest?.head?.sha !== headSha ||
        finalPullRequest?.base?.sha !== baseSha ||
        finalPullRequest?.changed_files !== pullRequest.changed_files
      ) {
        throw new Error('pull-request file history changed during collection');
      }
      return files;
    };
    if (pullRequest.changed_files === 0) return finish();
    for (let page = 1; page <= 30; page += 1) {
      const rows = await getJson(`/pulls/${number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('pull-request file response is invalid');
      for (const row of rows) {
        if (typeof row?.filename !== 'string' || row.filename.length === 0) {
          throw new Error('pull-request file response contains an invalid filename');
        }
        if (fileNames.has(row.filename)) throw new Error('pull-request file response contains a duplicate filename');
        fileNames.add(row.filename);
        files.push(row);
      }
      if (files.length > pullRequest.changed_files) {
        throw new Error('pull-request file response exceeds the authenticated file count');
      }
      if (files.length === pullRequest.changed_files) return finish();
      if (rows.length < 100) throw new Error('pull-request file response ended before the authenticated file count');
    }
    throw new Error('pull-request file response did not satisfy the authenticated file count');
  }

  async function getPullRequestCommits(number) {
    requireExactPositiveInteger(number, 'pull-request number');
    const pullRequest = await getJson(`/pulls/${number}`);
    if (pullRequest?.number !== number || !exactPositiveInteger(pullRequest?.commits)) {
      throw new Error('pull-request commit count is invalid');
    }
    if (pullRequest.commits > 299) throw new Error('pull request contains more than 299 commits');
    const commits = [];
    const commitShas = new Set();
    for (let page = 1; page <= 3; page += 1) {
      const rows = await getJson(`/pulls/${number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('pull-request commit response is invalid');
      for (const row of rows) {
        if (!EXACT_SHA.test(row?.sha || '')) throw new Error('pull-request commit response contains an invalid SHA');
        if (commitShas.has(row.sha)) throw new Error('pull-request commit response contains a duplicate SHA');
        commitShas.add(row.sha);
        commits.push(row);
      }
      if (commits.length > pullRequest.commits) {
        throw new Error('pull-request commit response exceeds the authenticated commit count');
      }
      if (commits.length === pullRequest.commits) return commits;
      if (rows.length < 100)
        throw new Error('pull-request commit response ended before the authenticated commit count');
    }
    throw new Error('pull-request commit response did not satisfy the authenticated commit count');
  }

  function getPullRequest(number) {
    requireExactPositiveInteger(number, 'pull-request number');
    return getJson(`/pulls/${number}`);
  }

  function getCheckRun(id) {
    requireExactPositiveInteger(id, 'check-run ID');
    return getJson(`/check-runs/${id}`);
  }

  function getCheckRuns(headSha) {
    requireExactSha(headSha, 'check-rollup SHA');
    return getPaginatedCollection(`/commits/${headSha}/check-runs?filter=all`, 'check_runs', 'check rollup');
  }

  function getCommitStatuses(headSha) {
    requireExactSha(headSha, 'commit-status SHA');
    return getPaginatedCollection(`/commits/${headSha}/statuses`, undefined, 'commit status rollup');
  }

  function getWorkflowRun(id) {
    requireExactPositiveInteger(id, 'workflow run ID');
    return getJson(`/actions/runs/${id}`);
  }

  function getWorkflowJob(id) {
    requireExactPositiveInteger(id, 'workflow job ID');
    return getJson(`/actions/jobs/${id}`);
  }

  function getWorkflowRuns(headSha) {
    requireExactSha(headSha, 'workflow-history SHA');
    return getPaginatedCollection(`/actions/runs?head_sha=${headSha}`, 'workflow_runs', 'workflow history');
  }

  function getWorkflowJobs(runId) {
    requireExactPositiveInteger(runId, 'workflow run ID');
    return getPaginatedCollection(`/actions/runs/${runId}/jobs?filter=all`, 'jobs', 'workflow job history');
  }

  function getWorkflowArtifacts(runId) {
    requireExactPositiveInteger(runId, 'workflow run ID');
    return getPaginatedCollection(`/actions/runs/${runId}/artifacts`, 'artifacts', 'workflow artifact history');
  }

  function getProtectedMainRef() {
    return getJson('/git/ref/heads/main');
  }

  function compareControllerToMain(controllerSha, mainSha) {
    requireExactSha(controllerSha, 'controller workflow SHA');
    requireExactSha(mainSha, 'protected main SHA');
    return getJson(`/compare/${controllerSha}...${mainSha}`);
  }

  async function getFile(path, ref, allowedPaths) {
    return (await getBoundFile(path, ref, allowedPaths)).toString('utf8');
  }

  async function getFileDigest(path, ref, allowedPaths) {
    const content = await getBoundFile(path, ref, allowedPaths);
    return {
      path,
      ref,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async function downloadArtifact(artifactId) {
    requireExactPositiveInteger(artifactId, 'artifact ID');
    const redirect = await fetchImpl(`${base}/actions/artifacts/${artifactId}/zip`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (redirect.status !== 302 || redirect.redirected) {
      throw new Error(`authenticated artifact redirect failed with HTTP ${redirect.status}`);
    }
    const location = redirect.headers.get('location');
    let downloadUrl;
    try {
      downloadUrl = new URL(location || '');
    } catch {
      throw new Error('authenticated artifact redirect location is invalid');
    }
    if (
      downloadUrl.protocol !== 'https:' ||
      !TRUSTED_ARTIFACT_DOWNLOAD_HOST.test(downloadUrl.hostname) ||
      downloadUrl.port ||
      downloadUrl.username ||
      downloadUrl.password ||
      !downloadUrl.pathname.startsWith('/actions-results/') ||
      !downloadUrl.search ||
      downloadUrl.hash
    ) {
      throw new Error('authenticated artifact redirect location is not allowlisted');
    }
    const response = await fetchImpl(downloadUrl, {
      headers: { Accept: 'application/zip' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`artifact archive download failed with HTTP ${response.status}`);
    const archive = await readBoundedResponseBuffer(response, MAX_ARTIFACT_ARCHIVE_BYTES, 'artifact archive');
    if (archive.length < 1) throw new Error('artifact archive is empty');
    return archive;
  }

  return Object.freeze({
    getPullRequest,
    getPullRequestFiles,
    getPullRequestCommits,
    getCheckRun,
    getCheckRuns,
    getCommitStatuses,
    getWorkflowRun,
    getWorkflowJob,
    getWorkflowRuns,
    getWorkflowJobs,
    getWorkflowArtifacts,
    getProtectedMainRef,
    compareControllerToMain,
    getFile,
    getFileDigest,
    downloadArtifact,
  });
}

export function allowedRuntimeOrigin(environment, value, hosts = TRUSTED_RUNTIME_HOSTS) {
  const expectedHost = hosts?.[environment];
  if (!expectedHost || typeof value !== 'string') return '';
  const authority = value.match(/^https:\/\/([^/?#]+)/)?.[1];
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (
    url.protocol !== 'https:' ||
    authority !== expectedHost ||
    url.hostname !== expectedHost ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return '';
  }
  return url.origin;
}

export async function fetchAllowedRuntimeHealth(environment, apiBaseUrl, fetchImpl = fetch) {
  const origin = allowedRuntimeOrigin(environment, apiBaseUrl);
  if (!origin) throw new Error(`${environment} runtime origin is not allowlisted`);
  const response = await fetchImpl(`${origin}/health`, {
    headers: { Accept: 'application/json', 'User-Agent': 'JueZ-api-trusted-evidence' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${environment} live health returned HTTP ${response.status}`);
  return parseStrictJson(
    await readBoundedResponseText(response, MAX_RUNTIME_HEALTH_BYTES, `${environment} live health`),
    `${environment} live health`,
  );
}

export function verifyArtifactArchiveDigest(archive, authenticatedDigest, recordedDigest, label = 'artifact') {
  if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new Error(`${label} archive bytes are invalid`);
  }
  if (!EXACT_DIGEST.test(authenticatedDigest || '') || !EXACT_DIGEST.test(recordedDigest || '')) {
    throw new Error(`${label} digest is invalid`);
  }
  if (authenticatedDigest !== recordedDigest) {
    throw new Error(`${label} authenticated and recorded digests differ`);
  }
  const computed = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (computed !== authenticatedDigest) throw new Error(`${label} archive digest does not match exact bytes`);
  return computed;
}

export async function readSingleJsonArchive(archive, expectedEntry, { spawn = spawnSync, label = 'artifact' } = {}) {
  if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new Error(`${label} archive bytes are invalid`);
  }
  if (!SAFE_ARCHIVE_ENTRY.test(expectedEntry || '')) throw new Error(`${label} expected entry is invalid`);

  const directory = await mkdtemp(join(tmpdir(), 'trusted-agent-learning-artifact-'));
  const archivePath = join(directory, 'artifact.zip');
  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    const listing = spawn('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: MAX_ARTIFACT_ARCHIVE_BYTES,
    });
    const entries =
      listing.status === 0
        ? String(listing.stdout || '')
            .split(/\r?\n/)
            .filter(Boolean)
        : [];
    if (entries.length !== 1 || entries[0] !== expectedEntry) {
      throw new Error(`${label} archive must contain only ${expectedEntry}`);
    }
    const extracted = spawn('unzip', ['-p', archivePath, expectedEntry], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: MAX_ARTIFACT_ARCHIVE_BYTES,
    });
    if (extracted.status !== 0) throw new Error(`${label} archive could not be read`);
    return parseStrictJson(extracted.stdout, `${label} JSON`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function protectedMainControllerFindings(mainBefore, mainAfter, comparison, options = {}) {
  const findings = [];
  const controllerSha = options.controllerSha;
  const beforeSha = mainBefore?.object?.sha;
  const afterSha = mainAfter?.object?.sha;
  if (!EXACT_SHA.test(controllerSha || '')) findings.push('controller workflow SHA is invalid');
  if (mainBefore?.ref !== 'refs/heads/main' || mainBefore?.object?.type !== 'commit') {
    findings.push('protected main initial ref is invalid');
  }
  if (mainAfter?.ref !== 'refs/heads/main' || mainAfter?.object?.type !== 'commit') {
    findings.push('protected main final ref is invalid');
  }
  if (!EXACT_SHA.test(beforeSha || '')) findings.push('protected main initial SHA is invalid');
  if (afterSha !== beforeSha) findings.push('protected main changed during trusted verification');
  if (comparison?.status !== 'ahead' && comparison?.status !== 'identical') {
    findings.push('controller workflow SHA is not an ancestor of protected main');
  }
  if (comparison?.base_commit?.sha !== controllerSha) {
    findings.push('controller comparison base is not the runtime workflow SHA');
  }
  if (comparison?.merge_base_commit?.sha !== controllerSha) {
    findings.push('controller comparison merge base is not the runtime workflow SHA');
  }
  if (comparison?.head_commit?.sha !== beforeSha) {
    findings.push('controller comparison head is not protected main');
  }
  if (comparison?.behind_by !== 0) findings.push('protected main comparison is behind the controller SHA');
  if (!Number.isSafeInteger(comparison?.ahead_by) || comparison.ahead_by < 0) {
    findings.push('protected main comparison distance is invalid');
  }
  if (
    comparison?.url !==
    `https://api.github.com/repos/${TRUSTED_EVIDENCE_REPOSITORY}/compare/${controllerSha}...${beforeSha}`
  ) {
    findings.push('controller comparison URL does not bind the runtime workflow SHA to protected main');
  }
  return findings;
}
