import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_MEMORY_DIRECTORY = resolve(REPOSITORY_ROOT, 'docs/project-memory');
const FILE_AS_OF_RE = /^<!-- project-memory-asOf: (\d{4}-\d{2}-\d{2}) -->$/;
const STATE_MARKER_RE =
  /^<!-- project-memory-state id="([a-z0-9]+(?:[.-][a-z0-9]+)*)" status="(active|superseded)" asOf="(\d{4}-\d{2}-\d{2})" -->$/;
const SHA_CONTEXT_RE =
  /(?<![-`])\b(?:exact commit|exact head|final head|repair head|implementation commit|main commit|source commit|merge commit|merged as|commit sha|source sha|head sha|commit|sha)\s*(?:[:=]\s*)?`([^`]+)`/gi;
const RUN_REFERENCE_RE =
  /\b(?:workflow|actions|ci|delivery|deployment|controller|review|promotion|deploy test|promote production)\s+run\s+`([^`]+)`/gi;
const STATUS_LANGUAGE_RE =
  /\b(?:accepted|active|blocked|closed|in[_ -]progress|not[_ -]started|open|pending|prepared|resolved|superseded)\b/i;
const ACTIVE_STATUS_FILES = new Set(['current-state.md', 'known-issues.md', 'next-steps.md']);
const LIVE_PR_STATES = new Set(['open', 'pending', 'prepared']);
const LIVE_RUN_STATES = new Set(['in progress', 'open', 'pending', 'queued']);
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_RE = /^[1-9][0-9]*$/;
const PR_RE = /^[1-9][0-9]*$/;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeRepositoryPath(root, path) {
  const normalized = relative(root, path).split(sep).join('/');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Memory path escaped the repository root.');
  }
  return normalized;
}

function finding(path, line, code, message) {
  return { path, line, code, message };
}

function lineDateHeading(line) {
  const heading = line.match(/^#{2,6}\s+(\d{4}-\d{2}-\d{2})(?:\s|$)/);
  return heading?.[1] ?? null;
}

function looksLikeDatedHeading(line) {
  return /^#{2,6}\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s|$)/.test(line);
}

function exactLiveClaims(path, lines) {
  const claims = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const seen = new Set();
    const add = (kind, rawId, rawState) => {
      const state = rawState.toLowerCase().replaceAll('_', ' ');
      const validState = kind === 'pull_request' ? LIVE_PR_STATES.has(state) : LIVE_RUN_STATES.has(state);
      const validId = kind === 'pull_request' ? PR_RE.test(rawId) : RUN_RE.test(rawId);
      const key = `${kind}:${rawId}:${state}`;
      if (validState && validId && !seen.has(key)) {
        claims.push({ kind, id: Number(rawId), declaredState: state, path, line: lineNumber });
        seen.add(key);
      }
    };
    for (const match of line.matchAll(
      /\bPR\s+#([1-9][0-9]*)(?:['’]s)?\s+(?:is|remains|stays|currently|still)\s+(prepared|pending|open)\b/gi,
    )) {
      add('pull_request', match[1], match[2]);
    }
    for (const match of line.matchAll(/\b(prepared|pending|open)\s+PR\s+#([1-9][0-9]*)\b/gi)) {
      add('pull_request', match[2], match[1]);
    }
    for (const match of line.matchAll(
      /\brun\s+`([1-9][0-9]*)`\s+(?:is|remains|stays|currently|still)\s+(in[ _]progress|open|pending|queued)\b/gi,
    )) {
      add('workflow_run', match[1], match[2]);
    }
    for (const match of line.matchAll(
      /\b(in[ _]progress|open|pending|queued)\s+(?:workflow\s+)?run\s+`([1-9][0-9]*)`/gi,
    )) {
      add('workflow_run', match[2], match[1]);
    }
  }
  return claims;
}

export function inspectMemoryText(text, { path = 'docs/project-memory/fixture.md', activeStatusFile = true } = {}) {
  const lines = String(text).split(/\r?\n/);
  const findings = [];
  const stateMarkers = [];
  let fileAsOf = null;
  let sectionAsOf = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const asOfMatch = line.match(FILE_AS_OF_RE);
    if (asOfMatch) {
      if (!validDate(asOfMatch[1]))
        findings.push(finding(path, lineNumber, 'invalid-as-of-date', 'asOf must be a real YYYY-MM-DD date.'));
      else if (fileAsOf)
        findings.push(finding(path, lineNumber, 'duplicate-as-of', 'Only one file-level asOf marker is allowed.'));
      else fileAsOf = asOfMatch[1];
    } else if (line.startsWith('<!-- project-memory-asOf:')) {
      findings.push(finding(path, lineNumber, 'malformed-as-of', 'Malformed project-memory asOf marker.'));
    }

    if (looksLikeDatedHeading(line)) {
      const date = lineDateHeading(line);
      if (!date || !validDate(date)) {
        findings.push(
          finding(
            path,
            lineNumber,
            'malformed-dated-heading',
            'Dated headings must start with a real YYYY-MM-DD date.',
          ),
        );
        sectionAsOf = null;
      } else {
        sectionAsOf = date;
      }
    } else if (/^#{2,6}\s+/.test(line)) {
      sectionAsOf = null;
    }

    const stateMatch = line.match(STATE_MARKER_RE);
    if (stateMatch) {
      if (!validDate(stateMatch[3]))
        findings.push(finding(path, lineNumber, 'invalid-state-date', 'State marker asOf must be a real date.'));
      stateMarkers.push({ id: stateMatch[1], status: stateMatch[2], asOf: stateMatch[3], line: lineNumber });
    } else if (line.startsWith('<!-- project-memory-state')) {
      findings.push(finding(path, lineNumber, 'malformed-state-marker', 'Malformed project-memory state marker.'));
    }

    if (activeStatusFile && STATUS_LANGUAGE_RE.test(line) && !fileAsOf && !sectionAsOf) {
      findings.push(
        finding(
          path,
          lineNumber,
          'status-without-as-of',
          'Active status language requires a dated heading or file-level asOf marker.',
        ),
      );
    }

    if (/\bPR\s+#(?![1-9][0-9]*\b)/i.test(line)) {
      findings.push(
        finding(path, lineNumber, 'invalid-pr-reference', 'PR references must use PR #<positive integer>.'),
      );
    }
    for (const match of line.matchAll(RUN_REFERENCE_RE)) {
      if (!RUN_RE.test(match[1]))
        findings.push(
          finding(
            path,
            lineNumber,
            'invalid-run-reference',
            'Workflow run references must contain a positive integer.',
          ),
        );
    }
    for (const match of line.matchAll(SHA_CONTEXT_RE)) {
      if (!SHA_RE.test(match[1]))
        findings.push(
          finding(
            path,
            lineNumber,
            'invalid-sha-reference',
            'Commit references must be exact 40-character lowercase SHAs.',
          ),
        );
    }
  }

  const byId = new Map();
  for (const marker of stateMarkers) {
    const existing = byId.get(marker.id) ?? [];
    existing.push(marker);
    byId.set(marker.id, existing);
  }
  for (const [id, markers] of byId) {
    const active = markers.filter((marker) => marker.status === 'active');
    const superseded = markers.filter((marker) => marker.status === 'superseded');
    if (active.length > 1)
      findings.push(
        finding(path, active[1].line, 'duplicate-active-state', `State ${id} has multiple active entries.`),
      );
    if (active.length > 0 && superseded.length > 0)
      findings.push(
        finding(path, superseded[0].line, 'contradictory-state', `State ${id} is both active and superseded.`),
      );
  }

  return { findings, claims: exactLiveClaims(path, lines), fileAsOf, stateMarkers };
}

export function inspectMemoryRepository(options = {}) {
  const repositoryRoot = realpathSync(resolve(options.repositoryRoot ?? REPOSITORY_ROOT));
  const memoryDirectory = realpathSync(resolve(options.memoryDirectory ?? join(repositoryRoot, 'docs/project-memory')));
  const findings = [];
  const claims = [];
  const files = [];
  for (const entry of readdirSync(memoryDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = join(memoryDirectory, entry.name);
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
      findings.push(
        finding(
          normalizeRepositoryPath(repositoryRoot, filePath),
          1,
          'unsafe-memory-file',
          'Memory files must be regular, non-symlink Markdown under 2 MiB.',
        ),
      );
      continue;
    }
    const path = normalizeRepositoryPath(repositoryRoot, filePath);
    const inspected = inspectMemoryText(readFileSync(filePath, 'utf8'), {
      path,
      activeStatusFile: ACTIVE_STATUS_FILES.has(entry.name),
    });
    files.push(path);
    findings.push(...inspected.findings);
    claims.push(...inspected.claims);
  }
  return { status: findings.length === 0 ? 'passing' : 'failing', files, findings, claims };
}

export function createGitHubMemoryClient({ repository, token, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || '')))
    throw new Error('A valid owner/repository is required.');
  if (!token) throw new Error('Authenticated GitHub evidence is unavailable.');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'JueZ-api-memory-freshness',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function boundedJson(response) {
    const maximumBytes = 8 * 1024 * 1024;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error('GitHub metadata response exceeded the bounded size limit.');
    }
    if (!response.body) throw new Error('GitHub metadata response body was unavailable.');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('GitHub metadata response exceeded the bounded size limit.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('GitHub metadata response was not valid JSON.');
    }
  }
  async function request(path, options = {}) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers ?? {}) },
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub metadata request failed with HTTP ${response.status}.`);
    if (response.status === 204) return null;
    return boundedJson(response);
  }
  async function listPages(pathForPage) {
    const records = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await request(pathForPage(page));
      if (!Array.isArray(batch)) throw new Error('GitHub list metadata response was malformed.');
      records.push(...batch);
      if (batch.length < 100) return records;
    }
    throw new Error('GitHub list metadata exceeded the bounded 1000-record limit.');
  }
  return {
    repository,
    getPullRequest: (number) => request(`/pulls/${number}`),
    getWorkflowRun: (number) => request(`/actions/runs/${number}`),
    listIssues: ({ state = 'open', labels = [], since } = {}) => {
      const query = new URLSearchParams({ state, per_page: '100' });
      if (labels.length > 0) query.set('labels', labels.join(','));
      if (since) query.set('since', since);
      return listPages((page) => {
        query.set('page', String(page));
        return `/issues?${query}`;
      });
    },
    listComments: (number) => listPages((page) => `/issues/${number}/comments?per_page=100&page=${page}`),
    createIssue: (body) =>
      request('/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

function normalizedObservedPrState(pullRequest) {
  if (pullRequest?.merged_at) return 'merged';
  return pullRequest?.state === 'open' ? 'open' : 'closed';
}

function normalizedObservedRunState(run) {
  if (run?.status !== 'completed') return String(run?.status || 'unknown').replaceAll('_', ' ');
  return String(run?.conclusion || 'completed').replaceAll('_', ' ');
}

export async function checkLiveMemoryClaims(claims, client) {
  const contradictions = [];
  const checked = [];
  try {
    for (const claim of claims) {
      const observedState =
        claim.kind === 'pull_request'
          ? normalizedObservedPrState(await client.getPullRequest(claim.id))
          : normalizedObservedRunState(await client.getWorkflowRun(claim.id));
      const remainsActive =
        claim.kind === 'pull_request'
          ? observedState === 'open'
          : ['in progress', 'pending', 'queued', 'requested', 'waiting'].includes(observedState);
      const record = { ...claim, observedState };
      checked.push(record);
      if (!remainsActive) contradictions.push(record);
    }
  } catch (error) {
    return {
      status: 'blocked',
      checked,
      contradictions,
      blocker: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: contradictions.length === 0 ? 'passing' : 'failing', checked, contradictions, blocker: null };
}

export async function buildMemoryFreshnessReport(options = {}) {
  const offline = inspectMemoryRepository(options);
  let live = { status: 'not_requested', checked: [], contradictions: [], blocker: null };
  if (options.live === true) {
    try {
      const client =
        options.client ??
        createGitHubMemoryClient({
          repository: options.repository ?? 'JueZ/api',
          token: options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
        });
      live = await checkLiveMemoryClaims(offline.claims, client);
    } catch (error) {
      live = {
        status: 'blocked',
        checked: [],
        contradictions: [],
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const status =
    offline.status === 'failing' || live.status === 'failing'
      ? 'failing'
      : live.status === 'blocked'
        ? 'blocked'
        : 'passing';
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    repository: options.repository ?? 'JueZ/api',
    status,
    offline,
    live,
    rewroteMemory: false,
  };
}

export function memoryFreshnessMarkdown(report) {
  const lines = [
    '# Project-memory freshness',
    '',
    `Status: **${report.status}**`,
    '',
    `Offline findings: ${report.offline.findings.length}`,
    `Live claims checked: ${report.live.checked.length}`,
    `Live contradictions: ${report.live.contradictions.length}`,
    `Live evidence: ${report.live.status}`,
  ];
  if (report.live.blocker) lines.push('', `Blocked: ${report.live.blocker}`);
  if (report.offline.findings.length > 0) {
    lines.push('', '## Offline findings', '');
    for (const item of report.offline.findings)
      lines.push(`- ${item.path}:${item.line} [${item.code}] ${item.message}`);
  }
  if (report.live.contradictions.length > 0) {
    lines.push('', '## Live contradictions', '');
    for (const item of report.live.contradictions)
      lines.push(
        `- ${item.path}:${item.line} ${item.kind} ${item.id}: declared ${item.declaredState}, observed ${item.observedState}`,
      );
  }
  lines.push('', 'This check is read-only and never rewrites project memory.', '');
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { live: false, repository: 'JueZ/api' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live') options.live = true;
    else if (['--repository', '--json', '--markdown'].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

function writeOutput(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, { encoding: 'utf8', mode: 0o600 });
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildMemoryFreshnessReport(options);
  if (options.json) writeOutput(options.json, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdown) writeOutput(options.markdown, memoryFreshnessMarkdown(report));
  console.log(
    `Project-memory freshness: ${report.status}; offline findings=${report.offline.findings.length}; live contradictions=${report.live.contradictions.length}; live evidence=${report.live.status}.`,
  );
  if (report.status !== 'passing') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
