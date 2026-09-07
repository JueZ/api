# Filter a public catalogue by tag

Implement an optional `tag` filter in `listItems(items, { tag } = {})` in src/catalog.mjs. Keep the existing exclusion of archived items. Match a whole tag case-insensitively after trimming the query; an absent or blank query returns all visible items. Missing item tags behave as an empty array. Preserve input order and never mutate the input array, items, or tag arrays. Inputs are item objects with an id, optional boolean archived, and optional string-array tags; tag queries are strings.

Allowed changes: src/catalog.mjs and optional solution.test.mjs. Deliver the local implementation and concise validation evidence.
