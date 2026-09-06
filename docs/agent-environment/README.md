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

`npm test` enumerates test files without shell glob expansion. Git Bash is still needed on Windows for the tests of the existing Linux Cloud shell scripts. Release packaging remains a Linux/Bash operation. The Codex Cloud setup and maintenance scripts are unchanged; no Windows setup is added to that startup path.
