const command = process.argv[2] ?? 'run';

console.error(
  `Agent task evaluation command "${command}" is unavailable until Phase 4 implements and validates the detached-worktree harness. This is blocked, not passing.`,
);
process.exitCode = 2;
