// Read-only project adapter: --sha <exact-sha>.
console.log(
  JSON.stringify({
    status: 'unconfigured',
    adapter: 'delivery',
    reason: 'Bind the protected delivery and accepted-release evidence source as described in README.md.',
  }),
);
process.exitCode = 2;
