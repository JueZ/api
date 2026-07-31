# Security policy

## Supported version

Only the current `main` branch is supported. Historical deployments should be replaced or rolled back through the repository workflows.

## Reporting

Do not open a public issue containing a vulnerability, credential, token, private provider response, personal list/item data, raw telemetry, or exploit details. Use a private GitHub security advisory for `JueZ/api` or contact the repository owner through an established private channel.

Include the affected commit/route, sanitized reproduction steps, impact, and whether provider or production data may be involved. Never include bearer tokens, passwords, SAS URLs, connection strings, private keys, complete app settings, or raw sensitive logs.

## Response expectations

Security reports are triaged against the fail-closed controls in `AGENTS.md` and `docs/security/`. Authentication bypass, authorization errors, secret exposure, destructive Bring replay, workflow trust-boundary breaks, artifact substitution, and Azure privilege escalation are high priority.

Production remediation must use a non-`main` branch, required CI/policy/security checks, exact-head review, staged deployment, smoke/runtime truth, and the documented rollback path. Controls must not be disabled to accelerate a fix.
