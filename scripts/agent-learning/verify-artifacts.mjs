import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactStatusCounts, ARTIFACT_STATES, validateArtifactRepository } from './validate-artifacts.mjs';

const HISTORICAL_SCORERS = Object.freeze({
  'historical.workflow-run-identity': Object.freeze({
    artifactId: 'workflow-run-identity',
    paths: Object.freeze(['.github/workflows/codex-main-delivery.yml']),
    evaluate(readAt, brokenCommit, fixedCommit) {
      const broken = readAt(brokenCommit, this.paths[0]);
      const fixed = readAt(fixedCommit, this.paths[0]);
      return invariantFindings([
        [
          broken.includes("github.event.workflow_run.name == 'CI'") &&
            broken.includes("github.event.workflow_run.name == 'Codex Auto-Merge'"),
          'broken workflow must select triggering runs through the mutable workflow name',
        ],
        [
          !fixed.includes("github.event.workflow_run.name == 'CI'") &&
            !fixed.includes("github.event.workflow_run.name == 'Codex Auto-Merge'"),
          'fixed workflow must stop selecting triggering runs through the mutable workflow name',
        ],
        [
          fixed.includes("github.event.workflow_run.path == '.github/workflows/ci.yml'") &&
            fixed.includes("github.event.workflow_run.path == '.github/workflows/codex-automerge.yml'"),
          'fixed workflow must select both triggering workflows through immutable paths',
        ],
      ]);
    },
  }),
  'historical.ci-script-indirection': Object.freeze({
    artifactId: 'ci-script-indirection',
    paths: Object.freeze(['.github/workflows/ci.yml', '.github/autonomous-policy.yml']),
    evaluate(readAt, brokenCommit, fixedCommit) {
      const brokenCi = readAt(brokenCommit, this.paths[0]);
      const fixedCi = readAt(fixedCommit, this.paths[0]);
      const brokenPolicy = readAt(brokenCommit, this.paths[1]);
      const fixedPolicy = readAt(fixedCommit, this.paths[1]);
      return invariantFindings([
        [brokenCi.includes('npm run lint'), 'broken CI must route required lint through a package script'],
        [!fixedCi.includes('npm run lint'), 'fixed CI must not route required lint through a package script'],
        [
          fixedCi.includes('./node_modules/.bin/eslint apps scripts --max-warnings 0'),
          'fixed CI must invoke the trusted lint binary and arguments directly',
        ],
        [
          !brokenPolicy.includes('\n  - package.json\n') && !brokenPolicy.includes('\n  - scripts/**\n'),
          'broken policy must lack unconditional package and script high-risk roots',
        ],
        [
          fixedPolicy.includes('\n  - package.json\n') && fixedPolicy.includes('\n  - scripts/**\n'),
          'fixed policy must classify package and script roots as high risk',
        ],
      ]);
    },
  }),
  'historical.bring-singular-add-item': Object.freeze({
    artifactId: 'bring-singular-add-item',
    paths: Object.freeze(['apps/api/src/application/operations/registry.ts', 'apps/api/src/mcp/tools/bring.ts']),
    evaluate(readAt, brokenCommit, fixedCommit) {
      const brokenRegistry = readAt(brokenCommit, this.paths[0]);
      const fixedRegistry = readAt(fixedCommit, this.paths[0]);
      const brokenTool = readAt(brokenCommit, this.paths[1]);
      const fixedTool = readAt(fixedCommit, this.paths[1]);
      return invariantFindings([
        [
          brokenRegistry.includes("mcp: { toolName: 'bring_add_items' }"),
          'broken registry must expose the batch-named Bring MCP operation',
        ],
        [
          fixedRegistry.includes("mcp: { toolName: 'bring_add_item' }"),
          'fixed registry must expose the singular Bring MCP operation',
        ],
        [brokenTool.includes("'bring_add_items'"), 'broken MCP implementation must register the batch-named tool'],
        [fixedTool.includes("'bring_add_item'"), 'fixed MCP implementation must register the singular tool'],
        [
          fixedTool.includes('item: itemInputSchema') && fixedTool.includes('items: [item]'),
          'fixed MCP implementation must accept one item and adapt it to the existing service command',
        ],
      ]);
    },
  }),
});

function invariantFindings(assertions) {
  return assertions.filter(([passed]) => !passed).map(([, message]) => message);
}

function git(args) {
  const completed = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  return { status: completed.status, stdout: completed.stdout, stderr: completed.stderr };
}

function readGitFile(commit, path) {
  const completed = git(['show', `${commit}:${path}`]);
  if (completed.status !== 0) throw new Error(`could not read ${path} at exact commit ${commit}`);
  return completed.stdout;
}

