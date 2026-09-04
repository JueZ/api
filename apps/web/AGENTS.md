# Web scope instructions

- The canonical catalogue comes from `contracts/openapi.yaml`; do not add a second generated contract.
- Request the operation-specific OAuth scope from the OpenAPI security declaration.
- Never persist or print bearer/confirmation tokens, provider credentials, or sensitive API responses.
- Preserve the separate prepare/review/apply UI for destructive Bring mutations.
- Keep error rendering limited to sanitized repairable-problem fields.
- For frontend behavior changes, validate with type-check, web build, and relevant web tests. Documentation-only edits follow the protected diff classification.
