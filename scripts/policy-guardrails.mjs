#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  classifyRisk,
  loadAutonomousPolicy,
  pathsMatchingPatterns,
  validateAutonomousPolicy,
} from './lib/autonomous-policy.mjs';

export function highRiskPaths(paths, policy = loadAutonomousPolicy()) {
  return pathsMatchingPatterns(paths, policy.highRiskPaths);
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
      removed: /^-.*(EXPECTED_DEPLOYED_COMMIT_SHA|deployedCommitSha|DEPLOYED_COMMIT_SHA)/im,
      replacement: /^\+.*(EXPECTED_DEPLOYED_COMMIT_SHA|deployedCommitSha|DEPLOYED_COMMIT_SHA)/im,
    },
    {
      id: 'telemetry-verification-removed',
      removed: /^-.*(check-telemetry|ops:check-telemetry|telemetryCheckResult)/im,
      replacement: /^\+.*(check-telemetry|ops:check-telemetry|telemetryCheckResult)/im,
    },
    {
      id: 'smoke-coverage-removed',
      removed: /^-.*(ops:smoke|smoke-runtime|\/api\/reddit\/thread|\/api\/hello)/im,
      replacement: /^\+.*(ops:smoke|smoke-runtime|\/api\/reddit\/thread|\/api\/hello)/im,
    },
    {
      id: 'authenticated-smoke-removed',
      removed: /^-.*(ops:smoke:auth|smoke-auth|AUTH_ACCESS_TOKEN)/im,
      replacement: /^\+.*(ops:smoke:auth|smoke-auth|AUTH_ACCESS_TOKEN)/im,
    },
    {
      id: 'release-ledger-removed',
      removed: /^-.*(write-release-ledger|release-ledger|ops:validate-release-ledger)/im,
      replacement: /^\+.*(write-release-ledger|release-ledger|ops:validate-release-ledger)/im,
    },
    {
      id: 'jwt-validation-removed',
      removed: /^-.*(jwtVerify|authorizeRequest|JWT|jwks)/im,
      replacement: /^\+.*(jwtVerify|authorizeRequest|JWT|jwks)/im,
    },
    {
      id: 'fail-closed-removed',
      removed: /^-.*(fail closed|exit 1|REQUIRE_TELEMETRY_CHECK|REQUIRE_AUTH_SMOKE)/im,
      replacement: /^\+.*(fail closed|exit 1|REQUIRE_TELEMETRY_CHECK|REQUIRE_AUTH_SMOKE)/im,
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
  return rules
    .filter((rule) =>
      rule.added ? rule.added.test(scanDiff) : rule.removed.test(scanDiff) && !rule.replacement.test(scanDiff),
    )
    .map((rule) => rule.id);
}

function git(args) {
  const completed = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${completed.stderr}`);
  return completed.stdout;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const policy = loadAutonomousPolicy();
  const policyErrors = validateAutonomousPolicy(policy);
  if (policyErrors.length > 0) {
    console.error(`Autonomous policy validation failed:\n- ${policyErrors.join('\n- ')}`);
    process.exit(1);
  }
  const requestedScope = process.env.POLICY_DIFF_SCOPE || '';
  const baseRef =
    process.env.BASE_REF ||
    process.argv[2] ||
    (requestedScope === 'branch' ? git(['merge-base', 'HEAD', 'origin/main']).trim() : 'HEAD~1');
  const includeWorktree = process.env.INCLUDE_WORKTREE === 'true';
  const excludedPrefixes = (process.env.WORKTREE_EXCLUDE_PREFIXES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const isIncluded = (path) => !excludedPrefixes.some((prefix) => path.startsWith(prefix));
  const trackedChanged = git(['diff', '--name-only', baseRef, ...(includeWorktree ? [] : ['HEAD'])])
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter(isIncluded);
  const untracked = includeWorktree
    ? git(['ls-files', '--others', '--exclude-standard', '--']).trim().split('\n').filter(Boolean).filter(isIncluded)
    : [];
  const changed = [...new Set([...trackedChanged, ...untracked])];
  const risk = classifyRisk(changed, policy);
  console.log(
    JSON.stringify(
      {
        policyVersion: policy.version,
        highRisk: risk.highRisk,
        highRiskPaths: risk.highRiskPaths,
        riskClasses: risk.classes,
      },
      null,
      2,
    ),
  );
  const trackedDiff = git(['diff', baseRef, ...(includeWorktree ? [] : ['HEAD']), '--', '.']);
  const untrackedDiff = untracked
    .map((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n'),
    )
    .join('\n');
  const diff = `${trackedDiff}\n${untrackedDiff}`;
  const findings = forbiddenDiffFindings(diff);
  if (findings.length > 0) {
    console.error(`Forbidden guardrail changes detected: ${findings.join(', ')}`);
    process.exit(1);
  }
  console.log('Operational guardrail policy passed.');
}