function commitFindings(artifact) {
  const brokenCommit = artifact.counterfactual.broken.commit;
  const fixedCommit = artifact.counterfactual.fixed.commit;
  const findings = [];
  for (const [label, commit] of [
    ['broken', brokenCommit],
    ['fixed', fixedCommit],
  ]) {
    if (git(['cat-file', '-e', `${commit}^{commit}`]).status !== 0) {
      findings.push(`${label} commit ${commit} is unavailable in the exact repository history`);
    }
  }
  if (findings.length === 0 && git(['merge-base', '--is-ancestor', brokenCommit, fixedCommit]).status !== 0) {
    findings.push('broken commit must be an ancestor of the fixed commit');
  }
  return findings;
}

export function historicalScorerFindings(artifact, readAt = readGitFile) {
  const scorerIds = artifact.counterfactual.verification.trustedScorers ?? [];
  const findings = [];
  if (scorerIds.length === 0) {
    return ['verified historical artifacts require at least one registered trusted scorer'];
  }
  for (const scorerId of scorerIds) {
    const scorer = HISTORICAL_SCORERS[scorerId];
    if (!scorer) {
      findings.push(`trusted scorer ${scorerId} is not registered in the controller checkout`);
      continue;
    }
    if (scorer.artifactId !== artifact.id) {
      findings.push(`trusted scorer ${scorerId} is not registered for artifact ${artifact.id}`);
      continue;
    }
    try {
      findings.push(
        ...scorer
          .evaluate(readAt, artifact.counterfactual.broken.commit, artifact.counterfactual.fixed.commit)
          .map((finding) => `${scorerId}: ${finding}`),
      );
    } catch (error) {
      findings.push(`${scorerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return findings;
}

export function pullRequestProvenanceFindings(artifact, pullRequest) {
  const implementation = artifact.counterfactual.implementationPr;
  const expectedSourceUrl = `https://github.com/${implementation.repository}/pull/${implementation.number}`;
  const sourceHasImplementationPr = artifact.source.references.some(
    (reference) => reference.kind === 'pull_request' && reference.url === expectedSourceUrl,
  );
  return invariantFindings([
    [pullRequest?.number === implementation.number, 'GitHub PR number does not match the artifact'],
    [pullRequest?.state === 'closed' && Boolean(pullRequest?.merged_at), 'GitHub PR is not merged'],
    [
      pullRequest?.base?.sha === artifact.counterfactual.broken.commit,
      'GitHub PR base SHA does not match the broken commit',
    ],
    [
      pullRequest?.merge_commit_sha === artifact.counterfactual.fixed.commit,
      'GitHub PR merge SHA does not match the fixed commit',
    ],
    [sourceHasImplementationPr, 'artifact source references do not include the implementation PR'],
  ]);
}

async function fetchPullRequest(repository, number) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'JueZ-api-agent-learning-validator',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub PR metadata request failed with HTTP ${response.status}`);
  return response.json();
}

export async function verifyArtifactRepository(options = {}) {
  const validation = validateArtifactRepository(options);
  const errors = [...validation.errors];
  if (errors.length > 0) return { ...validation, errors };

  const verifiedArtifacts = validation.artifacts.filter(({ artifact }) => artifact.status === 'verified');
  for (const { fileName, artifact } of verifiedArtifacts) {
    for (const finding of commitFindings(artifact)) errors.push(`${fileName}: ${finding}`);
    for (const finding of historicalScorerFindings(artifact)) errors.push(`${fileName}: ${finding}`);
    if (options.verifyGitHub === true) {
      try {
        const implementation = artifact.counterfactual.implementationPr;
        const pullRequest = await fetchPullRequest(implementation.repository, implementation.number);
        for (const finding of pullRequestProvenanceFindings(artifact, pullRequest)) {
          errors.push(`${fileName}: ${finding}`);
        }
      } catch (error) {
        errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ...validation, errors };
}

async function runCli() {
  const args = process.argv.slice(2);
  const allowedArgs = new Set(['--github', '--status']);
  if (args.some((arg) => !allowedArgs.has(arg))) {
    throw new Error(`Unsupported arguments: ${args.filter((arg) => !allowedArgs.has(arg)).join(' ')}`);
  }
  const result = await verifyArtifactRepository({ verifyGitHub: args.includes('--github') });
  if (result.errors.length > 0) {
    console.error(`Learning artifact proof verification failed:\n- ${result.errors.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  if (args.includes('--status')) {
    const counts = artifactStatusCounts(result.artifacts);
    console.log(`Learning artifacts with valid proof: ${result.artifacts.length}`);
    for (const status of ARTIFACT_STATES) console.log(`${status}: ${counts[status]}`);
    return;
  }
  console.log(
    `Verified counterfactual proof for ${result.artifacts.filter(({ artifact }) => artifact.status === 'verified').length} learning artifacts${args.includes('--github') ? ' with live GitHub provenance' : ''}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
