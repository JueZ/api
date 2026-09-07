# Sanitized Bring provider fixture

`provider-v2026-07-26.json` is a minimized, immutable observation of the unofficial Bring v2 response shapes used by the application. It contains representative login metadata, an own-list and shared-list catalogue, active and completed items, and one mutation request shape.

All credentials, account identifiers, list identifiers, and item text are synthetic. `provenance.responsesSha256` is the SHA-256 digest of `JSON.stringify(responses)` and detects accidental fixture drift. Update the fixture and digest together only after a deliberate, newly sanitized provider-contract observation.

Tests may serve these responses through a local fake transport to exercise provider parsing, policy normalization, and MCP discovery/calls. The fixture requires no network access and must never be used to authenticate or issue a provider mutation.

This fixture is contract evidence for the captured response shapes, not current live-provider verification. Bring has no supported public API for this integration, so response drift, account behavior, and live mutation outcomes remain unverified by fixture-backed tests.
