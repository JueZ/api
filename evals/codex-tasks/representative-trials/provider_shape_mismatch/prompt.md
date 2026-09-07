# Normalize the updated stock response

The local stock importer fails on evidence/provider.json. Update normalizeStock in src/provider.mjs to accept both documented shapes:

- Legacy: `{ "items": [{ "id": "item-a", "quantity": 3 }], "nextCursor": null }`.
- Current: `{ "data": { "items": [{ "sku": "item-a", "stock": { "available": "3" } }], "nextCursor": "page-2" } }`.

Return `{ items: [{ id, quantity }], nextCursor }` in input order, preserving the opaque cursor exactly. An absent cursor defaults to null; an explicit cursor must be null or a nonempty string. An empty item array is valid. Accept nonempty string ids, nonnegative safe integer quantities in legacy rows, and canonical decimal integer strings (`0` or digits without a leading zero) in current rows. Reject a missing/malformed item list, mixed envelopes (both top-level items and data), invalid ids/quantities/cursors with TypeError. Do not mutate inputs or infer total provider coverage from a page.

Allowed changes: src/provider.mjs and optional solution.test.mjs. Use only the supplied synthetic contract and local checks; deliver the fix and its evidence limitations.
