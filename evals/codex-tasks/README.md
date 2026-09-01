# Codex tasks

Data-only tasks reconstruct real repository requests at each source pull request's exact base commit and include
generalized semantic-falsification cases. Definitions can select only registered setup profiles, deterministic scorers,
bounded paths, timeouts, and hard gates. They are advisory local evaluations, never required CI or delivery agents.

Validate and test without account use:

```bash
npm run eval:codex:validate
npm run eval:codex:test
```

A real run is explicit and sequential:

```bash
npm run eval:codex -- --task bring-singular-add-item --context current-agent-context --confirm-account-usage
```

The adapter reuses the invoking user's Codex CLI login through the CLI itself, never reads or copies authentication files, strips unrelated credentials from the CLI environment, and gives generated shell commands a sterile HOME/TMPDIR with no network. Results are sanitized, mode `0600`, and local-only under `.codex-eval-results/`.
