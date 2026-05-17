#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

export function parseRepairIssueBody(body = '') {
  const prNumbers = [...body.matchAll(/(?:PR|pull request|pull\/)(?:\s*#|\/)?(\d+)/gi)].map((m) => Number(m[1]));
  const workflowRunUrls = [...body.matchAll(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/actions\/runs\/(\d+)/g)].map((m) => m[0]);
  const workflowRunIds = workflowRunUrls.map((url) => url.match(/runs\/(\d+)/)?.[1]).filter(Boolean);
  return { prNumbers: [...new Set(prNumbers)], workflowRunUrls: [...new Set(workflowRunUrls)], workflowRunIds: [...new Set(workflowRunIds)] };
}

export function decideRepairIssueAction(issue, prStates = []) {
  if (prStates.some((pr) => pr.merged === true)) return { action: 'close', reason: 'referenced PR has merged' };
  if (prStates.some((pr) => pr.state === 'OPEN')) return { action: 'comment', reason: 'referenced PR remains open' };
  return { action: 'comment', reason: 'no merged referenced PR found' };
}

function gh(args) {
  const completed = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`gh ${args.join(' ')} failed`);
  return completed.stdout;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.env.GITHUB_REPOSITORY || 'JueZ/api';
  const dryRun = process.env.DRY_RUN !== 'false';
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', 'codex-repair', '--state', 'open', '--json', 'number,title,body,url']));
  const marker = '<!-- codex-repair-triage -->';
  for (const issue of issues) {
    const parsed = parseRepairIssueBody(issue.body || '');
    const prStates = [];
    for (const number of parsed.prNumbers) {
      try { prStates.push(JSON.parse(gh(['pr', 'view', String(number), '--repo', repo, '--json', 'number,state,merged,url']))); } catch { /* keep triage best-effort */ }
    }
    const decision = decideRepairIssueAction(issue, prStates);
    const body = `${marker}\nCodex repair triage: ${decision.reason}. Checked ${new Date().toISOString()}.`;
    console.log(`${dryRun ? '[dry-run] ' : ''}#${issue.number}: ${decision.action} (${decision.reason})`);
    if (!dryRun) {
      const comments = JSON.parse(gh(['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments'])).comments || [];
      const alreadyCommented = comments.some((comment) => String(comment.body || '').includes(marker) && String(comment.body || '').includes(decision.reason));
      if (!alreadyCommented) gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', body]);
      if (decision.action === 'close') gh(['issue', 'close', String(issue.number), '--repo', repo, '--comment', 'Closing as obsolete/resolved by merged repair PR.']);
    }
  }
}
