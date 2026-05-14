# Next steps

1. Implement real OAuth/OIDC/JWT authentication.
2. Add backend JWT validation with issuer, audience, scope, and user allowlist checks.
3. Add Angular login UI and token acquisition.
4. Update the OpenAPI security scheme.
5. Add tests for 401, 403, and allowed-user behavior.
6. Deploy auth configuration safely.
7. Harden run-from-package deployment away from expiring SAS if feasible.
8. Add the first real API connector after auth works.
9. After staged deployment merges, run or inspect `Deploy Test` on `main`, confirm the test base URL and smoke tests, then inspect automatic `Promote Production`.
10. Decide whether the GitHub `production` environment should require reviewers; for a solo project, avoid prevent self-review unless another reviewer exists.
