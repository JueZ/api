#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import {
  classifyRisk,
  loadAutonomousPolicy,
  pathsMatchingPatterns,
  validateAutonomousPolicy,
} from './lib/autonomous-policy.mjs';
import { workflowPolicyFindings } from './lib/workflow-policy.mjs';

export function highRiskPaths(paths, policy = loadAutonomousPolicy()) {
  return pathsMatchingPatterns(paths, policy.profiles.privileged);
}

export function learningControlPlaneFindings(paths) {
  const forbiddenRoots = [
    'docs/agent-knowledge/',
    'docs/agent-beliefs/',
    'scripts/agent-knowledge/',
    'scripts/agent-beliefs/',
    'scripts/agent-beliefs.mjs',
  ];
  return paths
    .filter((path) => forbiddenRoots.some((root) => path === root || path.startsWith(root)))
    .map((path) => `parallel-learning-control-plane:${path}`);
}

const NON_EXECUTABLE_PATH =
  /(?:^|\/)(?:docs?|test|tests|__tests__|fixtures?|evals)(?:\/|$)|(?:^|\/)(?:AGENTS|README)\.md$|\.(?:test|spec)\.[^/]+$|\.(?:md|txt|snap)$/i;
const EXECUTABLE_PATH = /\.(?:[cm]?[jt]sx?|ya?ml|json|sh|ps1|bicep)$/i;
const CHANGE_START = '__POLICY_GUARDRAIL_CHANGE_START__';
const CHANGE_END = '__POLICY_GUARDRAIL_CHANGE_END__';

