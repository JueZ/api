# Historical agent-task evaluations

Each YAML file defines one immutable historical task. Task files contain no shell commands: they select only setup and scorer IDs registered in the trusted controller under `scripts/agent-task-evals/`.

The controller checks out the exact full `baseSha` in a detached temporary worktree. `historical` uses that checkout unchanged; `current-without-skills` overlays reviewed current instructions and guidance; `current-agent-context` additionally overlays repository skills. An overlay is committed as the evaluation baseline, so candidate changes are measured independently of the context bundle.

Validate definitions without invoking an agent:

```bash
npm run eval:agent-tasks:validate
```

Real Codex execution is local, optional, and never a required check. It requires the current Codex CLI, existing ChatGPT authentication, and the explicit `--confirm-paid-agent-eval` flag. Required CI uses only the deterministic fake adapter. Results default to `.agent-eval-results/`, are sanitized, and are never committed automatically.

```bash
npm run eval:agent-tasks -- --task workflow-run-identity --context current-agent-context --confirm-paid-agent-eval
npm run eval:agent-tasks -- --all --context current-agent-context --confirm-paid-agent-eval
npm run eval:agent-tasks:report
```

The candidate process receives no GitHub, Azure, provider, or production credential. Model-generated commands run with `workspace-write`, approval policy `never`, no outbound network, a sterile shell environment, and no writable directory outside the temporary worktree. The controller never pushes, opens a PR, deploys, or mutates production.
