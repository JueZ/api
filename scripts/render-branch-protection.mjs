#!/usr/bin/env node
import { loadAutonomousPolicy } from './lib/autonomous-policy.mjs';

export function renderBranchProtection(policy = loadAutonomousPolicy()) {
  return {
    required_status_checks: {
      strict: true,
      contexts: policy.requiredChecks.map(({ name }) => name),
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
    allow_fork_syncing: true,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(renderBranchProtection(), null, 2)}\n`);
}