function normalizeDiffPath(path) {
  if (!path || path === '/dev/null') return null;
  return path
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .replace(/^[ab]\//, '');
}

function appendFragment(fragments, path, line, changed) {
  const key = path ?? '<inline>';
  const marked = changed ? `${CHANGE_START}\n${line}\n${CHANGE_END}` : line;
  fragments.set(key, `${fragments.get(key) ?? ''}\n${marked}`);
}

function diffFragments(diff) {
  const structured = /^diff --git /m.test(diff);
  const added = new Map();
  const removed = new Map();
  let oldPath = null;
  let newPath = null;
  let inHunk = !structured;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      oldPath = normalizeDiffPath(match?.[1]);
      newPath = normalizeDiffPath(match?.[2]);
      inHunk = false;
      continue;
    }
    if (structured && line.startsWith('--- ')) {
      oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (structured && line.startsWith('+++ ')) {
      newPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (structured && line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('+++') || line.startsWith('---')) continue;
    if (structured && line.startsWith(' ')) {
      appendFragment(added, newPath, line.slice(1), false);
      appendFragment(removed, oldPath, line.slice(1), false);
    }
    if (line.startsWith('+')) appendFragment(added, newPath, line.slice(1), true);
    if (line.startsWith('-')) appendFragment(removed, oldPath, line.slice(1), true);
  }

  return { added, removed };
}

export function untrackedFileDiff(path, source) {
  const normalizedPath = normalizeDiffPath(path);
  const lines = source.split('\n');
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function isExecutableBoundary(path, scope) {
  if (!path) return true;
  if (path === 'scripts/policy-guardrails.mjs' || NON_EXECUTABLE_PATH.test(path)) return false;
  if (!(path === 'package.json' || EXECUTABLE_PATH.test(path))) return false;
  if (scope === 'api-auth') return path.startsWith('apps/api/src/');
  if (scope === 'runtime-sha' && path.startsWith('apps/')) return path.includes('/src/');
  if (scope === 'delivery') {
    return (
      path === 'package.json' ||
      path.startsWith('.github/workflows/') ||
      path.startsWith('scripts/') ||
      path.startsWith('ops/release-ledger/')
    );
  }
  return (
    path.startsWith('.github/workflows/') ||
    path.startsWith('apps/') ||
    path.startsWith('infra/') ||
    path.startsWith('scripts/') ||
    path === 'package.json'
  );
}

function withoutComments(source, path) {
  if (/\.[cm]?[jt]sx?$/i.test(path)) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
    const tokens = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
    return tokens.join(' ');
  }
  let result = source.replace(/<#[\s\S]*?#>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (path === '<inline>' || /\.(?:ya?ml|sh|ps1)$/i.test(path)) {
    result = result.replace(/(^|\s)#.*$/gm, '$1');
  }
  if (path === '<inline>') result = result.replace(/(^|\s)\/\/.*$/gm, '$1');
  return result;
}

function executableChangeSource(fragments, scope) {
  return [...fragments.entries()]
    .filter(([path]) => isExecutableBoundary(path === '<inline>' ? null : path, scope))
    .flatMap(([path, source]) => {
      const evidence = withoutComments(source, path);
      return [...evidence.matchAll(new RegExp(`${CHANGE_START}([\\s\\S]*?)${CHANGE_END}`, 'g'))].map(
        (match) => match[1],
      );
    })
    .join('\n');
}

function matchCount(pattern, source) {
  return [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length;
}

export function forbiddenDiffFindings(diff) {
  const scanDiff = diff
    .split('\n')
    .filter((line) => !/^\+\s*(?:\{ id: |(?:added|removed|replacement):\s*\/)/.test(line))
    .join('\n');
  const ciPolicyDisabledPattern = new RegExp(
    '^\\+\\s*(?:dis' +
      'able\\s+(?:ci|policy|security scan|secret scan|dependency audit|cost-policy)\\b|' +
      '(?:if\\s*:\\s*(?:false|\\$\\{\\{\\s*false\\s*\\}\\})|continue-on-error\\s*:\\s*true)\\s*$|' +
      '(?:CI|POLICY|SECURITY_SCAN|SECRET_SCAN|DEPENDENCY_AUDIT|COST_POLICY)[A-Z_]*\\s*[:=]\\s*(?:false|0|off)\\b)',
    'im',
  );
  const rules = [
    {
      id: 'runtime-sha-verification-removed',
      scope: 'runtime-sha',
      signals: [/\bEXPECTED_DEPLOYED_COMMIT_SHA\b/i, /\bdeployedCommitSha\b/i, /\bDEPLOYED_COMMIT_SHA\b/i],
    },
    {
      id: 'telemetry-verification-removed',
      scope: 'delivery',
      signals: [
        /\b(?:node(?:\.exe)?\s+scripts[\\/]check-telemetry\.mjs|npm(?:\.cmd)?\s+run(?:\s+--silent)?\s+ops:check-telemetry)\b/i,
        /\btelemetryCheckResult\b/i,
      ],
    },
    {
      id: 'smoke-coverage-removed',
      scope: 'delivery',
      signals: [
        /\b(?:node(?:\.exe)?\s+scripts[\\/]smoke-runtime\.mjs|npm(?:\.cmd)?\s+run(?:\s+--silent)?\s+ops:smoke(?!:auth))\b/i,
        /\/api\/reddit\/thread/i,
        /\/api\/hello/i,
      ],
    },
    {
      id: 'authenticated-smoke-removed',
      scope: 'delivery',
      signals: [
        /\b(?:node(?:\.exe)?\s+scripts[\\/]smoke-auth\.mjs|npm(?:\.cmd)?\s+run(?:\s+--silent)?\s+ops:smoke:auth)\b/i,
        /\bAUTH_ACCESS_TOKEN\b/i,
      ],
    },
    {
      id: 'release-ledger-removed',
      scope: 'delivery',
      signals: [
        /\b(?:node(?:\.exe)?\s+scripts[\\/]write-release-ledger\.mjs|npm(?:\.cmd)?\s+run(?:\s+--silent)?\s+ops:write-release-ledger)\b/i,
        /\b(?:node(?:\.exe)?\s+scripts[\\/]validate-release-ledger\.mjs|npm(?:\.cmd)?\s+run(?:\s+--silent)?\s+ops:validate-release-ledger)\b/i,
        /\brelease-ledger\b/i,
      ],
    },
    {
      id: 'jwt-validation-removed',
      scope: 'api-auth',
      signals: [/\bjwtVerify\s*\(/i, /\bauthorizeRequest(?:ForOperation)?\s*\(/i, /\bJWT\b/i, /\bjwks\w*\b/i],
    },
    {
      id: 'fail-closed-removed',
      scope: 'runtime',
      signals: [
        /\bfail closed\b/i,
        /(?:^[ \t]*|[;{]\s*)exit\s+1\b/im,
        /\bREQUIRE_TELEMETRY_CHECK\b/i,
        /\bREQUIRE_AUTH_SMOKE\b/i,
      ],
    },
    { id: 'auth-disabled-test-prod', added: /^\+.*AUTH_ENABLED\s*[:=]\s*false/im },
    {
      id: 'oidc-replaced-by-secret',
      added: /^\+(?:\s*(?:client-secret|credentials)\s*:|.*\bAZURE_CLIENT_SECRET\s*=)/im,
    },
    { id: 'broad-write-permissions', added: /^\+\s*permissions:\s*write-all/im },
    {
      id: 'secret-logging-risk',
      added: /^\+.*(printenv|env\s*\||echo \$\{?[^}\s]*(TOKEN|SECRET|PASSWORD|CONNECTION_STRING|SAS))/im,
    },
    { id: 'ci-policy-disabled', added: ciPolicyDisabledPattern },
  ];
  const changes = diffFragments(diff);
  return rules
    .filter((rule) => {
      if (rule.added) return rule.added.test(scanDiff);
      const removedSource = executableChangeSource(changes.removed, rule.scope);
      const addedSource = executableChangeSource(changes.added, rule.scope);
      // This is bounded change-shape evidence. Runtime and contract checks remain the proof of effective protection.
      return rule.signals.some((signal) => matchCount(signal, removedSource) > matchCount(signal, addedSource));
    })
    .map((rule) => rule.id);
}

function git(args, cwd = process.cwd()) {
  const completed = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${completed.stderr}`);
  return completed.stdout;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = resolve(process.env.REPOSITORY_ROOT || process.cwd());
  const policyRoot = resolve(process.env.POLICY_ROOT || repositoryRoot);
  const policy = loadAutonomousPolicy(resolve(policyRoot, '.github/autonomous-policy.yml'));
  const policyErrors = validateAutonomousPolicy(policy);
  if (policyErrors.length > 0) {
    console.error(`Autonomous policy validation failed:\n- ${policyErrors.join('\n- ')}`);
    process.exit(1);
  }
  const baseRef = process.env.BASE_REF || process.argv[2] || 'HEAD~1';
  const includeWorktree = process.env.INCLUDE_WORKTREE === 'true';
  const excludedPrefixes = (process.env.WORKTREE_EXCLUDE_PREFIXES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const isIncluded = (path) => !excludedPrefixes.some((prefix) => path.startsWith(prefix));
  const trackedChanged = git(['diff', '--name-only', baseRef, ...(includeWorktree ? [] : ['HEAD'])], repositoryRoot)
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter(isIncluded);
  const untracked = includeWorktree
    ? git(['ls-files', '--others', '--exclude-standard', '--'], repositoryRoot)
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter(isIncluded)
    : [];
  const changed = [...new Set([...trackedChanged, ...untracked])];
  const risk = classifyRisk(changed, policy);
  console.log(
    JSON.stringify(
      {
        policyVersion: policy.version,
        privileged: risk.privileged,
        privilegedPaths: risk.privilegedPaths,
        profiles: risk.profiles,
      },
      null,
      2,
    ),
  );
  const trackedDiff = git(
    ['diff', '--unified=1000000', baseRef, ...(includeWorktree ? [] : ['HEAD']), '--', '.'],
    repositoryRoot,
  );
  const untrackedDiff = untracked
    .map((path) => untrackedFileDiff(path, readFileSync(resolve(repositoryRoot, path), 'utf8')))
    .join('\n');
  const diff = `${trackedDiff}\n${untrackedDiff}`;
  const findings = [
    ...learningControlPlaneFindings(changed),
    ...forbiddenDiffFindings(diff),
    ...(await workflowPolicyFindings(resolve(repositoryRoot, '.github/workflows'), policy)),
  ];
  if (findings.length > 0) {
    console.error(`Forbidden guardrail changes detected: ${findings.join(', ')}`);
    process.exit(1);
  }
  console.log('Operational guardrail policy passed.');
}
