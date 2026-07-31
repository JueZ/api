#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadAutonomousPolicy } from './lib/autonomous-policy.mjs';

export function renderBranchProtection(policy = loadAutonomousPolicy()) {
  return {
    required_status_checks: {
      strict: true,
      checks: policy.requiredChecks.map(({ name, appSlug }) => ({
        context: name,
        app_id: policy.trustedCheckApps[appSlug],
      })),
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

export function branchProtectionFindings(actual, policy = loadAutonomousPolicy()) {
  const findings = [];
  const expected = renderBranchProtection(policy);
  const actualStatusChecks = actual?.required_status_checks;
  const actualChecks = actualStatusChecks?.checks;

  if (actualStatusChecks?.strict !== true) findings.push('required status checks must be strict');
  if (!Array.isArray(actualChecks)) {
    findings.push('required status checks must expose app-bound checks');
  } else {
    const expectedChecks = expected.required_status_checks.checks;
    for (const expectedCheck of expectedChecks) {
      const sameContext = actualChecks.filter((check) => check?.context === expectedCheck.context);
      if (sameContext.length === 0) {
        findings.push(`required check is missing: ${expectedCheck.context}`);
      } else if (sameContext.length !== 1 || sameContext[0]?.app_id !== expectedCheck.app_id) {
        findings.push(`required check has the wrong GitHub App binding: ${expectedCheck.context}`);
      }
    }
    for (const actualCheck of actualChecks) {
      if (!expectedChecks.some((expectedCheck) => expectedCheck.context === actualCheck?.context)) {
        findings.push(`unexpected required check: ${String(actualCheck?.context ?? '<invalid>')}`);
      }
    }
    if (actualChecks.length !== expectedChecks.length) {
      findings.push(`required check count must be exactly ${expectedChecks.length}`);
    }
  }

  verifyEnabledSetting(actual?.enforce_admins, true, 'admin enforcement', findings);
  verifyEnabledSetting(actual?.required_linear_history, true, 'linear history', findings);
  verifyEnabledSetting(actual?.allow_force_pushes, false, 'force pushes', findings);
  verifyEnabledSetting(actual?.allow_deletions, false, 'branch deletions', findings);
  verifyEnabledSetting(actual?.block_creations, false, 'branch creation blocking', findings);
  verifyEnabledSetting(actual?.required_conversation_resolution, true, 'conversation resolution', findings);
  verifyEnabledSetting(actual?.lock_branch, false, 'branch locking', findings);
  verifyEnabledSetting(actual?.allow_fork_syncing, false, 'fork syncing', findings);

  const reviews = actual?.required_pull_request_reviews;
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) {
    findings.push('pull request reviews protection must be enabled');
  } else {
    for (const [name, value] of Object.entries(expected.required_pull_request_reviews)) {
      if (reviews[name] !== value) findings.push(`pull request review setting ${name} must be ${String(value)}`);
    }
    const bypassAllowances = reviews.bypass_pull_request_allowances;
    if (bypassAllowances != null) {
      if (
        typeof bypassAllowances !== 'object' ||
        Array.isArray(bypassAllowances) ||
        Object.values(bypassAllowances).some((actors) => !Array.isArray(actors) || actors.length > 0)
      ) {
        findings.push('pull request bypass allowances must be absent or empty');
      }
    }
  }
  if (actual?.restrictions != null) findings.push('push restrictions must match the canonical null policy');

  return findings;
}

function verifyEnabledSetting(actual, expected, name, findings) {
  if (actual?.enabled !== expected) findings.push(`${name} must be ${String(expected)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--verify') {
    let actual;
    try {
      actual = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      console.error('Branch protection verification input must be valid JSON.');
      process.exit(2);
    }
    const findings = branchProtectionFindings(actual);
    if (findings.length > 0) {
      console.error(`Branch protection does not match canonical policy:\n- ${findings.join('\n- ')}`);
      process.exit(1);
    }
    console.log('Branch protection matches the canonical app-bound policy.');
  } else if (process.argv.length > 2) {
    console.error('Usage: render-branch-protection.mjs [--verify]');
    process.exit(2);
  } else {
    process.stdout.write(`${JSON.stringify(renderBranchProtection(), null, 2)}\n`);
  }
}
