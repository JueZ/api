#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

export const highRiskPathPatterns = [/^\.github\/workflows\//, /^\.github\/actions\//, /^infra\//, /^AGENTS\.md$/, /^apps\/api\/src\/shared\/security\//, /^apps\/api\/src\/shared\/config\//, /^docs\/security\//, /^scripts\/(smoke-|check-telemetry|runtime-truth|write-release-ledger|validate-release-ledger|triage-repair-issues|policy-guardrails)/, /^ops\/release-ledger\//, /^apps\/api\/src\/shared\/(runtimeProvenance|smokeCorrelation)\.ts$/];

export function highRiskPaths(paths) {
  return paths.filter((path) => highRiskPathPatterns.some((pattern) => pattern.test(path)));
}

export function forbiddenDiffFindings(diff) {
  const scanDiff = diff.split('\n').filter((line) => !/^\+\s*\{ id: /.test(line)).join('\n');
  const rules = [
    { id: 'runtime-sha-verification-removed', removed: /^-.*(EXPECTED_DEPLOYED_COMMIT_SHA|deployedCommitSha|DEPLOYED_COMMIT_SHA)/im, replacement: /^\+.*(EXPECTED_DEPLOYED_COMMIT_SHA|deployedCommitSha|DEPLOYED_COMMIT_SHA)/im },
    { id: 'telemetry-verification-removed', removed: /^-.*(check-telemetry|ops:check-telemetry|telemetryCheckResult)/im, replacement: /^\+.*(check-telemetry|ops:check-telemetry|telemetryCheckResult)/im },
    { id: 'smoke-coverage-removed', removed: /^-.*(ops:smoke|smoke-runtime|\/api\/reddit\/thread|\/api\/hello)/im, replacement: /^\+.*(ops:smoke|smoke-runtime|\/api\/reddit\/thread|\/api\/hello)/im },
    { id: 'authenticated-smoke-removed', removed: /^-.*(ops:smoke:auth|smoke-auth|AUTH_ACCESS_TOKEN)/im, replacement: /^\+.*(ops:smoke:auth|smoke-auth|AUTH_ACCESS_TOKEN)/im },
    { id: 'release-ledger-removed', removed: /^-.*(write-release-ledger|release-ledger|ops:validate-release-ledger)/im, replacement: /^\+.*(write-release-ledger|release-ledger|ops:validate-release-ledger)/im },
    { id: 'jwt-validation-removed', removed: /^-.*(jwtVerify|authorizeRequest|JWT|jwks)/im, replacement: /^\+.*(jwtVerify|authorizeRequest|JWT|jwks)/im },
    { id: 'fail-closed-removed', removed: /^-.*(fail closed|exit 1|REQUIRE_TELEMETRY_CHECK|REQUIRE_AUTH_SMOKE)/im, replacement: /^\+.*(fail closed|exit 1|REQUIRE_TELEMETRY_CHECK|REQUIRE_AUTH_SMOKE)/im },
    { id: 'auth-disabled-test-prod', added: /^\+.*AUTH_ENABLED\s*[:=]\s*false/im },
    { id: 'oidc-replaced-by-secret', added: /^\+.*(AZURE_CLIENT_SECRET|client-secret|credentials:)/im },
    { id: 'broad-write-permissions', added: /^\+\s*permissions:\s*write-all/im },
    { id: 'secret-logging-risk', added: /^\+.*(printenv|env\s*\||echo \$\{?[^}\s]*(TOKEN|SECRET|PASSWORD|CONNECTION_STRING|SAS))/im },
    { id: 'ci-policy-disabled', added: /^[-+].*disable.*(ci|policy|security scan|secret scan|dependency audit|cost-policy)/im },
  ];
  return rules
    .filter((rule) => (rule.added ? rule.added.test(scanDiff) : rule.removed.test(scanDiff) && !rule.replacement.test(scanDiff)))
    .map((rule) => rule.id);
}

function git(args) {
  const completed = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${completed.stderr}`);
  return completed.stdout;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseRef = process.env.BASE_REF || process.argv[2] || 'HEAD~1';
  const changed = git(['diff', '--name-only', baseRef, 'HEAD']).trim().split('\n').filter(Boolean);
  const risky = highRiskPaths(changed);
  console.log('High-risk paths changed:');
  console.log(risky.length ? risky.map((p) => `- ${p}`).join('\n') : '- none');
  const diff = git(['diff', baseRef, 'HEAD', '--', '.']);
  const findings = forbiddenDiffFindings(diff);
  if (findings.length > 0) {
    console.error(`Forbidden guardrail changes detected: ${findings.join(', ')}`);
    process.exit(1);
  }
  console.log('Operational guardrail policy passed.');
}
