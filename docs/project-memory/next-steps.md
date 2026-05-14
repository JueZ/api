# Next steps

Last updated: 2026-05-14

1. Merge the readiness follow-up PR that makes production repository-variable updates best-effort/idempotent after smoke tests.
2. Re-run `Deploy Test` on `main` and confirm it passes.
3. Re-run `Promote Production` on `main` and confirm the whole workflow concludes success, not just deployment/smoke success.
4. Use a delegated Microsoft Entra identity with app-registration read permissions to verify:
   - API app registration exists and exposes the `api.access` scope.
   - SPA app registration exists.
   - SPA redirect URIs include the production Angular URL and `http://localhost:4200`.
   - SPA delegated permission to the API scope is configured.
   - GitHub OIDC federated credentials include `repo:JueZ/api:ref:refs/heads/main`, `repo:JueZ/api:environment:test`, and `repo:JueZ/api:environment:production`.
   - Admin/user consent state is known and documented.
5. Manually verify browser authentication because Codex cannot do interactive login:
   - Open <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
   - Sign in with the allowlisted Microsoft Entra user.
   - Consent if prompted.
   - Call the protected hello/API action.
   - Expect an authenticated response for the allowlisted user.
6. Optionally run a non-destructive rollback drill only when explicitly approved by selecting a known-good commit and running `rollback-production.yml`.
7. After the production workflow concludes green and manual browser auth is verified, begin normal feature development. The first development task should be a small non-Reddit, non-expensive API catalogue slice that exercises the existing auth, contract, tests, and deployment path.
