# Respect the total retry budget

Fix shouldRetry in src/retry.mjs. `attempt` is the positive integer count of requests already made, including the failure just received. `maxAttempts` is the positive integer total request limit. Retry a 429 or 500–599 response only while another request fits within that total. Other statuses never retry. Preserve the public function signature and return a boolean.

Allowed changes: src/retry.mjs and optional solution.test.mjs. Deliver the local repair and validation of the exhausted-budget boundary as well as an eligible retry.
