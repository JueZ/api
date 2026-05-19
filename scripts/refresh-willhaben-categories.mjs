#!/usr/bin/env node
if (process.env.WILLHABEN_CATEGORY_REFRESH_ENABLED !== 'true') {
  console.error('LIVE_ENDPOINT_UNVERIFIED: refresh disabled by configuration');
  process.exit(1);
}
console.error('LIVE_ENDPOINT_UNVERIFIED: live category refresh not implemented; use snapshot provider');
process.exit(1);
