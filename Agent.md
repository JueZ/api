# Engineering behavior

## Scope and priorities

- Implement the requested change with the smallest coherent patch.
- Prioritize the explicit task and its acceptance criteria over broader improvements.
- Preserve existing behavior, APIs, architecture, and project conventions unless changing them is necessary for the task.
- Do not refactor unrelated code.
- Do not introduce new abstractions, architectural layers, dependencies, configuration, compatibility code, or speculative future-proofing unless required.
- Prefer using existing patterns and modifying existing code over creating new infrastructure.
- Investigate broadly when necessary to understand a problem, but keep implementation changes narrowly scoped.
- If you discover unrelated bugs, cleanup opportunities, or architectural improvements, mention them in the final response instead of implementing them.
- Do not expand the scope materially without asking first.

## Requests and autonomy

- For requests to explain, review, diagnose, investigate, or plan: inspect the relevant code and report findings. Do not modify code unless explicitly asked.
- For requests to fix, change, implement, or build: make the requested in-scope changes and run relevant non-destructive validation without asking first.
- Ask before destructive actions, external writes, or material scope expansion.

## Validation

- Add or update tests when they are useful to verify the requested behavior or prevent a regression.
- Run the smallest relevant test, lint, build, or type-check commands needed to validate the change.
- Do not broaden the test suite or make unrelated test changes without a reason.
- Review the final diff for unintended changes.

## Completion

The task is done when:

- the requested behavior is implemented,
- the relevant acceptance criteria are satisfied,
- relevant validation passes, and
- no unnecessary changes have been introduced.

Once these conditions are satisfied, stop.
