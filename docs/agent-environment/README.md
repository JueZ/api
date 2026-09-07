# Isolated agent application environment

The active Codex can run the real Functions app, Angular development server, and loopback-only deterministic provider fixture independently in each Git worktree. Ports and `.agent-runtime/<worktree-id>/manifest.json` are derived from the canonical worktree path, collision-probed, credential-free, and ignored.

```bash
npm run agent:env:start
npm run agent:env:status -- --json
npm run agent:env:logs -- --service api --tail 100
npm run agent:verify
npm run agent:env:reset
npm run agent:env:stop
```

Azure Functions Core Tools (`func`) and installed Node dependencies are prerequisites. The launcher passes the explicit `DEPLOYED_ENVIRONMENT_NAME=local` trust marker only to the local Functions process. Startup never deploys or contacts Azure. Provider fixtures listen only on loopback and reject unknown requests. The environment starts no Codex process and does not read Codex authentication.

The same commands support native Windows and Linux with Node.js 22. On Windows, install Functions Core Tools through its MSI or npm and open a new terminal after updating PATH. The launcher invokes Node tools directly, uses Windows process creation identities or Linux `/proc` identities to protect worktree ownership, and stops the owned process tree. Background service logs remain available after the start command exits. Start and status check HTTP readiness, including the API `/health` endpoint.

`npm test` enumerates test files without shell glob expansion. Git Bash is still needed on Windows for tests of the Linux Cloud shell scripts. Release packaging remains a Linux/Bash operation. Codex Cloud setup and conditional cached maintenance are separate from this local runtime; no Windows installer is added to that startup path.

## Affected local validation

After fetching protected `origin/main`, use `npm run validate:affected -- --plan` to inspect the selected checks and any prior evidence, then `npm run validate:affected` to execute them. An explicit `--base <ref>` selects an ancestor commit for a focused comparison. Node.js 22 is required; the command reports missing tools before executing checks and never installs them or refreshes dependencies implicitly.

The runner uses the canonical changed-path classifier and direct check commands, so combined API tests, contract checks, and script checks share one API compilation. Frontend validation uses one production build. It validates changed formatting, applicable policy, tests, infrastructure, and workflows, stopping on the first failed check.

Evidence is written to ignored `.agent-runtime/affected-validation/latest.json`. It records the exact base and HEAD, staged/worktree/untracked input fingerprints, dependency manifests and installed-package metadata, toolchain, selected checks, durations, outputs, and result. Source changes during validation invalidate passing evidence. Installed dependency metadata does not prove every byte of `node_modules`; no record is a trusted remote attestation.

The first version deliberately has no automatic check cache. `--plan` compares prior records and explains changed inputs; an agent can use that evidence to avoid issuing redundant commands. Running the command explicitly executes its selected checks. `PR Gate`, `Security Gate`, and applicable Delivery v2 remain independently required.
