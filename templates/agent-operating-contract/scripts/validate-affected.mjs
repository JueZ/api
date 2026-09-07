// Project adapter: --base <exact-sha> --head <exact-sha> [--plan].
console.log(
  JSON.stringify({
    status: 'unconfigured',
    adapter: 'validation',
    reason: 'Bind proportional project checks and evidence collection as described in README.md.',
  }),
);
process.exitCode = 2;
